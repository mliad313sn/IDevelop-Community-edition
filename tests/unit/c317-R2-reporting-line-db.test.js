'use strict';
/**
 * 3.23.18 — lane R2 (reporting line / notifications / leaver + mover cascades),
 * proved against idevelop_fixtures inside ONE transaction that is always rolled back.
 *
 *  T1  ReportingLineService: ACTIVE supervisor → ACTIVE employee-manager →
 *      ACTIVE admin-manager; lineRecipients adds the manager, dedups, never self.
 *  T2  The talent task / PIP task notification reaches the live line (+ manager).
 *  F8  Leaver: own PIP/IDP/coaching/application closed with reason 'leaver',
 *      journaled on the event, reports announced (not rewired); reinstate
 *      re-opens exactly what was closed.
 *  F10 Mover during an OPEN campaign: new role's missing shells seeded, old rows kept.
 *
 * Skipped (not failed) when the test database is not reachable.
 */
require('dotenv').config();

const ROLLBACK = new Error('c317R2-rollback');
let db;
let ready = false;

beforeAll(async () => {
    if (!/idevelop_fixtures/.test(String(process.env.DATABASE_URL || ''))) return;
    db = require('../../src/config/database');
    try {
        await db.connect();
        ready = Boolean(await db.get('SELECT 1 AS ok FROM employees LIMIT 1'));
    } catch (_) {
        ready = false;
    }
}, 30000);

afterAll(async () => {
    if (db) {
        try {
            await db.close();
        } catch (_) {
            /* closed */
        }
    }
});

async function inRollback(fn) {
    try {
        await db.runTransaction(async () => {
            await fn(await fixture());
            throw ROLLBACK;
        });
    } catch (e) {
        if (e !== ROLLBACK) throw e;
    }
}

async function fixture() {
    const admin = await db.get(
        "SELECT id FROM admins WHERE role::text = 'superadmin' ORDER BY id LIMIT 1"
    );
    const tpl = await db.get(
        `SELECT e.id, e.role_id, e.site_id, e.department_id, e.service_id FROM employees e
          WHERE e.is_active AND e.role_id IS NOT NULL ORDER BY e.id LIMIT 1`
    );
    const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const mk = async (n, { sup = null, mgr = null, mgrType = null, active = true, roleId } = {}) =>
        Number(
            (
                await db.get(
                    `INSERT INTO employees (employee_number, first_name, last_name, site_id, department_id,
                                            service_id, role_id, supervisor_id, manager_id, manager_type, is_active)
                     VALUES (?, ?, 'R2T', ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
                    [
                        `R2T-${n}-${stamp}`,
                        n,
                        tpl.siteId,
                        tpl.departmentId,
                        tpl.serviceId,
                        roleId || tpl.roleId,
                        sup,
                        mgr,
                        mgrType,
                        active,
                    ]
                )
            ).id
        );
    const mkAdmin = async (n, active = true) =>
        Number(
            (
                await db.get(
                    `INSERT INTO admins (username, password_hash, role, is_active)
                     VALUES (?, 'x', 'localadmin', ?) RETURNING id`,
                    [`r2t-${n}-${stamp}`, active]
                )
            ).id
        );
    return { SUPER: Number(admin.id), tpl, mk, mkAdmin, stamp };
}

const itDb = (name, fn) =>
    test(
        name,
        async () => {
            if (!ready) return;
            await inRollback(fn);
        },
        30000
    );

describe('T1 — ReportingLineService', () => {
    itDb(
        'inactive supervisor falls back to the employee manager; both on the line',
        async ({ mk }) => {
            const RL = require('../../src/services/ReportingLineService');
            const M = await mk('M');
            const S = await mk('S', { active: false });
            const E = await mk('E', { sup: S, mgr: M, mgrType: 'employee' });
            const r = await RL.effectiveReviewer(E);
            expect(r).toMatchObject({ type: 'employee', id: M, via: 'manager' });
            expect(r.name).toBe('M R2T');
            const rec = await RL.lineRecipients(E);
            expect(rec).toEqual([{ userType: 'employee', id: M, role: 'manager' }]);
        }
    );

    itDb(
        'active supervisor + admin manager: reviewer first, admin manager added, deduped',
        async ({ mk, mkAdmin }) => {
            const RL = require('../../src/services/ReportingLineService');
            const A = await mkAdmin('A');
            const S = await mk('S');
            const E = await mk('E', { sup: S, mgr: A, mgrType: 'admin' });
            expect(await RL.effectiveReviewer(E)).toMatchObject({ type: 'employee', id: S });
            expect(await RL.lineRecipients(E)).toEqual([
                { userType: 'employee', id: S, role: 'reviewer' },
                { userType: 'admin', id: A, role: 'manager' },
            ]);
            expect(await RL.lineRecipients(E, { includeManager: false })).toEqual([
                { userType: 'employee', id: S, role: 'reviewer' },
            ]);
            // same person as supervisor and manager → once
            const E2 = await mk('E2', { sup: S, mgr: S, mgrType: 'employee' });
            expect(await RL.lineRecipients(E2)).toHaveLength(1);
        }
    );

    itDb(
        'no supervisor, admin manager → admin; inactive admin → null; never self',
        async ({ mk, mkAdmin }) => {
            const RL = require('../../src/services/ReportingLineService');
            const A = await mkAdmin('A');
            const Aoff = await mkAdmin('Aoff', false);
            const E = await mk('E', { mgr: A, mgrType: 'admin' });
            expect(await RL.effectiveReviewer(E)).toMatchObject({ type: 'admin', id: A });
            const E2 = await mk('E2', { mgr: Aoff, mgrType: 'admin' });
            expect(await RL.effectiveReviewer(E2)).toBeNull();
            expect(await RL.lineRecipients(E2)).toEqual([]);
            const E3 = await mk('E3');
            await db
                .runInSavepoint(() =>
                    db.run(
                        "UPDATE employees SET manager_id = id, manager_type = 'employee' WHERE id = ?",
                        [E3]
                    )
                )
                .catch(() => {}); // a DB constraint may already forbid it — either way, never self
            expect(await RL.lineRecipients(E3)).toEqual([]);
        }
    );

    itDb('SQL lateral join agrees with the JS resolver', async ({ mk, mkAdmin }) => {
        const RL = require('../../src/services/ReportingLineService');
        const A = await mkAdmin('A');
        const S = await mk('S', { active: false });
        const E = await mk('E', { sup: S, mgr: A, mgrType: 'admin' });
        const row = await db.get(
            `SELECT rl.kind, rl.id FROM employees e ${RL.effectiveReviewerJoinSql('e', 'rl')} WHERE e.id = ?`,
            [E]
        );
        expect(row.kind).toBe('admin');
        expect(Number(row.id)).toBe(A);
    });
});

describe('T2 — talent task reaches the live line', () => {
    itDb(
        'PIP task: assignee skips the departed supervisor; reviewer AND manager notified',
        async ({ mk }) => {
            const TT = require('../../src/services/TalentTaskService');
            const DT = require('../../src/services/DevelopmentTriggerService');
            const M = await mk('M');
            const S = await mk('S', { active: false });
            const E = await mk('E', { sup: S, mgr: M, mgrType: 'employee' });
            expect(await TT._superiorOf(E)).toBe(M);

            const S2 = await mk('S2');
            const E2 = await mk('E2', { sup: S2, mgr: M, mgrType: 'employee' });
            const res = await DT._notifyManager(E2, 'talent.task.created', '/v2/pip');
            expect(res.all).toEqual([
                { userType: 'employee', userId: S2 },
                { userType: 'employee', userId: M },
            ]);
            const n = await db.all(
                `SELECT user_id FROM notifications WHERE kind = 'talent.task.created' AND channel = 'inapp'
               AND user_type = 'employee' AND user_id IN (?, ?, ?)`,
                [S, S2, M]
            );
            expect(n.map((r) => Number(r.userId)).sort()).toEqual([S2, M].sort());
        }
    );
});

describe('F8 — leaver cascade', () => {
    itDb(
        'closes own plans with reason leaver, announces reports, reinstate re-opens exactly them',
        async ({ mk, SUPER }) => {
            const L = require('../../src/services/LifecycleService');
            const M = await mk('M');
            const X = await mk('X', { sup: M }); // leaver
            const R = await mk('R', { sup: X }); // report left pointing at the leaver
            const pip = Number(
                (
                    await db.get(
                        `INSERT INTO pips (employee_id, initiated_by, summary, state) VALUES (?, ?, 's', 'active') RETURNING id`,
                        [X, SUPER]
                    )
                ).id
            );
            const idp = Number(
                (
                    await db.get(
                        `INSERT INTO idp_plans (employee_id, status) VALUES (?, 'active') RETURNING id`,
                        [X]
                    )
                ).id
            );
            const obj = Number(
                (
                    await db.get(
                        `INSERT INTO idp_objectives (idp_id, smart_text, state) VALUES (?, 'o', 'in_progress') RETURNING id`,
                        [idp]
                    )
                ).id
            );
            const coach = Number(
                (
                    await db.get(
                        `INSERT INTO coaching_plans (employee_id, kind, title, state) VALUES (?, 'coaching', 't', 'draft') RETURNING id`,
                        [X]
                    )
                ).id
            );
            const opp = Number(
                (await db.get(`INSERT INTO opportunities (title) VALUES ('o') RETURNING id`)).id
            );
            const app = Number(
                (
                    await db.get(
                        `INSERT INTO opportunity_applications (opportunity_id, employee_id, status) VALUES (?, ?, 'applied') RETURNING id`,
                        [opp, X]
                    )
                ).id
            );

            await L.record('leaver', X, { actorRef: `admin:${SUPER}` });

            const st = async () => ({
                pip: await db.get(
                    'SELECT state::text AS s, closed_by_ref AS b FROM pips WHERE id = ?',
                    [pip]
                ),
                idp: (
                    await db.get(
                        'SELECT status::text AS s, close_reason AS r FROM idp_plans WHERE id = ?',
                        [idp]
                    )
                ).s,
                obj: (
                    await db.get('SELECT state::text AS s FROM idp_objectives WHERE id = ?', [obj])
                ).s,
                coach: (await db.get('SELECT state AS s FROM coaching_plans WHERE id = ?', [coach]))
                    .s,
                app: await db.get(
                    'SELECT status AS s, decision_note AS n FROM opportunity_applications WHERE id = ?',
                    [app]
                ),
            });
            const after = await st();
            expect(after.pip).toEqual({ s: 'cancelled', b: `admin:${SUPER}` });
            expect(after.idp).toBe('cancelled');
            expect(after.obj).toBe('cancelled');
            expect(after.coach).toBe('cancelled');
            expect(after.app).toEqual({ s: 'withdrawn', n: 'leaver' });

            const ev = await db.get(
                `SELECT id, payload FROM lifecycle_events WHERE employee_id = ? AND kind = 'leaver' ORDER BY id DESC LIMIT 1`,
                [X]
            );
            expect(ev.payload.leaverClosed.reason).toBe('leaver');
            expect(ev.payload.leaverClosed.pips).toEqual([{ id: pip, prev: 'active' }]);
            expect(ev.payload.reportsToReassign).toEqual([R]);
            // Report NOT rewired, and the leaver's own line was told.
            expect(
                Number(
                    (await db.get('SELECT supervisor_id FROM employees WHERE id = ?', [R]))
                        .supervisorId
                )
            ).toBe(X);
            const told = await db.get(
                `SELECT payload FROM notifications WHERE user_type = 'employee' AND user_id = ? AND channel = 'inapp'
                AND (payload ->> 'employeeIds') IS NOT NULL ORDER BY id DESC LIMIT 1`,
                [M]
            );
            expect(told && told.payload.employeeIds).toEqual([R]);

            const back = await L.reinstate(X, { source: 'test' });
            expect(back.plansReopened).toBe(4);
            const re = await st();
            expect(re.pip).toEqual({ s: 'active', b: null });
            expect(re.idp).toBe('active');
            expect(re.obj).toBe('in_progress');
            expect(re.coach).toBe('draft');
            expect(re.app).toEqual({ s: 'applied', n: null });
        }
    );

    itDb('administrative switch-off does not close plans', async ({ mk, SUPER }) => {
        const L = require('../../src/services/LifecycleService');
        const X = await mk('X');
        const pip = Number(
            (
                await db.get(
                    `INSERT INTO pips (employee_id, initiated_by, summary, state) VALUES (?, ?, 's', 'active') RETURNING id`,
                    [X, SUPER]
                )
            ).id
        );
        await L.deprovision(X, { departure: false });
        expect((await db.get('SELECT state::text AS s FROM pips WHERE id = ?', [pip])).s).toBe(
            'active'
        );
    });
});

describe('F10 — mover during an open campaign', () => {
    itDb('seeds the new role missing shells, keeps old rows', async ({ mk, SUPER, stamp }) => {
        const L = require('../../src/services/LifecycleService');
        const reqs = await db.all(
            'SELECT role_id, skill_id FROM role_skill_requirements ORDER BY role_id'
        );
        const byRole = new Map();
        for (const r of reqs) {
            const k = Number(r.roleId);
            if (!byRole.has(k)) byRole.set(k, new Set());
            byRole.get(k).add(Number(r.skillId));
        }
        let ra = null;
        let rb = null;
        const ids = [...byRole.keys()];
        for (const a of ids)
            for (const b of ids)
                if (!ra && a !== b && [...byRole.get(b)].some((s) => !byRole.get(a).has(s))) {
                    ra = a;
                    rb = b;
                }
        if (!ra) return;
        await db.run("UPDATE assessment_cycles SET status = 'closed' WHERE status = 'open'");
        const C = Number(
            (
                await db.get(
                    `INSERT INTO assessment_cycles (code, label, status, opened_at, closes_at, created_by)
                 VALUES (?, 'r2', 'open', now() - interval '1 day', now() + interval '20 days', ?) RETURNING id`,
                    [`R2T-${stamp}`, SUPER]
                )
            ).id
        );
        const X = await mk('X', { roleId: ra });
        const oldSkill = (
            await db.get('SELECT skill_id FROM role_skill_requirements WHERE role_id = ? LIMIT 1', [
                ra,
            ])
        ).skillId;
        await db.run(
            `INSERT INTO self_assessments (employee_id, skill_id, self_rated_level, status, cycle_id)
             VALUES (?, ?, 2, 'draft', ?)`,
            [X, oldSkill, C]
        );
        await db.run('UPDATE employees SET role_id = ? WHERE id = ?', [rb, X]);
        const res = await L.onMover({ employeeId: X, fromRoleId: ra, toRoleId: rb });
        expect(res.seeded.cycleId).toBe(C);
        const missing = await db.get(
            `SELECT COUNT(*)::int AS n FROM role_skill_requirements r
              WHERE r.role_id = ? AND NOT EXISTS
                (SELECT 1 FROM self_assessments s WHERE s.employee_id = ? AND s.skill_id = r.skill_id)`,
            [rb, X]
        );
        expect(missing.n).toBe(0);
        expect(res.seeded.seeded).toBeGreaterThan(0);
        const old = await db.get(
            'SELECT self_rated_level FROM self_assessments WHERE employee_id = ? AND skill_id = ?',
            [X, oldSkill]
        );
        expect(Number(old.selfRatedLevel)).toBe(2);
    });
});
