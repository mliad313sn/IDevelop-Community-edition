'use strict';
/**
 * SA-38 — scheduled reports go to ACCOUNTS only, on the REAL test database.
 * Every scenario runs inside ONE transaction that is always rolled back, with
 * three people of its own: LEAD supervises MID, MID supervises LEAF. LEAD's
 * scope therefore covers MID's, never the reverse.
 *
 *   - POST with a typed address ⇒ 400, nothing written; naming an account whose
 *     clearance does not cover the creator's ⇒ 400; covering accounts ⇒ 201;
 *   - a run keeps ONE in-app copy, tells each account in the app and by a mail
 *     WITHOUT attachment that only links to the copy;
 *   - the download re-checks access (403 for a non-recipient and for a listed
 *     recipient whose scope does not cover the copy, 200 otherwise);
 *   - the retention pass and an erasure empty the copy (410 afterwards);
 *   - migration 172 on legacy rows: an unmatched address suspends the schedule
 *     and tells its owner once; a matching address is mapped; nothing deleted.
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const HAS_DB = require('../helpers/testDatabase').isTestDatabaseUrl(process.env.DATABASE_URL || '');
const suite = HAS_DB ? describe : describe.skip;

const mockSend = jest.fn(async () => ({ sent: true, messageId: 'm1' }));
jest.mock('../../src/services/EmailService', () => ({
    send: (...a) => mockSend(...a),
    isEnabled: async () => true,
    isCategoryEnabled: async () => true,
}));
jest.mock('../../src/services/LogService', () => ({ log: jest.fn(async () => {}) }));

const db = HAS_DB ? require('../../src/config/database') : null;
const MIG_172 = fs.readFileSync(
    path.join(__dirname, '..', '..', 'db', 'postgres', '172_report_schedule_recipients.sql'),
    'utf8'
);

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});
beforeEach(() => {
    mockSend.mockClear();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

async function inRolledBackTx(fn) {
    let result = null;
    await db
        .runTransaction(async () => {
            // No quiet window in the way of the immediate mail assertions.
            await db.run(
                'UPDATE notification_preferences SET quiet_hours_start = NULL, quiet_hours_end = NULL'
            );
            result = await fn();
            throw new Error('__ROLLBACK__');
        })
        .catch((e) => {
            if (!/__ROLLBACK__/.test(e.message)) throw e;
        });
    return result;
}

/** LEAD → MID → LEAF, plus a public template on the employees source. */
async function fixture() {
    const tpl = await db.get(
        `SELECT site_id, department_id, service_id, role_id FROM employees
          WHERE is_active = true ORDER BY id LIMIT 1`
    );
    const stamp = Date.now();
    const mk = async (tag, supervisorId, email) =>
        Number(
            (
                await db.get(
                    `INSERT INTO employees (employee_number, first_name, last_name, email, site_id,
                                            department_id, service_id, role_id, supervisor_id, is_active)
                     VALUES (?, ?, 'Sample', ?, ?, ?, ?, ?, ?, true) RETURNING id`,
                    [
                        `RSA-${tag}-${stamp}`,
                        tag,
                        email,
                        tpl.siteId,
                        tpl.departmentId,
                        tpl.serviceId,
                        tpl.roleId,
                        supervisorId,
                    ]
                )
            ).id
        );
    const lead = await mk('Lead', null, `lead.${stamp}@example.test`);
    const mid = await mk('Mid', lead, null);
    const leaf = await mk('Leaf', mid, null);
    const t = await db.get(
        `INSERT INTO report_templates (name, report_type, data_source, selected_fields, created_by, is_public, creator_type)
         VALUES ('Schedule test report', 'employees', 'employees', '["employeeNumber"]'::jsonb, 1, true, 'admin')
         RETURNING id`
    );
    return {
        tpl: Number(t.id),
        LEAD: { id: lead, userType: 'manager' },
        MID: { id: mid, userType: 'manager' },
        leaf,
    };
}

function mkReq(user, body = {}, params = {}) {
    return {
        user,
        body,
        params,
        headers: { accept: 'application/json' },
        xhr: true,
        t: (k) => k,
        flash: jest.fn(),
        ip: '127.0.0.1',
        get: () => 'jest',
    };
}
function mkRes() {
    return {
        statusCode: 200,
        headers: {},
        status(c) {
            this.statusCode = c;
            return this;
        },
        type() {
            return this;
        },
        json(b) {
            this.body = b;
            return this;
        },
        send(b) {
            this.body = b;
            return this;
        },
        setHeader(k, v) {
            this.headers[k] = v;
        },
        redirect(u) {
            this.redirected = u;
            return this;
        },
        render(v, l) {
            this.view = v;
            this.locals = l;
            return this;
        },
    };
}

suite('SA-38 — scheduled reports go to accounts, never to typed addresses', () => {
    jest.setTimeout(60000);
    const Ctrl = HAS_DB ? require('../../src/controllers/ReportController') : null;
    const scheduler = HAS_DB ? require('../../src/jobs/report-scheduler') : null;

    test('POST: typed address ⇒ 400; under-cleared account ⇒ 400; covering accounts ⇒ 201', async () => {
        const r = await inRolledBackTx(async () => {
            const f = await fixture();
            const count = async () =>
                Number((await db.get('SELECT count(*) AS n FROM report_schedules')).n);
            const before = await count();
            const out = {};
            const post = async (body) => {
                const res = mkRes();
                await Ctrl.createSchedule(
                    mkReq(f.LEAD, { templateId: String(f.tpl), ...body }),
                    res
                );
                return res;
            };
            let res = await post({ recipients: 'someone@outside.example' });
            out.outside = { status: res.statusCode, code: res.body && res.body.code };
            res = await post({ recipientAccounts: 'someone@outside.example' });
            out.outsideInAccounts = { status: res.statusCode, code: res.body && res.body.code };
            res = await post({ recipientAccounts: [`employee:${f.MID.id}`] });
            out.underCleared = {
                status: res.statusCode,
                code: res.body && res.body.code,
                refused: res.body && res.body.refused,
            };
            res = await post({ recipientAccounts: ['admin:999999'] });
            out.unknown = { status: res.statusCode, code: res.body && res.body.code };
            out.afterRefusals = await count();
            res = await post({ recipientAccounts: ['admin:1', `employee:${f.LEAD.id}`] });
            out.ok = { status: res.statusCode, id: res.body && res.body.id };
            out.recipients = await db.all(
                `SELECT recipient_type AS t, recipient_id AS id FROM report_schedule_recipients
                  WHERE schedule_id = ? ORDER BY recipient_type`,
                [out.ok.id]
            );
            out.legacyText = (
                await db.get('SELECT recipients FROM report_schedules WHERE id = ?', [out.ok.id])
            ).recipients;
            // The eligible list offered to LEAD holds LEAD, never MID.
            const offered = await scheduler.eligibleAccounts(f.LEAD);
            out.offersLead = offered.some((a) => a.token === `employee:${f.LEAD.id}`);
            out.offersMid = offered.some((a) => a.token === `employee:${f.MID.id}`);
            return { ...out, before, f };
        });
        expect(r.outside).toEqual({ status: 400, code: 'outside_address' });
        expect(r.outsideInAccounts).toEqual({ status: 400, code: 'outside_address' });
        expect(r.underCleared).toEqual({
            status: 400,
            code: 'under_cleared',
            refused: [`employee:${r.f.MID.id}`],
        });
        expect(r.unknown).toEqual({ status: 400, code: 'under_cleared' });
        expect(r.afterRefusals).toBe(r.before);
        expect(r.ok.status).toBe(201);
        expect(r.recipients.map((x) => `${x.t}:${x.id}`)).toEqual([
            'admin:1',
            `employee:${r.f.LEAD.id}`,
        ]);
        expect(r.legacyText).toBe('');
        expect(r.offersLead).toBe(true);
        expect(r.offersMid).toBe(false);
    });

    test('a run keeps one in-app copy, mails a link and no attachment; download re-checks access; retention and erasure empty it', async () => {
        const r = await inRolledBackTx(async () => {
            const f = await fixture();
            const res = mkRes();
            await Ctrl.createSchedule(
                mkReq(f.LEAD, {
                    templateId: String(f.tpl),
                    recipientAccounts: ['admin:1', `employee:${f.LEAD.id}`],
                }),
                res
            );
            const sid = res.body.id;
            const status = await scheduler.runOne(await scheduler.loadSchedule(sid));
            const run = await db.get(
                `SELECT id, row_count AS "rowCount", content, scope_ids AS "scopeIds"
                   FROM report_schedule_runs WHERE schedule_id = ?`,
                [sid]
            );
            const inapp = await db.all(
                `SELECT id AS row_id, user_type AS t, user_id AS id, payload FROM notifications
                  WHERE kind = 'report.schedule_ready' AND channel = 'inapp'
                    AND (payload->>'scheduleId')::int = ?
                  ORDER BY user_type`,
                [sid]
            );
            const dl = async (user) => {
                const rr = mkRes();
                await Ctrl.downloadScheduleRun(mkReq(user, {}, { runId: String(run.id) }), rr);
                return rr;
            };
            const outsider = await dl(f.MID); // not listed
            const listed = await dl(f.LEAD); // listed, scope covers
            const superadmin = await dl({ id: 1, userType: 'admin', role: 'superadmin' });
            // A listed recipient whose scope does NOT cover the copy (as a scope
            // change after the schedule was written would leave it).
            await db.run(
                `INSERT INTO report_schedule_recipients (schedule_id, recipient_type, recipient_id)
                 VALUES (?, 'employee', ?)`,
                [sid, f.MID.id]
            );
            const listedUnderCleared = await dl(f.MID);
            // ...and the next run skips that recipient and says so.
            await db.run('UPDATE report_schedules SET last_run_at = NULL WHERE id = ?', [sid]);
            const status2 = await scheduler.runOne(await scheduler.loadSchedule(sid));

            // Retention: a copy older than the window is emptied, the row kept.
            const purge = require('../../src/jobs/retention-purge');
            await db.run(
                "UPDATE report_schedule_runs SET created_at = now() - interval '400 days' WHERE id = ?",
                [run.id]
            );
            const purged = await purge.purgeReportRuns(
                require('../../src/models/AppSettingsModel')
            );
            const afterPurge = await db.get(
                `SELECT content, purged_at AS "purgedAt", purge_reason AS "reason"
                   FROM report_schedule_runs WHERE id = ?`,
                [run.id]
            );
            const expired = await dl(f.LEAD);

            // Erasure: the other copy (second run) covers LEAF and is emptied.
            const second = await db.get(
                'SELECT id FROM report_schedule_runs WHERE schedule_id = ? AND id <> ?',
                [sid, run.id]
            );
            await require('../../src/services/DSRService').erase(f.leaf, null, {
                reason: 'schedule copy test',
            });
            const afterErase = await db.get(
                `SELECT content, purge_reason AS "reason" FROM report_schedule_runs WHERE id = ?`,
                [second.id]
            );
            return {
                f,
                status,
                status2,
                run,
                inapp,
                outsider,
                listed,
                superadmin,
                listedUnderCleared,
                purged,
                afterPurge,
                expired,
                afterErase,
            };
        });
        expect(r.status).toBe('ok');
        expect(r.run.rowCount).toBe(2); // MID and LEAF
        expect(r.run.content.charCodeAt(0)).toBe(0xfeff);
        expect([...r.run.scopeIds].sort()).toEqual([r.f.MID.id, r.f.leaf].sort());
        // Both accounts are told in the app, with the link to the copy.
        expect(r.inapp.map((x) => `${x.t}:${x.id}`)).toEqual([
            'admin:1',
            `employee:${r.f.LEAD.id}`,
        ]);
        for (const x of r.inapp) expect(x.payload.link).toBe(`/reports/schedules/runs/${r.run.id}`);
        // Mails of the first run: a link, never the report.
        const first = mockSend.mock.calls.slice(0, 2).map((c) => c[0]);
        expect(first).toHaveLength(2);
        const to = first.map((m) => m.to).sort();
        expect(to[0]).toBe('admin@example.com');
        expect(to[1]).toMatch(/^lead\.\d+@example\.test$/);
        for (const m of first) {
            expect(m.attachments).toBeUndefined();
            // The button reaches the copy: directly, or through the in-app
            // row's « go » (migration 183 measures that it was opened), whose
            // link is the copy's.
            const go = /\/notifications\/(\d+)\/go/.exec(m.html);
            if (go) {
                const row = r.inapp.find((x) => Number(x.rowId) === Number(go[1]));
                expect(row && row.payload.link).toBe(`/reports/schedules/runs/${r.run.id}`);
            } else expect(m.html).toContain(`/reports/schedules/runs/${r.run.id}`);
            expect(`${m.subject}\n${m.html}\n${m.text}`).not.toMatch(/RSA-|employeeNumber/);
        }
        // Download re-checks access.
        expect(r.outsider.statusCode).toBe(403);
        expect(r.listed.statusCode).toBe(200);
        expect(r.listed.headers['Cache-Control']).toBe('no-store');
        expect(String(r.listed.body).charCodeAt(0)).toBe(0xfeff);
        expect(r.superadmin.statusCode).toBe(200);
        expect(r.listedUnderCleared.statusCode).toBe(403);
        expect(r.status2).toMatch(/^partial: 1 recipient/);
        // Retention and erasure.
        expect(r.purged.days).toBe(90);
        expect(r.purged.purged).toBeGreaterThanOrEqual(1);
        expect(r.afterPurge).toMatchObject({ content: null, reason: 'retention' });
        expect(r.afterPurge.purgedAt).toBeTruthy();
        expect(r.expired.statusCode).toBe(410);
        expect(r.afterErase).toEqual({ content: null, reason: 'erasure' });
    });

    test('migration 172 on legacy rows: unmatched address suspended + owner told once; matching address mapped; nothing deleted', async () => {
        const r = await inRolledBackTx(async () => {
            const f = await fixture();
            const legacy = await db.get(
                `INSERT INTO report_schedules (template_id, recipients, created_by, creator_role, creator_type)
                 VALUES (?, 'someone@outside.example, ADMIN@example.com', 1, 'superadmin', 'admin') RETURNING id`,
                [f.tpl]
            );
            const mapped = await db.get(
                `INSERT INTO report_schedules (template_id, recipients, created_by, creator_role, creator_type)
                 VALUES (?, ' ADMIN@example.com ', 1, 'superadmin', 'admin') RETURNING id`,
                [f.tpl]
            );
            const count0 = Number((await db.get('SELECT count(*) AS n FROM report_schedules')).n);
            await db._client().query(MIG_172);
            await db._client().query(MIG_172); // idempotent
            const count1 = Number((await db.get('SELECT count(*) AS n FROM report_schedules')).n);
            const rowL = await db.get(
                'SELECT enabled, disabled_reason AS "reason", recipients FROM report_schedules WHERE id = ?',
                [legacy.id]
            );
            const rowM = await db.get(
                'SELECT enabled, disabled_reason AS "reason" FROM report_schedules WHERE id = ?',
                [mapped.id]
            );
            const recM = await db.all(
                `SELECT recipient_type AS t, recipient_id AS id FROM report_schedule_recipients WHERE schedule_id = ?`,
                [mapped.id]
            );
            const recL = await db.all(
                'SELECT 1 FROM report_schedule_recipients WHERE schedule_id = ?',
                [legacy.id]
            );
            const told = await db.all(
                `SELECT user_type AS t, user_id AS id, payload FROM notifications
                  WHERE kind = 'report.schedule_suspended' AND (payload->>'scheduleId')::int = ?`,
                [legacy.id]
            );
            const toldMapped = await db.all(
                `SELECT 1 FROM notifications WHERE kind = 'report.schedule_suspended' AND (payload->>'scheduleId')::int = ?`,
                [mapped.id]
            );
            const s = await scheduler.loadSchedule(legacy.id);
            const status = await scheduler.runOne(s);
            // Choosing accounts re-enables the suspended schedule.
            const res = mkRes();
            await Ctrl.updateScheduleRecipients(
                mkReq(
                    { id: 1, userType: 'admin', role: 'superadmin' },
                    { recipientAccounts: ['admin:1'] },
                    { id: String(legacy.id) }
                ),
                res
            );
            const reenabled = await db.get(
                'SELECT enabled, disabled_reason AS "reason" FROM report_schedules WHERE id = ?',
                [legacy.id]
            );
            return {
                count0,
                count1,
                rowL,
                rowM,
                recM,
                recL,
                told,
                toldMapped,
                s,
                status,
                update: res.statusCode,
                reenabled,
            };
        });
        expect(r.count1).toBe(r.count0);
        expect(r.rowL).toMatchObject({ enabled: false, reason: 'legacy_outside_address' });
        expect(r.rowL.recipients).toBe('someone@outside.example, ADMIN@example.com'); // kept
        expect(r.recL).toHaveLength(0);
        expect(r.told).toHaveLength(1);
        expect(r.told[0]).toMatchObject({ t: 'admin' });
        expect(Number(r.told[0].id)).toBe(1);
        expect(r.told[0].payload.link).toBe('/reports/schedules');
        expect(r.rowM).toMatchObject({ enabled: true, reason: null });
        expect(r.recM.map((x) => `${x.t}:${x.id}`)).toEqual(['admin:1']);
        expect(r.toldMapped).toHaveLength(0);
        expect(scheduler.nextRunAt(r.s)).toBeNull();
        expect(r.status).toMatch(/^skipped: disabled/);
        expect(mockSend).not.toHaveBeenCalled();
        expect(r.update).toBe(200);
        expect(r.reenabled).toEqual({ enabled: true, reason: null });
    });
});

// Pure helpers — no database.
describe('SA-38 — clearance cover rule and the notice catalogue', () => {
    const { covers } = require('../../src/jobs/report-scheduler');
    test('null = unrestricted; a restricted reader never covers an unrestricted report', () => {
        expect(covers(null, null)).toBe(true);
        expect(covers(null, [1, 2])).toBe(true);
        expect(covers([1, 2], null)).toBe(false);
        expect(covers([1, 2, 3], [1, 2])).toBe(true);
        expect(covers([1, 2], [1, 2, 3])).toBe(false);
        expect(covers([], [])).toBe(true);
    });

    test('both kinds are catalogued in FR and EN, and the retention setting is SuperAdmin-only', () => {
        const N = require('../../src/services/NotificationService');
        for (const kind of ['report.schedule_ready', 'report.schedule_suspended']) {
            expect(N.KIND_META[kind].title.fr).toBeTruthy();
            expect(N.KIND_META[kind].title.en).toBeTruthy();
            expect(N.KIND_MESSAGES[kind].fr).toBeTruthy();
            expect(N.KIND_MESSAGES[kind].en).toBeTruthy();
            expect(N.KIND_LABELS[kind]).toBeTruthy();
        }
        const { isSecurityClassSetting } = require('../../src/utils/securitySettings');
        expect(isSecurityClassSetting('reportRunRetentionDays', 'jobs')).toBe(true);
        const { reportRunDays } = require('../../src/jobs/retention-purge');
        expect(reportRunDays('0')).toBe(1);
        expect(reportRunDays('9999')).toBe(365);
        expect(reportRunDays('abc')).toBe(90);
    });
});
