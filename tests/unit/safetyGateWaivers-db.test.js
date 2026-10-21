'use strict';
/**
 * The human path on the safety-competency gate (migration 174), on the REAL
 * test database. Every scenario runs inside ONE transaction that is always
 * rolled back, on people, a skill and a rule created inside it.
 *
 *  - a line supervisor grants a waiver: the gate answers WAIVED (the API says
 *    cleared + waived + the end date, never CLEARED) and the status table
 *    records it;
 *  - 72 hours is a database CHECK as well as a form rule; one renewal; no
 *    fresh grant within 72 hours of the end of any waiver; at most 144 waived
 *    hours per person and skill over 30 days;
 *  - the end restores the computed status at once, the job marks the row
 *    expired and the end is notified once;
 *  - a rule required by law refuses the waiver, ends a running one, ignores a
 *    row forced in behind the service, and cannot be switched to observe;
 *  - the person contests, an HSE reviewer records a decision with its reason,
 *    the person is told;
 *  - the export carries the waivers and contests, and erasure replaces their
 *    free text with the marker.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const HAS_DB = require('../helpers/testDatabase').isTestDatabaseUrl(process.env.DATABASE_URL || '');
const suite = HAS_DB ? describe : describe.skip;

const mockNotify = jest.fn(async () => ({ inapp: 'queued' }));
jest.mock('../../src/services/NotificationService', () => ({
    notify: (...a) => mockNotify(...a),
    enqueue: jest.fn().mockResolvedValue({}),
    enqueueBulkInApp: jest.fn().mockResolvedValue(undefined),
    KIND_META: {},
}));
jest.mock('../../src/services/LogService', () => ({ log: jest.fn().mockResolvedValue() }));

const db = HAS_DB ? require('../../src/config/database') : null;

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});
beforeEach(() => {
    mockNotify.mockClear();
    jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

async function inRolledBackTx(fn) {
    let result = null;
    await db
        .runTransaction(async () => {
            result = await fn();
            throw new Error('__ROLLBACK__');
        })
        .catch((e) => {
            if (!/__ROLLBACK__/.test(e.message)) throw e;
        });
    return result;
}

/** A savepoint, so an expected failure leaves the test transaction usable. */
async function attempt(fn) {
    try {
        await db.runInSavepoint(fn);
        return null;
    } catch (e) {
        return e;
    }
}

const SUPER = { id: 1, userType: 'admin', role: 'superadmin' };

/** A supervisor and a person in one role, a fresh skill and one enforced rule on it. */
async function fixture() {
    const tpl = await db.get(
        `SELECT site_id, department_id, service_id, role_id FROM employees
          WHERE is_active = true AND role_id IS NOT NULL ORDER BY id LIMIT 1`
    );
    const stamp = Date.now();
    const insertEmp = async (n, supervisorId) =>
        Number(
            (
                await db.get(
                    `INSERT INTO employees (employee_number, first_name, last_name, site_id, department_id,
                                            service_id, role_id, supervisor_id, is_active)
                     VALUES (?, ?, 'SGW', ?, ?, ?, ?, ?, true) RETURNING id`,
                    [
                        `SGW-${n}-${stamp}`,
                        `P${n}`,
                        tpl.siteId,
                        tpl.departmentId,
                        tpl.serviceId,
                        tpl.roleId,
                        supervisorId,
                    ]
                )
            ).id
        );
    const supId = await insertEmp('lead', null);
    const eid = await insertEmp('crew', supId);
    const dom = (await db.get('SELECT domain_id FROM skills ORDER BY id LIMIT 1')).domainId;
    const skillId = Number(
        (
            await db.get('INSERT INTO skills (domain_id, name) VALUES (?, ?) RETURNING id', [
                dom,
                `Confined space entry ${stamp}`,
            ])
        ).id
    );
    await db.run(
        `UPDATE safety_gate_rules SET is_active = false, deactivated_reason = 'waiver test'
          WHERE role_id = ? AND is_active`,
        [tpl.roleId]
    );
    const rule = await db.get(
        `INSERT INTO safety_gate_rules (role_id, site_id, skill_id, min_level, cert_required, mode)
         VALUES (?, NULL, ?, 2, false, 'enforce') RETURNING id`,
        [tpl.roleId, skillId]
    );
    return {
        eid,
        skillId,
        ruleId: Number(rule.id),
        sup: { id: supId, userType: 'employee' },
        person: { id: eid, userType: 'employee' },
    };
}

suite('safety gate: waivers and contests on the real schema', () => {
    jest.setTimeout(120000);
    const SG = () => require('../../src/services/SafetyGateService');
    const SW = () => require('../../src/services/SafetyWaiverService');

    test('a line waiver reads WAIVED, never CLEARED; limits; lazy end; one end notice', async () => {
        const out = await inRolledBackTx(async () => {
            const f = await fixture();
            const r = {};
            r.before = SG().effectiveStatus(await SG().recomputeForEmployee(f.eid, 'test'));
            const grant = (hours, reason, actor = f.sup) =>
                attempt(() =>
                    SW().grantWaiver(
                        { employeeId: f.eid, skillId: f.skillId, hours, reason },
                        actor
                    )
                );
            r.tooLong = await grant(73, 'x');
            r.dbWindow = await attempt(() =>
                db.run(
                    `INSERT INTO safety_gate_waivers (employee_id, skill_id, reason, granted_by_ref, granted_via, starts_at, expires_at)
                     VALUES (?, ?, 'x', 'employee:1', 'line', now(), now() + interval '73 hours')`,
                    [f.eid, f.skillId]
                )
            );
            r.noReason = await grant(24, '   ');
            r.self = await grant(24, 'x', f.person);

            const w = await SW().grantWaiver(
                {
                    employeeId: f.eid,
                    skillId: f.skillId,
                    hours: 24,
                    reason: 'Night shift cover; training booked',
                },
                f.sup
            );
            r.via = w.via;
            const [now] = await SG().computeFor({ employeeIds: [f.eid] }, null, { record: false });
            r.api = SG().toApi(now);
            r.stored = await db.get(
                'SELECT status, enforced_status AS "enforced" FROM safety_gate_status WHERE employee_id = ?',
                [f.eid]
            );
            r.grantKinds = mockNotify.mock.calls.map(([a]) => a.kind);
            r.grantMail = mockNotify.mock.calls
                .filter(([a]) => /^safety\.waiver/.test(a.kind))
                .map(([a]) => Boolean(a.subject || a.html || a.text));

            r.again = await grant(24, 'x');
            const ren = await SW().renewWaiver(
                w.id,
                { hours: 72, reason: 'Course moved to next week' },
                f.sup
            );
            r.second = await attempt(() =>
                SW().renewWaiver(ren.id, { hours: 24, reason: 'x' }, f.sup)
            );

            // The renewed window closes: the gate stops counting it at once.
            await db.run(
                `UPDATE safety_gate_waivers SET starts_at = now() - interval '5 hours',
                        expires_at = now() - interval '1 hour' WHERE id = ?`,
                [ren.id]
            );
            const [lazy] = await SG().computeFor({ employeeIds: [f.eid] }, null, { record: false });
            r.lazy = SG().effectiveStatus(lazy);
            mockNotify.mockClear();
            r.expired = await SW().expireDue();
            r.state = (
                await db.get('SELECT state FROM safety_gate_waivers WHERE id = ?', [ren.id])
            ).state;
            await SG().recomputeForEmployee(f.eid, 'test');
            r.endKinds = mockNotify.mock.calls.map(([a]) => `${a.userType}:${a.kind}`);
            // A renewed chain cannot be restarted by a fresh grant.
            r.fresh = await grant(24, 'x');
            r.history = (
                await db.all(
                    'SELECT status FROM safety_gate_status_history WHERE employee_id = ? ORDER BY id DESC LIMIT 4',
                    [f.eid]
                )
            ).map((x) => x.status);
            return r;
        });
        expect(out.before).toBe('BLOCKED');
        expect(out.tooLong && out.tooLong.code).toBe('bad_hours');
        expect(out.dbWindow && out.dbWindow.message).toMatch(/chk_sg_waiver_window/);
        expect(out.noReason && out.noReason.code).toBe('reason_required');
        expect(out.noReason.subject).toBe('waiver');
        expect(out.self && out.self.code).toBe('forbidden');
        expect(out.via).toBe('line');
        expect(out.api.status).toBe('WAIVED');
        expect(out.api).toMatchObject({ cleared: true, waived: true });
        expect(out.api.waiverExpiresAt).toMatch(/^\d{4}-\d\d-\d\dT/);
        expect(out.api.reasons.find((x) => x.code === 'not_assessed')).toMatchObject({
            waived: true,
        });
        expect(out.stored).toEqual({ status: 'WAIVED', enforced: 'WAIVED' });
        expect(out.grantKinds).toEqual(expect.arrayContaining(['safety.waiver_granted']));
        // The mail is the catalogue's own: no subject or body naming anyone.
        expect(out.grantMail.every((x) => x === false)).toBe(true);
        expect(out.again && out.again.code).toBe('waiver_exists');
        expect(out.second && out.second.code).toBe('renewal_exhausted');
        expect(out.lazy).toBe('BLOCKED');
        expect(out.expired.expired).toBe(1);
        expect(out.state).toBe('expired');
        expect(out.endKinds.filter((k) => k === 'employee:safety.waiver_ended')).toHaveLength(1);
        expect(out.endKinds.some((k) => /safety\.blocked$/.test(k))).toBe(false);
        expect(out.fresh && out.fresh.code).toBe('renewal_exhausted');
        expect(out.history[0]).toBe('BLOCKED');
        expect(out.history).toContain('WAIVED');
    });

    test('a 72-hour pause after any waiver, and at most 144 waived hours in 30 days', async () => {
        const out = await inRolledBackTx(async () => {
            const f = await fixture();
            await SG().recomputeForEmployee(f.eid, 'test');
            const r = {};
            const w = await SW().grantWaiver(
                { employeeId: f.eid, skillId: f.skillId, hours: 10, reason: 'Cover' },
                f.sup
            );
            await SW().revokeWaiver(w.id, 'Trained person available', f.sup);
            r.cooldown = await attempt(() =>
                SW().grantWaiver(
                    { employeeId: f.eid, skillId: f.skillId, hours: 10, reason: 'Again' },
                    f.sup
                )
            );
            // Move that waiver out of the pause, but keep it inside 30 days, and
            // add history: two earlier 66-hour waivers in the window.
            await db.run(
                `UPDATE safety_gate_waivers SET starts_at = now() - interval '20 days',
                        expires_at = now() - interval '20 days' + interval '10 hours',
                        ended_at = now() - interval '20 days' + interval '10 hours'
                  WHERE id = ?`,
                [w.id]
            );
            for (const daysAgo of [15, 10])
                await db.run(
                    `INSERT INTO safety_gate_waivers (employee_id, skill_id, reason, granted_by_ref, granted_via,
                                                      starts_at, expires_at, state, ended_at)
                     VALUES (?, ?, 'earlier', 'employee:1', 'line', now() - (? * interval '1 day'),
                             now() - (? * interval '1 day') + interval '66 hours', 'expired',
                             now() - (? * interval '1 day') + interval '66 hours')`,
                    [f.eid, f.skillId, daysAgo, daysAgo, daysAgo]
                );
            // 10 + 66 + 66 = 142 hours used: 3 more would pass 144, 2 fit.
            r.cap = await attempt(() =>
                SW().grantWaiver(
                    { employeeId: f.eid, skillId: f.skillId, hours: 3, reason: 'Again' },
                    f.sup
                )
            );
            r.fits = await attempt(() =>
                SW().grantWaiver(
                    { employeeId: f.eid, skillId: f.skillId, hours: 2, reason: 'Again' },
                    f.sup
                )
            );
            return r;
        });
        expect(out.cooldown && out.cooldown.code).toBe('waiver_cooldown');
        expect(out.cap && out.cap.code).toBe('waiver_cap');
        expect(out.cap.status).toBe(409);
        expect(out.fits).toBeNull();
    });

    test('a rule required by law: no waiver, a running one ends, never switched to observe', async () => {
        const out = await inRolledBackTx(async () => {
            const f = await fixture();
            await SG().recomputeForEmployee(f.eid, 'test');
            const w = await SW().grantWaiver(
                { employeeId: f.eid, skillId: f.skillId, hours: 12, reason: 'On call' },
                SUPER
            );
            await SG().setRuleLegal(f.ruleId, true, '', SUPER);
            const r = {};
            r.state = await db.get(
                'SELECT state, ended_reason AS "why" FROM safety_gate_waivers WHERE id = ?',
                [w.id]
            );
            const [now] = await SG().computeFor({ employeeIds: [f.eid] }, null, { record: false });
            r.status = SG().effectiveStatus(now);
            r.legalTag = now.reasons.some((x) => x.legallyMandatory === true);
            const refused = await attempt(() =>
                SW().grantWaiver(
                    { employeeId: f.eid, skillId: f.skillId, hours: 12, reason: 'x' },
                    SUPER
                )
            );
            r.refused = refused && refused.code;
            // A row forced in behind the service is ignored by the evaluation.
            await db.run(
                `INSERT INTO safety_gate_waivers (employee_id, skill_id, reason, granted_by_ref, granted_via, starts_at, expires_at)
                 VALUES (?, ?, 'forced', 'admin:1', 'hse', now(), now() + interval '10 hours')`,
                [f.eid, f.skillId]
            );
            const [forced] = await SG().computeFor({ employeeIds: [f.eid] }, null, {
                record: false,
            });
            r.forced = SG().effectiveStatus(forced);
            // Never switched to observe, even with a reason, even by a SuperAdmin.
            const toObserve = await attempt(() =>
                SG().setRuleMode(f.ruleId, 'observe', SUPER, 'pilot')
            );
            r.toObserve = toObserve && { code: toObserve.code, subject: toObserve.subject };
            // Stored as observe behind the service: still enforced.
            await db.run(`UPDATE safety_gate_rules SET mode = 'observe' WHERE id = ?`, [f.ruleId]);
            const [stored] = await SG().computeFor({ employeeIds: [f.eid] }, null, {
                record: false,
            });
            r.storedObserve = SG().effectiveStatus(stored);
            // Removing the mark needs a reason (and a SuperAdmin).
            const noWhy = await attempt(() => SG().setRuleLegal(f.ruleId, false, '', SUPER));
            r.noWhy = noWhy && noWhy.code;
            const bySup = await attempt(() => SG().setRuleLegal(f.ruleId, false, 'mistake', f.sup));
            r.bySup = bySup && bySup.code;
            return r;
        });
        expect(out.state).toEqual({ state: 'revoked', why: 'legally_mandatory' });
        expect(out.status).toBe('BLOCKED');
        expect(out.legalTag).toBe(true);
        expect(out.refused).toBe('legally_mandatory');
        expect(out.forced).toBe('BLOCKED');
        expect(out.toObserve).toEqual({ code: 'legally_mandatory', subject: 'mode' });
        expect(out.storedObserve).toBe('BLOCKED');
        expect(out.noWhy).toBe('reason_required');
        expect(out.bySup).toBe('forbidden');
    });

    test('switching an ordinary rule to observe needs a reason', async () => {
        const out = await inRolledBackTx(async () => {
            const f = await fixture();
            const r = {};
            const noWhy = await attempt(() => SG().setRuleMode(f.ruleId, 'observe', SUPER, ' '));
            r.noWhy = noWhy && { code: noWhy.code, subject: noWhy.subject };
            r.ok = await SG().setRuleMode(f.ruleId, 'observe', SUPER, 'Pilot on this site');
            r.back = await SG().setRuleMode(f.ruleId, 'enforce', SUPER);
            return r;
        });
        expect(out.noWhy).toEqual({ code: 'reason_required', subject: 'mode' });
        expect(out.ok.mode).toBe('observe');
        expect(out.back.mode).toBe('enforce');
    });

    test('a contest gets a decision with its reason; the person is told', async () => {
        const out = await inRolledBackTx(async () => {
            const f = await fixture();
            await SG().recomputeForEmployee(f.eid, 'test');
            const r = {};
            const c = await SW().submitContest(
                { employeeId: f.eid, reason: 'Certificate obtained last month' },
                f.person
            );
            r.as = c.as;
            const dup = await attempt(() =>
                SW().submitContest({ employeeId: f.eid, reason: 'again' }, f.person)
            );
            r.dup = dup && dup.code;
            r.dbNoReason = await attempt(() =>
                db.run(
                    `UPDATE safety_gate_contests SET state = 'upheld', decided_by_ref = 'admin:1', decided_at = now() WHERE id = ?`,
                    [c.id]
                )
            );
            // A supervisor holds no manage_compliance: they cannot decide.
            const bySup = await attempt(() =>
                SW().decideContest(c.id, { decision: 'upheld', reason: 'x' }, f.sup)
            );
            r.bySup = bySup && bySup.code;
            mockNotify.mockClear();
            await SW().decideContest(
                c.id,
                {
                    decision: 'overturned',
                    reason: 'Certificate checked',
                    remedy: 'data_correction',
                    correctionPointer: 'Enter the certificate in the register',
                },
                SUPER
            );
            r.row = await db.get(
                'SELECT state, remedy, decision_reason AS "why", correction_pointer AS "ptr" FROM safety_gate_contests WHERE id = ?',
                [c.id]
            );
            r.told = mockNotify.mock.calls.map(([a]) => `${a.userType}:${a.userId}:${a.kind}`);
            const closed = await attempt(() =>
                SW().decideContest(c.id, { decision: 'upheld', reason: 'x' }, SUPER)
            );
            r.closed = closed && closed.code;
            r.eid = f.eid;
            const mine = await SW().forEmployee(f.eid);
            r.mine = mine.contests.map((x) => x.state);
            return r;
        });
        expect(out.as).toBe('self');
        expect(out.dup).toBe('contest_exists');
        expect(out.dbNoReason && out.dbNoReason.message).toMatch(/chk_sg_contest_decided/);
        expect(out.bySup).toBe('forbidden');
        expect(out.row).toEqual({
            state: 'overturned',
            remedy: 'data_correction',
            why: 'Certificate checked',
            ptr: 'Enter the certificate in the register',
        });
        expect(out.told).toEqual([`employee:${out.eid}:safety.contest.decided`]);
        expect(out.closed).toBe('contest_closed');
        expect(out.mine).toEqual(['overturned']);
    });

    test('the export carries waivers and contests; erasure keeps the rows, not the text', async () => {
        const out = await inRolledBackTx(async () => {
            const f = await fixture();
            await SG().recomputeForEmployee(f.eid, 'test');
            const w = await SW().grantWaiver(
                { employeeId: f.eid, skillId: f.skillId, hours: 6, reason: 'zqxwaiverprobe' },
                f.sup
            );
            await SW().revokeWaiver(w.id, 'zqxendprobe', f.sup);
            await SW().submitContest({ employeeId: f.eid, reason: 'zqxcontestprobe' }, f.person);
            const DSR = require('../../src/services/DSRService');
            const exp = await DSR.export(f.eid);
            const r = {};
            r.exported = JSON.stringify([exp.safetyWaivers, exp.safetyContests]);
            await DSR.erase(f.eid, SUPER.id, { reason: 'test' });
            r.waivers = await db.all(
                'SELECT reason, ended_reason AS "endedReason" FROM safety_gate_waivers WHERE employee_id = ?',
                [f.eid]
            );
            r.contests = await db.all(
                'SELECT reason FROM safety_gate_contests WHERE employee_id = ?',
                [f.eid]
            );
            return r;
        });
        expect(out.exported).toContain('zqxwaiverprobe');
        expect(out.exported).toContain('zqxendprobe');
        expect(out.exported).toContain('zqxcontestprobe');
        expect(out.waivers).toEqual([{ reason: '[erased]', endedReason: '[erased]' }]);
        expect(out.contests).toEqual([{ reason: '[erased]' }]);
    });
});
