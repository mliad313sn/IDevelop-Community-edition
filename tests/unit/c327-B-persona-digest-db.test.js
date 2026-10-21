'use strict';
/**
 * « What changed » digests, department snapshots and the archive page on the
 * REAL test database (migrations 187, 189). Invented fixtures, every case in
 * one rolled-back transaction.
 *   - OFF by default (opt-in): the tick writes and sends nothing;
 *   - on: an administrator gets the movements of the scope it sees whole and
 *     what is left to do; an employee gets one next step, in the app only; a
 *     period is archived once (a second run the same day adds nothing); nothing
 *     to say is archived 'silent' and sends nothing;
 *   - NO PERSON NAME in any payload, mail argument or rendered page;
 *   - eight unopened digests in a row step the cadence down, « Restore » puts
 *     it back;
 *   - the archive page: the owner reads it (and it is marked opened), anyone
 *     else gets 403; the daily snapshot writes one row per department.
 */
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { isTestDatabaseUrl } = require('../helpers/testDatabase');
const HAS_DB = isTestDatabaseUrl(process.env.DATABASE_URL);
const suite = HAS_DB ? describe : describe.skip;
jest.setTimeout(240000);

jest.mock('../../src/services/NotificationService', () => ({
    notify: jest.fn().mockResolvedValue({ inapp: 'queued', email: 'sent' }),
    enqueue: jest.fn().mockResolvedValue({ state: 'queued', id: 1 }),
    recipientLang: jest.fn().mockResolvedValue('en'),
}));

const ROOT = path.join(__dirname, '..', '..');
const db = HAS_DB ? require('../../src/config/database') : null;
const S = HAS_DB ? require('../../src/services/PersonaDigestService') : null;
const N = require('../../src/services/NotificationService');

const ROLLBACK = new Error('__C327B_ROLLBACK__');
async function inTx(fn) {
    try {
        await db.runTransaction(async () => {
            await fn(db._txStore.getStore());
            throw ROLLBACK;
        });
    } catch (e) {
        if (e !== ROLLBACK) throw e;
    }
}

const STAMP = `${Date.now()}`.slice(-6);
const NAMES = [
    ['Quillon', 'Marchetere'],
    ['Ysolde', 'Brantwick'],
    ['Corvin', 'Deluzac'],
    ['Thessaly', 'Ombrecourt'],
    ['Aurelio', 'Fenwarde'],
    ['Maelis', 'Strathorn'],
];
let SUPER;
let ORG;
beforeAll(async () => {
    if (!HAS_DB) return;
    await db.connect();
    const a = await db.get(
        `SELECT id, role FROM admins WHERE role = 'superadmin' AND is_active ORDER BY id LIMIT 1`
    );
    SUPER = { userType: 'admin', role: 'superadmin', id: Number(a.id) };
    ORG = await db.get(
        `SELECT sv.id AS "serviceId", sv.department_id AS "departmentId", d.site_id AS "siteId",
                (SELECT id FROM roles ORDER BY id LIMIT 1) AS "roleId"
           FROM services sv JOIN departments d ON d.id = sv.department_id ORDER BY sv.id LIMIT 1`
    );
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

/** Six invented people with accounts; their names must never appear anywhere. */
async function people() {
    const ids = [];
    for (const [i, [f, l]] of NAMES.entries()) {
        const r = await db.get(
            `INSERT INTO employees (employee_number, first_name, last_name, username, site_id, department_id,
                                    service_id, role_id, is_active)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, true) RETURNING id`,
            [
                `DG-${i}-${STAMP}`,
                f,
                l,
                `dg.${f.toLowerCase()}.${STAMP}`,
                ORG.siteId,
                ORG.departmentId,
                ORG.serviceId,
                ORG.roleId,
            ]
        );
        ids.push(Number(r.id));
    }
    return ids;
}

/** Two organisation snapshots 30 days apart, K1 63 % then 59.6 %, 80 people. */
async function snapshots() {
    await db.run(`DELETE FROM kpi_snapshots WHERE scope_type = 'org'`);
    const ins = (days, ready, notReady, expired) =>
        db.run(
            `INSERT INTO kpi_snapshots (snapshot_date, scope_type, scope_id, total_employees,
                                        role_ready_count, not_ready_count, assessment_coverage,
                                        certs_expired, safety_fit_pct, safety_fit_n, kpi_contract)
             VALUES (CURRENT_DATE - ?::int, 'org', 0, 80, ?, ?, 64.2, ?, 96, 25, ?)`,
            [
                days,
                ready,
                notReady,
                expired,
                require('../../src/services/KpiService').CONTRACT_VERSION,
            ]
        );
    await ins(0, 36, 21, 1);
    await ins(30, 34, 23, 4);
}

/** Every full name and login of the database: none may appear in an output. */
async function nameNeedles() {
    const rows = await db.all(
        'SELECT first_name AS f, last_name AS l, username AS u FROM employees'
    );
    const out = [];
    for (const r of rows) {
        const f = String(r.f || '').trim();
        const l = String(r.l || '').trim();
        if (f.length >= 2 && l.length >= 2) out.push(`${f} ${l}`, `${l} ${f}`);
        if (r.u && String(r.u).length > 4) out.push(String(r.u));
    }
    for (const [f, l] of NAMES) out.push(f, l);
    return out.map((x) => x.toLowerCase());
}
const leaks = (text, needles) => {
    const low = String(text).toLowerCase();
    return needles.filter((n) => low.includes(n));
};
const MONDAY_8 = (() => {
    const d = new Date();
    d.setHours(8, 0, 0, 0);
    while (d.getDay() !== 1) d.setDate(d.getDate() + 1);
    return d;
})();

suite('« What changed » digests (rolled back)', () => {
    beforeEach(() => {
        N.notify.mockClear();
        N.enqueue.mockClear();
    });

    test('off by default: the tick writes and sends nothing', async () => {
        await inTx(async () => {
            await db.run(`DELETE FROM app_settings WHERE setting_key = 'personaDigestsEnabled'`);
            require('../../src/models/AppSettingsModel').clearCache?.();
            const before = await db.get('SELECT COUNT(*)::int AS n FROM persona_digests');
            const r = await S.tick({ now: MONDAY_8 });
            expect(r.skippedAll).toBe('disabled');
            const after = await db.get('SELECT COUNT(*)::int AS n FROM persona_digests');
            expect(after.n).toBe(before.n);
            expect(N.notify).not.toHaveBeenCalled();
            expect(N.enqueue).not.toHaveBeenCalled();
        });
    });

    test('on: movements and to-dos for an administrator, one next step for an employee, no name anywhere', async () => {
        await inTx(async () => {
            await db.run('DELETE FROM persona_digests');
            const ids = await people();
            await snapshots();
            // one of them has a self-assessment to start (a running campaign is not needed:
            // no assessment at all while the role has requirements)
            const r1 = await S.tick({ now: MONDAY_8, force: true });
            expect(r1.failed).toBe(0);
            const rows = await db.all(
                `SELECT user_type AS "t", user_id AS "u", persona, state, payload FROM persona_digests`
            );
            const mine = rows.find((r) => r.t === 'admin' && Number(r.u) === SUPER.id);
            expect(mine).toBeDefined();
            expect(mine.persona).toBe('executive');
            expect(mine.state).toBe('sent');
            expect(mine.payload.locale).toBe('en');
            expect(mine.payload.changes.map((c) => c.kpi)).toContain('K1');
            expect(mine.payload.changes[0].text).toMatch(/^Role-ready rate: 63% \(\+4 pts\)/);
            // employees (wave 7): a point with a step to take or a positive change
            // goes through notify (the person's switches apply); the others stay
            // in the app (enqueue). Their first point says the comparison comes next.
            const emp = rows.filter((r) => r.t === 'employee' && ids.includes(Number(r.u)));
            expect(emp.length).toBe(ids.length);
            for (const e of emp) expect(e.persona).toBe('employee');
            for (const e of emp)
                if (e.state === 'sent')
                    expect(e.payload.progress).toMatchObject({ state: 'first', positive: 0 });
            const withStep = new Set(
                rows
                    .filter((e) => e.t === 'employee' && e.payload.actions.length)
                    .map((e) => Number(e.u))
            );
            for (const c of N.notify.mock.calls) {
                if (c[0].userType === 'admin') continue;
                expect(c[0]).toMatchObject({
                    userType: 'employee',
                    kind: 'digest.persona.employee',
                    category: 'digest',
                });
                expect(withStep.has(Number(c[0].userId))).toBe(true);
                expect(c[0].ctaUrl).toMatch(/^\/digests\/\d+$/);
            }
            for (const c of N.enqueue.mock.calls)
                if (c[0].kind === 'digest.persona.employee') expect(c[0].channel).toBe('inapp');
            // NO NAME in any payload or any message argument
            const needles = await nameNeedles();
            const everything =
                JSON.stringify(rows) +
                JSON.stringify(N.notify.mock.calls) +
                JSON.stringify(N.enqueue.mock.calls);
            expect(leaks(everything, needles)).toEqual([]);
            // the same day again: nothing new
            N.notify.mockClear();
            const r2 = await S.tick({ now: MONDAY_8, force: true });
            expect(r2.sent).toBe(0);
            expect(N.notify).not.toHaveBeenCalled();
            const n2 = await db.get('SELECT COUNT(*)::int AS n FROM persona_digests');
            expect(n2.n).toBe(rows.length);
        });
    });

    test('nothing to say is archived silent and sends nothing', async () => {
        await inTx(async () => {
            await db.run('DELETE FROM persona_digests');
            await db.run(`DELETE FROM kpi_snapshots WHERE scope_type = 'org'`);
            const built = await S.build(
                { userType: 'employee', id: -1, persona: 'employee' },
                { cadence: 'weekly', now: MONDAY_8, locale: 'fr' }
            );
            expect(built.state).toBe('silent');
            expect(built.payload.actions).toEqual([]);
        });
    });

    test('eight unopened digests in a row step the cadence down; « Restore » puts it back', async () => {
        await inTx(async () => {
            await db.run(`DELETE FROM persona_digests WHERE user_type = 'admin' AND user_id = ?`, [
                SUPER.id,
            ]);
            await db.run(
                `DELETE FROM persona_digest_prefs WHERE user_type = 'admin' AND user_id = ?`,
                [SUPER.id]
            );
            await S.setCadence('admin', SUPER.id, 'daily');
            await db.run(
                `UPDATE persona_digest_prefs SET reactivated_at = now() - interval '30 days' WHERE user_id = ? AND user_type = 'admin'`,
                [SUPER.id]
            );
            for (let i = 1; i <= 8; i++)
                await db.run(
                    `INSERT INTO persona_digests (user_type, user_id, persona, cadence, window_days, period_key, state, created_at)
                     VALUES ('admin', ?, 'executive', 'daily', 1, CURRENT_DATE - ?::int, 'sent', now() - make_interval(days => ?::int))`,
                    [SUPER.id, i, i]
                );
            const r = { userType: 'admin', id: SUPER.id, persona: 'executive' };
            const pref = await S.getPrefs('admin', SUPER.id);
            expect(await S.applyReadRate(r, 'daily', pref)).toBe('weekly');
            expect(N.enqueue.mock.calls.some((c) => c[0].kind === 'digest.persona.paused')).toBe(
                true
            );
            const after = await S.getPrefs('admin', SUPER.id);
            expect(after).toMatchObject({ cadence: 'weekly', stepdownFrom: 'daily' });
            expect(await S.reactivate('admin', SUPER.id)).toBe('daily');
            // one opened digest in the eight: no step-down
            await db.run(
                `UPDATE persona_digests SET opened_at = now() WHERE user_id = ? AND user_type = 'admin' AND period_key = CURRENT_DATE - 3`,
                [SUPER.id]
            );
            await db.run(
                `UPDATE persona_digest_prefs SET reactivated_at = now() - interval '30 days' WHERE user_id = ? AND user_type = 'admin'`,
                [SUPER.id]
            );
            expect(await S.applyReadRate(r, 'daily', await S.getPrefs('admin', SUPER.id))).toBe(
                'daily'
            );
        });
    });

    test('the archive page: the owner reads it (marked opened), anyone else 403, no name rendered', async () => {
        await inTx(async () => {
            await db.run('DELETE FROM persona_digests');
            await people();
            await snapshots();
            await S.tick({ now: MONDAY_8, force: true });
            const d = await db.get(
                `SELECT id FROM persona_digests WHERE user_type = 'admin' AND user_id = ? AND state = 'sent'`,
                [SUPER.id]
            );
            expect(d).toBeDefined();
            const C = require('../../src/controllers/DigestController');
            const res = () => {
                const r = { statusCode: 200, locals: { lang: 'en' } };
                r.status = (c) => ((r.statusCode = c), r);
                r.render = (v, l) => ((r.view = v), (r.viewLocals = l), r);
                return r;
            };
            const tr = (k, o) => (o && o.days ? `${o.days}-day period ending on ${o.date}` : k);
            const own = res();
            await C.show({ user: SUPER, params: { id: String(d.id) }, t: tr }, own, (e) => {
                throw e;
            });
            expect(own.statusCode).toBe(200);
            expect(own.viewLocals.mode).toBe('one');
            const opened = await db.get('SELECT opened_at FROM persona_digests WHERE id = ?', [
                d.id,
            ]);
            expect(opened.opened_at).not.toBeNull();
            const other = res();
            await C.show(
                { user: { userType: 'employee', id: 999999 }, params: { id: String(d.id) }, t: tr },
                other,
                (e) => {
                    throw e;
                }
            );
            expect(other.statusCode).toBe(403);
            const missing = res();
            await C.show({ user: SUPER, params: { id: 'abc' }, t: tr }, missing, (e) => {
                throw e;
            });
            expect(missing.statusCode).toBe(404);
            // the rendered page
            const dict = require('../../locales/en/dash.json');
            const __ = (k) => dict[String(k).split(':')[1]] || k;
            const file = path.join(ROOT, 'views/pages/digests/show.ejs');
            const html = ejs.render(
                fs.readFileSync(file, 'utf8'),
                { __, ...own.viewLocals },
                { filename: file }
            );
            expect(html).toMatch(/Role-ready rate/);
            expect(leaks(html, await nameNeedles())).toEqual([]);
            expect(html).not.toMatch(/\son[a-z]+="/i);
        });
    });
});

suite('department snapshots (rolled back)', () => {
    test('the daily snapshot writes one row per department with active people', async () => {
        await inTx(async () => {
            await db.run('DELETE FROM kpi_snapshots WHERE snapshot_date = CURRENT_DATE');
            const job = require('../../src/jobs/kpi-snapshot');
            const r = await job.tick();
            expect(r.failed).toBeUndefined();
            const deps = await job.__test.departmentsToCapture();
            const got = await db.all(
                `SELECT scope_id AS id, kpi_contract AS c, total_employees AS n FROM kpi_snapshots
                  WHERE snapshot_date = CURRENT_DATE AND scope_type = 'department' ORDER BY scope_id`
            );
            expect(got.map((x) => Number(x.id))).toEqual(deps.map((x) => Number(x.id)));
            for (const g of got)
                expect(g.c).toBe(require('../../src/services/KpiService').CONTRACT_VERSION);
            expect(await job.tick()).toEqual({ captured: 0, skipped: 'already_today' });
        });
    });
});
