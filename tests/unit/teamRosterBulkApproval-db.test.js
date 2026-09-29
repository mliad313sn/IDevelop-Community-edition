'use strict';
/**
 * Manager dashboard "My team" roster and the team-wide "approve all agreed
 * ratings", proved against the REAL schema inside ONE transaction that is
 * always rolled back. Self-contained fixture (own role, skills, people), so it
 * runs on the small CI seed as well as on a populated database.
 *
 *   Roster     one row per DIRECT report of the person behind the account —
 *              never an N+2, never a stranger, never oneself; unmeasured
 *              readiness is null ("not measured"), never 0; the last
 *              one-to-one comes from check_ins.
 *   Bulk       only AGREED ratings are approved (self >= required, not
 *              modified); the rest stay in the queue; an N+2 the queue shows
 *              for reading is refused and untouched; another manager's call
 *              touches nothing of this team.
 *
 * Skipped (not failed) when no database is reachable.
 */
require('dotenv').config();

const ROLLBACK = new Error('team-roster-rollback');
let db;
let ready = false;

beforeAll(async () => {
    const url = String(process.env.DATABASE_URL || '');
    if (!url || /placeholder/.test(url)) return;
    db = require('../../src/config/database');
    try {
        await db.connect();
        ready = Boolean(
            await db.get(
                `SELECT 1 AS ok FROM services sv JOIN departments d ON d.id = sv.department_id LIMIT 1`
            )
        );
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
    const org = await db.get(
        `SELECT sv.id AS service_id, d.id AS department_id, d.site_id
           FROM services sv JOIN departments d ON d.id = sv.department_id
          ORDER BY sv.id LIMIT 1`
    );
    const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const dom = Number(
        (await db.get('INSERT INTO domains (name) VALUES (?) RETURNING id', [`TRT-${stamp}`])).id
    );
    const mkSkill = async (n) =>
        Number(
            (
                await db.get('INSERT INTO skills (domain_id, name) VALUES (?, ?) RETURNING id', [
                    dom,
                    `TRT ${n} ${stamp}`,
                ])
            ).id
        );
    const K1 = await mkSkill('one');
    const K2 = await mkSkill('two');
    const role = Number(
        (await db.get('INSERT INTO roles (name) VALUES (?) RETURNING id', [`TRT role ${stamp}`])).id
    );
    await db.run(
        `INSERT INTO role_skill_requirements (role_id, skill_id, required_level, is_critical)
         VALUES (?, ?, 2, true), (?, ?, 3, true)`,
        [role, K1, role, K2]
    );
    const mk = async (n, { sup = null, mgr = null } = {}) =>
        Number(
            (
                await db.get(
                    `INSERT INTO employees (employee_number, first_name, last_name, site_id, department_id,
                                            service_id, role_id, supervisor_id, manager_id, manager_type, is_active)
                     VALUES (?, ?, 'TRT', ?, ?, ?, ?, ?, ?, ?, true) RETURNING id`,
                    [
                        `TRT-${n}-${stamp}`,
                        n,
                        org.siteId,
                        org.departmentId,
                        org.serviceId,
                        role,
                        sup,
                        mgr,
                        mgr ? 'employee' : null,
                    ]
                )
            ).id
        );
    const M = await mk('Manager');
    const A = await mk('Alpha', { sup: M });
    const B = await mk('Bravo', { mgr: M }); // via the MANAGER line
    const C = await mk('Charlie', { sup: A }); // N+2 of M
    const S = await mk('Stranger');
    const M2 = await mk('OtherManager');
    const R2 = await mk('OtherReport', { sup: M2 });
    const submit = async (emp, skill, level) =>
        Number(
            (
                await db.get(
                    `INSERT INTO self_assessment_rounds
                        (employee_id, skill_id, self_rated_level, status, workflow_state, submitted_at, round_no)
                     VALUES (?, ?, ?, 'submitted', 'submitted', now(), 1) RETURNING id`,
                    [emp, skill, level]
                )
            ).id
        );
    const stateOf = async (id) =>
        (await db.get('SELECT workflow_state FROM self_assessment_rounds WHERE id = ?', [id]))
            .workflowState;
    return { M, A, B, C, S, M2, R2, K1, K2, submit, stateOf };
}

const itDb = (name, fn) =>
    test(
        name,
        async () => {
            if (!ready) return;
            await inRollback(fn);
        },
        60000
    );

const asManager = (id) => ({ id, userType: 'manager' });

describe('My team roster — strictly the direct reports', () => {
    itDb('lists the direct reports only (supervisor and manager lines)', async (f) => {
        const Roster = require('../../src/services/TeamRosterService');
        const { rows } = await Roster.forManager(asManager(f.M));
        expect(rows.map((r) => r.employeeId).sort((a, b) => a - b)).toEqual(
            [f.A, f.B].sort((a, b) => a - b)
        );
        // N+2, stranger, other team and self are all absent.
        for (const id of [f.C, f.S, f.R2, f.M]) {
            expect(rows.some((r) => r.employeeId === id)).toBe(false);
        }
        // A person with no report, and another manager, see only their own.
        expect((await Roster.forManager(asManager(f.S))).rows).toEqual([]);
        expect((await Roster.forManager(asManager(f.M2))).rows.map((r) => r.employeeId)).toEqual([
            f.R2,
        ]);
    });

    itDb('unmeasured readiness is null (not 0) and the denominator is shown', async (f) => {
        const Roster = require('../../src/services/TeamRosterService');
        const { rows } = await Roster.forManager(asManager(f.M));
        const a = rows.find((r) => r.employeeId === f.A);
        expect(a.readinessPercent).toBeNull();
        expect(a.assessedRequired).toBe(0);
        expect(a.totalRequired).toBe(2);
        expect(a.state).toBe('not_started');
        expect(a.lastOneOnOne).toBeNull();
        expect(a.next.key).toBe('remind');
    });

    itDb('chip, pending count and last one-to-one reflect the data', async (f) => {
        const Roster = require('../../src/services/TeamRosterService');
        await f.submit(f.B, f.K1, 3);
        await db.run(
            `INSERT INTO check_ins (employee_id, manager_id, kind, status, occurred_at)
             VALUES (?, ?, 'one_on_one', 'completed', now() - interval '3 days')`,
            [f.B, f.M]
        );
        const { rows, oneOnOneMeasured } = await Roster.forManager(asManager(f.M));
        const b = rows.find((r) => r.employeeId === f.B);
        expect(oneOnOneMeasured).toBe(true);
        expect(b.state).toBe('to_review');
        expect(b.pendingReview).toBe(1);
        expect(b.lastOneOnOne).not.toBeNull();
        expect(b.next).toEqual({ key: 'review', href: '/supervisor/self-assessment-reviews' });
    });
});

describe('Team bulk approval — agreed ratings, within the reviewer authority', () => {
    itDb('approves only agreed ratings of direct reports; the rest stays queued', async (f) => {
        const WF = require('../../src/services/SelfAssessmentWorkflowService');
        const aMeets = await f.submit(f.A, f.K1, 3); // required 2 → agreed
        const aBelow = await f.submit(f.A, f.K2, 1); // required 3 → held
        const bMeets = await f.submit(f.B, f.K2, 3); // required 3 → agreed
        const cNplus2 = await f.submit(f.C, f.K1, 4); // N+2: read-only for M
        const sStranger = await f.submit(f.S, f.K1, 4); // out of scope
        const rOther = await f.submit(f.R2, f.K1, 4); // other manager's team

        // The queue shows the N+2 to M for READING (sub-tree), never the others.
        const queued = (await WF.reviewQueue(asManager(f.M))).map((r) => Number(r.employeeId));
        expect(queued).toContain(f.C);
        expect(queued).not.toContain(f.S);
        expect(queued).not.toContain(f.R2);

        const res = await WF.bulkApproveAgreedForTeam(asManager(f.M), null);
        expect(res.approved).toBe(2);
        expect(res.held).toBe(1);
        expect(res.failed).toBe(0);

        expect(await f.stateOf(aMeets)).toBe('approved');
        expect(await f.stateOf(bMeets)).toBe('approved');
        expect(await f.stateOf(aBelow)).toBe('submitted');
        expect(await f.stateOf(cNplus2)).toBe('submitted');
        expect(await f.stateOf(sStranger)).toBe('submitted');
        expect(await f.stateOf(rOther)).toBe('submitted');
        // The N+2 was in M's reading scope and refused for acting.
        expect(res.employees).toBe(3);
        expect(res.skippedEmployees).toBe(1);

        // The approval is attributed to the manager, like a per-line approval.
        const row = await db.get(
            'SELECT approved_by_ref FROM self_assessment_rounds WHERE id = ?',
            [aMeets]
        );
        expect(String(row.approvedByRef)).toMatch(new RegExp(`${f.M}`));
    });

    itDb("another manager's call never touches this team", async (f) => {
        const WF = require('../../src/services/SelfAssessmentWorkflowService');
        const aMeets = await f.submit(f.A, f.K1, 3);
        const rOther = await f.submit(f.R2, f.K1, 4);
        const res = await WF.bulkApproveAgreedForTeam(asManager(f.M2), null);
        expect(res.approved).toBe(1);
        expect(await f.stateOf(rOther)).toBe('approved');
        expect(await f.stateOf(aMeets)).toBe('submitted');
    });

    itDb('a person with no team approves nothing', async (f) => {
        const WF = require('../../src/services/SelfAssessmentWorkflowService');
        const aMeets = await f.submit(f.A, f.K1, 3);
        const res = await WF.bulkApproveAgreedForTeam({ id: f.S, userType: 'employee' }, null);
        expect(res.approved).toBe(0);
        expect(await f.stateOf(aMeets)).toBe('submitted');
    });

    itDb('a rating the reviewer already changed is not swept', async (f) => {
        const WF = require('../../src/services/SelfAssessmentWorkflowService');
        const id = await f.submit(f.A, f.K1, 3);
        const cols = await db.all(
            `SELECT column_name FROM information_schema.columns
              WHERE table_name = 'supervisor_reviews' AND is_nullable = 'NO' AND column_default IS NULL`
        );
        const known = new Set([
            'self_assessment_id',
            'employee_id',
            'skill_id',
            'supervisor_rated_level',
            'reviewed_by',
            'id',
        ]);
        // Only exercise the DB path when the fixture can be written with the
        // columns we know; the pure rule is pinned in teamApprovalRule.test.js.
        if (cols.some((c) => !known.has(c.columnName))) return;
        await db.run(
            `INSERT INTO supervisor_reviews (self_assessment_id, employee_id, skill_id, supervisor_rated_level, reviewed_by)
             VALUES (?, ?, ?, 1, ?)`,
            [id, f.A, f.K1, f.M]
        );
        const res = await WF.bulkApproveForEmployee(f.A, asManager(f.M), null, {
            agreedOnly: true,
        });
        expect(res.approved).toBe(0);
        expect(res.held).toEqual([{ id, reason: 'modified' }]);
        expect(await f.stateOf(id)).toBe('submitted');
    });
});
