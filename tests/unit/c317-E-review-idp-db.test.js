'use strict';
/**
 * 3.23.17 — lane E (review / IDP), proved against idevelop_fixtures inside ONE
 * transaction that is always rolled back: nothing this suite writes survives.
 *
 *  F1  "Assign a reviewer" on the campaign console must let that person REVIEW
 *      (authority + queue), for that cycle only, never on themselves.
 *  F2  Reminders go to whoever holds the review NOW — explicit assignment, else
 *      the LIVE line — not to the launch-time snapshot.
 *  F3  An IDP can complete: objectives move, the plan completes (with a reason
 *      when objectives are still open), archives; campaign close MERGES new
 *      gaps into an already-active plan (dedup by skill) instead of skipping.
 *  F9  Closing a campaign stamps a submitted-but-unreviewed row
 *      'closed_unreviewed', never 'finalized'.
 *  F10 IDP generation ignores leavers and measures against the role
 *      snapshotted in the campaign, not the current one.
 *
 * Skipped (not failed) when the test database is not reachable or does not yet
 * carry migration 146.
 */
require('dotenv').config();

const ROLLBACK = new Error('c317E-rollback');
let db;
let ready = false;

beforeAll(async () => {
    if (!/idevelop_fixtures/.test(String(process.env.DATABASE_URL || ''))) return;
    db = require('../../src/config/database');
    try {
        await db.connect();
        const col = await db.get(
            `SELECT 1 AS ok FROM information_schema.columns
              WHERE table_name = 'cycle_participants' AND column_name = 'reviewer_assigned_at'`
        );
        const val = await db.get(
            `SELECT 1 AS ok FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
              WHERE t.typname = 'locked_state' AND e.enumlabel = 'closed_unreviewed'`
        );
        ready = Boolean(col && val);
    } catch (_) {
        ready = false;
    }
}, 30000);

afterAll(async () => {
    if (db) {
        try {
            await db.close();
        } catch (_) {
            /* already closed */
        }
    }
});

/** Run `fn(fx)` inside a transaction that is always rolled back. */
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
    const SUPER = { userType: 'admin', role: 'superadmin', id: Number(admin.id), username: 't' };
    const tpl = await db.get(
        `SELECT e.id, e.role_id, e.site_id, e.department_id, e.service_id FROM employees e
          WHERE e.is_active AND e.role_id IS NOT NULL
            AND (SELECT COUNT(*) FROM role_skill_requirements q WHERE q.role_id = e.role_id AND q.required_level >= 2) >= 3
          ORDER BY e.id LIMIT 1`
    );
    const stamp = Date.now();
    const mk = async (n, sup) =>
        Number(
            (
                await db.get(
                    `INSERT INTO employees (employee_number, first_name, last_name, site_id, department_id, service_id, role_id, supervisor_id, is_active)
                 VALUES (?, ?, 'C317E', ?, ?, ?, ?, ?, true) RETURNING id`,
                    [
                        `C317E-${n}-${stamp}`,
                        n,
                        tpl.siteId,
                        tpl.departmentId,
                        tpl.serviceId,
                        tpl.roleId,
                        sup,
                    ]
                )
            ).id
        );
    const S1 = await mk('S1', null);
    const S2 = await mk('S2', null);
    const A = await mk('A', null);
    const X = await mk('X', S1);
    const Y = await mk('Y', S1);
    const C = Number(
        (
            await db.get(
                `INSERT INTO assessment_cycles (code, label, status, opened_at, closes_at, created_by)
             VALUES (?, 'c317E', 'locked', now() - interval '20 days', now() - interval '1 day', ?) RETURNING id`,
                [`C317E-${stamp}`, SUPER.id]
            )
        ).id
    );
    const reqs = await db.all(
        'SELECT skill_id FROM role_skill_requirements WHERE role_id = ? AND required_level >= 2 ORDER BY skill_id LIMIT 3',
        [tpl.roleId]
    );
    await db.run(
        `INSERT INTO cycle_participants (cycle_id, employee_id, role_id, supervisor_id, expected_skills)
         VALUES (?, ?, ?, ?, 3), (?, ?, ?, ?, 3)`,
        [C, X, tpl.roleId, S1, C, Y, tpl.roleId, S1]
    );
    const submitted = Number(
        (
            await db.get(
                `INSERT INTO self_assessments (employee_id, skill_id, self_rated_level, status, workflow_state, submitted_at, cycle_id)
             VALUES (?, ?, 1, 'submitted', 'submitted', now(), ?) RETURNING id`,
                [X, reqs[0].skillId, C]
            )
        ).id
    );
    const finalRow = async (emp, skill, lvl) => {
        const r = await db.get(
            `INSERT INTO self_assessments (employee_id, skill_id, self_rated_level, status, workflow_state, submitted_at, cycle_id,
                                           locked_state, approved_by, approved_by_ref, approved_at)
             VALUES (?, ?, ?, 'approved', 'approved', now(), ?, 'finalized', ?, ?, now()) RETURNING id`,
            [emp, skill, lvl, C, S1, `employee:${S1}`]
        );
        await db.run(
            `INSERT INTO supervisor_reviews (self_assessment_id, employee_id, skill_id, reviewed_by, supervisor_rated_level, status, decision)
             VALUES (?, ?, ?, ?, ?, 'completed', 'approve')`,
            [r.id, emp, skill, S1, lvl]
        );
        return Number(r.id);
    };
    return {
        SUPER,
        tpl,
        S1,
        S2,
        A,
        X,
        Y,
        C,
        reqs: reqs.map((r) => Number(r.skillId)),
        submitted,
        finalRow,
    };
}

const maybe = (name, fn) =>
    test(
        name,
        async () => {
            if (!ready) return; // no test DB / migration 146 not applied: nothing to prove here
            await fn();
        },
        60000
    );

describe('F2 — the reminder goes to whoever holds the review now', () => {
    maybe('live line after a manager change, then the explicit console assignment', async () => {
        const CycleService = require('../../src/services/CycleService');
        const { pendingReviewers } = require('../../src/jobs/cycle-nudge');
        await inRollback(async ({ SUPER, S1, S2, A, X, C }) => {
            const who = async () =>
                (await pendingReviewers(C)).map((r) => [r.targetType, Number(r.targetId)]);
            expect(await who()).toEqual([['employee', S1]]);
            await db.run('UPDATE employees SET supervisor_id = ? WHERE id = ?', [S2, X]);
            // Was: S1, the launch-time snapshot, who no longer holds the review.
            expect(await who()).toEqual([['employee', S2]]);
            await CycleService.assignReviewer(C, X, { supervisorId: A }, SUPER, {});
            expect(await who()).toEqual([['employee', A]]);
            const p = await db.get(
                'SELECT reviewer_assigned_at, reviewer_assigned_by_admin_id FROM cycle_participants WHERE cycle_id = ? AND employee_id = ?',
                [C, X]
            );
            expect(p.reviewerAssignedAt).toBeTruthy();
            expect(Number(p.reviewerAssignedByAdminId)).toBe(SUPER.id);
        });
    });
});

describe('F1 — the assigned campaign reviewer can review, that cycle only', () => {
    maybe('authority, queue and an actual review transition', async () => {
        const CycleService = require('../../src/services/CycleService');
        const WF = require('../../src/services/SelfAssessmentWorkflowService');
        await inRollback(async ({ SUPER, A, X, Y, C, submitted }) => {
            const AU = { userType: 'employee', id: A };
            expect((await WF.resolveAuthority(AU, X, { cycleId: C })).canSupervise).toBe(false);
            await CycleService.assignReviewer(C, X, { supervisorId: A }, SUPER, {});
            const auth = await WF.resolveAuthority(AU, X, { cycleId: C });
            expect(auth.canSupervise).toBe(true);
            expect(auth.canView).toBe(true);
            expect(auth.canManage).toBe(false); // arbitration stays above them
            expect((await WF.resolveAuthority(AU, X, { cycleId: C + 1000000 })).canSupervise).toBe(
                false
            );
            expect((await WF.resolveAuthority(AU, X)).canSupervise).toBe(false);
            expect((await WF.resolveAuthority(AU, Y, { cycleId: C })).canSupervise).toBe(false);
            const q = await WF.reviewQueue(AU);
            expect(q.map((r) => [Number(r.employeeId), Number(r.cycleId)])).toEqual([[X, C]]);
            await WF.openReview(submitted, AU);
            const row = await db.get('SELECT workflow_state FROM self_assessments WHERE id = ?', [
                submitted,
            ]);
            expect(row.workflowState).toBe('under_review');
        });
    });

    maybe('never on oneself', async () => {
        const WF = require('../../src/services/SelfAssessmentWorkflowService');
        await inRollback(async ({ X, C }) => {
            // Force the (normally refused) self-assignment straight into the row.
            await db.run(
                `UPDATE cycle_participants SET supervisor_id = ?, reviewer_admin_id = NULL, reviewer_assigned_at = now()
                  WHERE cycle_id = ? AND employee_id = ?`,
                [X, C, X]
            );
            const self = { userType: 'employee', id: X };
            expect((await WF.resolveAuthority(self, X, { cycleId: C })).canSupervise).toBe(false);
            expect(await WF.reviewQueue(self)).toEqual([]);
        });
    });
});

describe('F9 — closing never presents an unreviewed row as finalised', () => {
    maybe('submitted -> closed_unreviewed, approved -> finalized', async () => {
        const CycleService = require('../../src/services/CycleService');
        await inRollback(async ({ X, C, reqs, submitted, finalRow }) => {
            const approved = await finalRow(X, reqs[1], 3);
            await db.run("UPDATE self_assessments SET locked_state = 'provisional' WHERE id = ?", [
                approved,
            ]);
            await CycleService.close(C);
            const st = async (id) =>
                (
                    await db.get(
                        'SELECT locked_state::text AS s FROM self_assessments WHERE id = ?',
                        [id]
                    )
                ).s;
            expect(await st(submitted)).toBe('closed_unreviewed');
            expect(await st(approved)).toBe('finalized');
        });
    });
});

describe('F10 + F3 — generation at close', () => {
    maybe(
        'leaver skipped, campaign role used, gaps merged into the active plan, re-run idempotent',
        async () => {
            const IDP = require('../../src/services/IDPService');
            await inRollback(async ({ X, Y, C, reqs, finalRow }) => {
                await finalRow(X, reqs[1], 0);
                await finalRow(X, reqs[2], 0);
                await finalRow(Y, reqs[1], 0);
                await db.run('UPDATE employees SET is_active = false WHERE id = ?', [Y]);
                // X moves to a role that does not require these skills: the campaign role still applies.
                const other = await db.get(
                    `SELECT r.id FROM roles r WHERE NOT EXISTS (
                     SELECT 1 FROM role_skill_requirements q WHERE q.role_id = r.id AND q.skill_id IN (?, ?))
                  ORDER BY r.id LIMIT 1`,
                    [reqs[1], reqs[2]]
                );
                await db.run('UPDATE employees SET role_id = ? WHERE id = ?', [other.id, X]);
                const plan = Number(
                    (
                        await db.get(
                            `INSERT INTO idp_plans (employee_id, status) VALUES (?, 'active') RETURNING id`,
                            [X]
                        )
                    ).id
                );
                await db.run(
                    `INSERT INTO idp_objectives (idp_id, skill_id, smart_text, state) VALUES (?, ?, 'earlier', 'pending')`,
                    [plan, reqs[1]]
                );
                const first = await IDP.generateDrafts(C);
                expect(first.skipped).toEqual([]); // was: [{ X, 'open_plan_exists' }]
                expect(first.merged).toEqual({ plans: 1, objectives: 1, deduplicated: 1 });
                const second = await IDP.generateDrafts(C);
                expect(second.gaps).toBe(0);
                const skills = (
                    await db.all(
                        'SELECT skill_id FROM idp_objectives WHERE idp_id = ? ORDER BY id',
                        [plan]
                    )
                ).map((o) => Number(o.skillId));
                expect(skills).toEqual([reqs[1], reqs[2]]);
                expect(
                    (await db.all('SELECT id FROM idp_plans WHERE employee_id = ?', [Y])).length
                ).toBe(0);
            });
        }
    );
});

describe('F3 — a plan can complete', () => {
    maybe(
        'objectives move, completion needs closed objectives or a reason, archive, new plan possible',
        async () => {
            const IDP = require('../../src/services/IDPService');
            await inRollback(async ({ S1, X, reqs }) => {
                const plan = Number(
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
                            `INSERT INTO idp_objectives (idp_id, skill_id, smart_text, state) VALUES (?, ?, 'o', 'pending') RETURNING id`,
                            [plan, reqs[0]]
                        )
                    ).id
                );
                const SUP = { userType: 'manager', id: S1 };
                await expect(
                    IDP.completePlan({ idpId: plan, user: { userType: 'employee', id: X } })
                ).rejects.toMatchObject({
                    code: 'IDP_OWN_PLAN',
                });
                await expect(IDP.completePlan({ idpId: plan, user: SUP })).rejects.toMatchObject({
                    code: 'IDP_OPEN_OBJECTIVES',
                });
                await IDP.setObjectiveState({ objectiveId: obj, user: SUP, state: 'in_progress' });
                await IDP.setObjectiveState({ objectiveId: obj, user: SUP, state: 'completed' });
                await expect(IDP.completePlan({ idpId: plan, user: SUP })).resolves.toMatchObject({
                    completed: true,
                });
                const row = await db.get(
                    'SELECT status::text AS s, closed_by_type, closed_by_id FROM idp_plans WHERE id = ?',
                    [plan]
                );
                expect(row).toMatchObject({ s: 'completed', closedByType: 'manager' });
                expect(Number(row.closedById)).toBe(S1);
                await IDP.archivePlan({ idpId: plan, user: SUP });
                const ev = await db.all(
                    'SELECT action, to_state FROM idp_plan_events WHERE idp_id = ? ORDER BY id',
                    [plan]
                );
                expect(ev.map((e) => `${e.action}:${e.toState}`)).toEqual([
                    'objective_state:in_progress',
                    'objective_state:completed',
                    'plan_completed:completed',
                    'plan_archived:archived',
                ]);
                // uq_idp_open_per_employee no longer blocks the next plan.
                await expect(
                    IDP.createManualPlan({ employeeId: X, skillIds: [] })
                ).resolves.toHaveProperty('idpId');
            });
        }
    );

    maybe(
        'an active plan with open objectives completes with a reason, objectives untouched',
        async () => {
            const IDP = require('../../src/services/IDPService');
            await inRollback(async ({ S1, X, reqs }) => {
                const plan = Number(
                    (
                        await db.get(
                            `INSERT INTO idp_plans (employee_id, status) VALUES (?, 'active') RETURNING id`,
                            [X]
                        )
                    ).id
                );
                await db.run(
                    `INSERT INTO idp_objectives (idp_id, skill_id, smart_text, state) VALUES (?, ?, 'o', 'pending')`,
                    [plan, reqs[0]]
                );
                await IDP.completePlan({
                    idpId: plan,
                    user: { userType: 'manager', id: S1 },
                    reason: 'poste supprimé',
                });
                const p = await db.get(
                    'SELECT status::text AS s, close_reason FROM idp_plans WHERE id = ?',
                    [plan]
                );
                expect(p).toMatchObject({ s: 'completed', closeReason: 'poste supprimé' });
                const o = await db.get(
                    'SELECT state::text AS s FROM idp_objectives WHERE idp_id = ?',
                    [plan]
                );
                expect(o.s).toBe('pending');
            });
        }
    );
});
