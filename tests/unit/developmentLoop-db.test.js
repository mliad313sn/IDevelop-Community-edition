'use strict';
/**
 * The development loop on the real schema (4.0.0 port, wave 4): assess →
 * gap → plan → do → evidence → validated level. Invented people only, every
 * case inside a transaction that is always rolled back.
 *
 *   - an objective on a skill gets its seeded action; an action carries a skill
 *     (its own, else its objective's), planned hours and a due date;
 *   - the PERSON starts their action and reports it done (no official effect);
 *     nobody else reports for them;
 *   - only the LINE validates (strict ladder): the direct supervisor does; the
 *     person, a read-only account and the line above (N+2) are refused;
 *   - a validation with an observed level higher than the official one makes
 *     it official (action_effectiveness official, history row); "cannot judge
 *     yet" records evidence only; a lower observed level never lowers it;
 *   - the person proposes, the line accepts into the plan (a draft is created
 *     when none is open) or declines with a reason; the person never decides;
 *   - a plan is never signed empty;
 *   - an offline training needs a date; a plan towards a target role tags its
 *     objectives with that role;
 *   - completing a plan records what it achieved and tells the person.
 *
 * Runs on idevelop_test* / idevelop_fixtures; skipped otherwise.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { isTestDatabaseUrl } = require('../helpers/testDatabase');
const HAS_DB = isTestDatabaseUrl(process.env.DATABASE_URL || '');
const suite = HAS_DB ? describe : describe.skip;
jest.setTimeout(120000);

const notified = [];
jest.mock('../../src/services/NotificationService', () => ({
    notify: async (a) => {
        notified.push(a);
        return { inapp: 'ok' };
    },
    enqueue: async () => ({}),
    enqueueBulkInApp: async () => ({}),
    markActed: async () => 0,
    actedQuietly: async () => 0,
}));
jest.mock('../../src/services/LogService', () => ({ log: async () => {} }));

const db = HAS_DB ? require('../../src/config/database') : null;
const { inRolledBackTx, seedFacts } = require('../helpers/kpiWorld');
const STAMP = `${Date.now()}`.slice(-7);

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});
beforeEach(() => {
    notified.length = 0;
});

async function refused(fn) {
    try {
        await db.runInSavepoint(fn);
        return null;
    } catch (e) {
        return e;
    }
}

/** A role with two skills at level 3, a line N2 → M → P, a viewer, a target role. */
async function loopWorld() {
    const facts = await seedFacts(db);
    const [S1, S2, S3] = facts.SKILLS;
    const role = await db.get('INSERT INTO roles (name) VALUES (?) RETURNING id', [
        `LOOP-ROLE-${STAMP}`,
    ]);
    const R = Number(role.id);
    await db.run(
        `INSERT INTO role_skill_requirements (role_id, skill_id, required_level, is_critical)
         VALUES (?, ?, 3, false), (?, ?, 3, false)`,
        [R, S1, R, S2]
    );
    const tr = await db.get('INSERT INTO roles (name) VALUES (?) RETURNING id', [
        `LOOP-TARGET-${STAMP}`,
    ]);
    const T = Number(tr.id);
    await db.run(
        `INSERT INTO role_skill_requirements (role_id, skill_id, required_level, is_critical)
         VALUES (?, ?, 4, false), (?, ?, 2, false)`,
        [T, S1, T, S3]
    );
    let n = 0;
    const emp = async (supervisorId) => {
        n += 1;
        const r = await db.get(
            `INSERT INTO employees (employee_number, first_name, last_name, site_id, department_id,
                                    service_id, role_id, supervisor_id, is_active)
             VALUES (?, 'Loop', ?, ?, ?, ?, ?, ?, true) RETURNING id`,
            [
                `LOOP-${STAMP}-${n}`,
                `Person${n}`,
                facts.ORG.siteId,
                facts.ORG.departmentId,
                facts.ORG.serviceId,
                R,
                supervisorId,
            ]
        );
        return Number(r.id);
    };
    const N2 = await emp(null);
    const M = await emp(N2);
    const P = await emp(M);
    const viewer = await db.get(
        `INSERT INTO admins (username, email, password_hash, role, is_active, force_password_change)
         VALUES (?, ?, 'x', 'viewer', true, false) RETURNING id`,
        [`loop-viewer-${STAMP}`, `loop-viewer-${STAMP}@example.test`]
    );
    // P has an official level 1 on S1; S2 never assessed.
    await db.run(
        `INSERT INTO skill_assessments (employee_id, skill_id, current_level, assessed_by, notes)
         VALUES (?, ?, 1, ?, 'loop fixture')`,
        [P, S1, facts.adminId]
    );
    return {
        ...facts,
        S1,
        S2,
        S3,
        R,
        T,
        P,
        M,
        N2,
        PERSON: { id: P, userType: 'employee' },
        LINE: { id: M, userType: 'manager', role: 'manager' },
        ABOVE: { id: N2, userType: 'manager', role: 'manager' },
        VIEWER: { id: Number(viewer.id), userType: 'admin', role: 'viewer', permissions: [] },
    };
}

async function activePlan(w) {
    const plan = await db.get(
        "INSERT INTO idp_plans (employee_id, status) VALUES (?, 'active') RETURNING id",
        [w.P]
    );
    return Number(plan.id);
}

const IDP = () => require('../../src/services/IDPService');

suite('the action loop: the person acts, the line validates', () => {
    test('a skill objective is seeded with an action; an action carries a skill, hours and a due date', async () => {
        const out = await inRolledBackTx(db, async () => {
            const w = await loopWorld();
            const idpId = await activePlan(w);
            const o = await IDP().addObjective({
                idpId,
                user: w.LINE,
                smartText: 'Reach level 3 in the first skill',
                skillId: w.S1,
                dueOn: '2027-03-31',
                locale: 'en',
            });
            const seeded = await db.all(
                `SELECT a.title, l.skill_id FROM idp_actions a
                   LEFT JOIN action_skill_links l ON l.action_id = a.id
                  WHERE a.objective_id = ?`,
                [o.objectiveId]
            );
            const a = await IDP().addAction({
                idpId,
                user: w.LINE,
                title: 'Shadow an experienced colleague',
                type: 'on_the_job',
                objectiveId: o.objectiveId,
                plannedHours: '6',
                dueOn: '2027-02-15',
            });
            const row = await db.get(
                'SELECT estimated_hours, due_on FROM idp_actions WHERE id = ?',
                [a.actionId]
            );
            const bad = await refused(() =>
                IDP().addAction({ idpId, user: w.LINE, title: 'x', plannedHours: '-3' })
            );
            return { w, seeded, a, row, bad };
        });
        expect(out.seeded).toHaveLength(1);
        expect(Number(out.seeded[0].skillId)).toBe(out.w.S1);
        expect(out.seeded[0].title).toMatch(/reach level 3/);
        expect(out.a.skillId).toBe(out.w.S1);
        expect(Number(out.row.estimatedHours)).toBe(6);
        expect(out.row.dueOn).toBeTruthy();
        expect(out.bad && out.bad.code).toBe('IDP_HOURS');
    });

    test('the person starts and reports; nobody else reports for them; no official effect yet', async () => {
        const out = await inRolledBackTx(db, async () => {
            const w = await loopWorld();
            const idpId = await activePlan(w);
            const a = await IDP().addAction({
                idpId,
                user: w.LINE,
                title: 'Practise the procedure',
                skillId: w.S1,
            });
            await IDP().startAction({ actionId: a.actionId, user: w.PERSON });
            const lineReports = await refused(() =>
                IDP().reportActionDone({ actionId: a.actionId, user: w.LINE })
            );
            await IDP().reportActionDone({
                actionId: a.actionId,
                user: w.PERSON,
                note: 'Done twice under supervision',
                hours: '3,5',
            });
            const again = await refused(() =>
                IDP().reportActionDone({ actionId: a.actionId, user: w.PERSON })
            );
            const row = await db.get(
                `SELECT status::text AS status, reported_done_at, reported_note, reported_by_type,
                        actual_hours FROM idp_actions WHERE id = ?`,
                [a.actionId]
            );
            const level = await db.get(
                'SELECT current_level FROM skill_assessments WHERE employee_id = ? AND skill_id = ?',
                [w.P, w.S1]
            );
            const events = await db.all(
                'SELECT action FROM idp_plan_events WHERE idp_id = ? ORDER BY id',
                [idpId]
            );
            return { w, lineReports, again, row, level, events };
        });
        expect(out.lineReports && out.lineReports.code).toBe('IDP_NOT_SUBJECT');
        expect(out.again && out.again.code).toBe('IDP_ACTION_REPORTED');
        expect(out.row.status).toBe('in_progress');
        expect(out.row.reportedDoneAt).toBeTruthy();
        expect(out.row.reportedNote).toBe('Done twice under supervision');
        expect(out.row.reportedByType).toBe('employee');
        expect(Number(out.row.actualHours)).toBe(3.5);
        expect(Number(out.level.currentLevel)).toBe(1);
        expect(out.events.map((e) => e.action)).toEqual(
            expect.arrayContaining(['action_started', 'action_reported_done'])
        );
        // the line is told an action waits for their validation
        expect(notified.some((n) => n.kind === 'idp.action_reported' && n.userId === out.w.M)).toBe(
            true
        );
    });

    test('only the line validates: the person, a viewer and the line above are refused', async () => {
        const out = await inRolledBackTx(db, async () => {
            const w = await loopWorld();
            const idpId = await activePlan(w);
            const a = await IDP().addAction({
                idpId,
                user: w.LINE,
                title: 'Lead the morning briefing',
                skillId: w.S1,
            });
            const r = {};
            for (const [k, u] of [
                ['person', w.PERSON],
                ['viewer', w.VIEWER],
                ['above', w.ABOVE],
            ]) {
                const e = await refused(() =>
                    IDP().validateAction({ actionId: a.actionId, user: u, observedLevel: 3 })
                );
                r[k] = e && e.code;
            }
            const st = await db.get('SELECT status::text AS s FROM idp_actions WHERE id = ?', [
                a.actionId,
            ]);
            r.still = st.s;
            return r;
        });
        expect(out.person).toBe('IDP_OWN_PLAN');
        expect(out.viewer).toBe('IDP_FORBIDDEN');
        expect(out.above).toBe('IDP_FORBIDDEN');
        expect(out.still).toBe('pending');
    });

    test('the line validates with an observed level: it becomes official; a lower one never lowers it', async () => {
        const out = await inRolledBackTx(db, async () => {
            const w = await loopWorld();
            const idpId = await activePlan(w);
            const a1 = await IDP().addAction({
                idpId,
                user: w.LINE,
                title: 'Run the procedure alone',
                skillId: w.S1,
            });
            await IDP().reportActionDone({ actionId: a1.actionId, user: w.PERSON });
            const v1 = await IDP().validateAction({
                actionId: a1.actionId,
                user: w.LINE,
                observedLevel: '3',
                note: 'Observed on two shifts',
                actualHours: '4',
            });
            const lvl1 = await db.get(
                'SELECT current_level, validation::text AS v FROM skill_assessments WHERE employee_id = ? AND skill_id = ?',
                [w.P, w.S1]
            );
            const ae1 = await db.get(
                'SELECT rating_pre, rating_post, uplift, evidence_source, official FROM action_effectiveness WHERE action_id = ?',
                [a1.actionId]
            );
            const act1 = await db.get(
                `SELECT status::text AS status, validated_by_type, validated_by_id, validation_note,
                        actual_hours FROM idp_actions WHERE id = ?`,
                [a1.actionId]
            );
            const hist = await db.get(
                `SELECT COUNT(*)::int AS n FROM assessment_history
                  WHERE employee_id = ? AND skill_id = ? AND new_level = 3`,
                [w.P, w.S1]
            );
            const a2 = await IDP().addAction({
                idpId,
                user: w.LINE,
                title: 'Teach the procedure',
                skillId: w.S1,
            });
            const v2 = await IDP().validateAction({
                actionId: a2.actionId,
                user: w.LINE,
                observedLevel: 2,
            });
            const lvl2 = await db.get(
                'SELECT current_level FROM skill_assessments WHERE employee_id = ? AND skill_id = ?',
                [w.P, w.S1]
            );
            const ae2 = await db.get(
                'SELECT official FROM action_effectiveness WHERE action_id = ?',
                [a2.actionId]
            );
            const bad = await refused(() =>
                IDP().validateAction({ actionId: a2.actionId, user: w.LINE, observedLevel: 3 })
            );
            return { w, v1, lvl1, ae1, act1, hist, v2, lvl2, ae2, bad };
        });
        expect(out.v1).toMatchObject({ observedLevel: 3, ratingPre: 1, officialUpdated: true });
        expect(out.v1.objectiveMet).toBe(false); // no objective on this action
        expect(Number(out.lvl1.currentLevel)).toBe(3);
        expect(out.lvl1.v).toBe('manager_validated');
        expect(out.ae1).toMatchObject({ evidenceSource: 'observation', official: true });
        expect(Number(out.ae1.ratingPre)).toBe(1);
        expect(Number(out.ae1.uplift)).toBe(2);
        expect(out.act1.status).toBe('completed');
        expect(out.act1.validatedByType).toBe('manager');
        expect(Number(out.act1.validatedById)).toBe(out.w.M);
        expect(out.act1.validationNote).toBe('Observed on two shifts');
        expect(Number(out.act1.actualHours)).toBe(4);
        expect(out.hist.n).toBeGreaterThanOrEqual(1);
        // a lower observation is evidence, never a downgrade
        expect(out.v2.officialUpdated).toBe(false);
        expect(Number(out.lvl2.currentLevel)).toBe(3);
        expect(out.ae2.official).toBe(false);
        expect(out.bad && out.bad.code).toBe('IDP_ACTION_CLOSED');
        expect(
            notified.some((n) => n.kind === 'idp.action_validated' && n.userId === out.w.P)
        ).toBe(true);
    });

    test('"cannot judge yet" closes the action as evidence only; a never-assessed skill stays unassessed', async () => {
        const out = await inRolledBackTx(db, async () => {
            const w = await loopWorld();
            const idpId = await activePlan(w);
            const a = await IDP().addAction({
                idpId,
                user: w.LINE,
                title: 'Read the reference guide',
                skillId: w.S2,
            });
            const v = await IDP().validateAction({
                actionId: a.actionId,
                user: w.LINE,
                observedLevel: '',
            });
            const lvl = await db.get(
                'SELECT current_level FROM skill_assessments WHERE employee_id = ? AND skill_id = ?',
                [w.P, w.S2]
            );
            const ae = await db.get('SELECT 1 AS x FROM action_effectiveness WHERE action_id = ?', [
                a.actionId,
            ]);
            const badLevel = await refused(async () => {
                const b = await IDP().addAction({
                    idpId,
                    user: w.LINE,
                    title: 'Another one',
                    skillId: w.S2,
                });
                await IDP().validateAction({
                    actionId: b.actionId,
                    user: w.LINE,
                    observedLevel: 7,
                });
            });
            return { v, lvl, ae, badLevel };
        });
        expect(out.v.evidenceOnly).toBe(true);
        expect(out.lvl).toBeFalsy();
        expect(out.ae).toBeFalsy();
        expect(out.badLevel && out.badLevel.code).toBe('IDP_LEVEL');
    });

    test('actions move only on an active plan; an offline training needs a date', async () => {
        const out = await inRolledBackTx(db, async () => {
            const w = await loopWorld();
            const draft = await db.get(
                "INSERT INTO idp_plans (employee_id, status) VALUES (?, 'draft') RETURNING id",
                [w.P]
            );
            const a = await IDP().addAction({
                idpId: Number(draft.id),
                user: w.LINE,
                title: 'Attend the induction course',
                type: 'training',
            });
            const start = await refused(() =>
                IDP().startAction({ actionId: a.actionId, user: w.PERSON })
            );
            const noDate = await refused(() =>
                IDP().planTraining({ actionId: a.actionId, user: w.LINE })
            );
            const byPerson = await refused(() =>
                IDP().planTraining({ actionId: a.actionId, user: w.PERSON, dueOn: '2027-01-10' })
            );
            await IDP().planTraining({
                actionId: a.actionId,
                user: w.LINE,
                dueOn: '2027-01-10',
                place: 'Training room B',
                plannedHours: '7',
            });
            const row = await db.get(
                'SELECT due_on, place, estimated_hours FROM idp_actions WHERE id = ?',
                [a.actionId]
            );
            return { start, noDate, byPerson, row };
        });
        expect(out.start && out.start.code).toBe('IDP_NOT_ACTIVE');
        expect(out.noDate && out.noDate.code).toBe('IDP_TRAINING_DATE');
        expect(out.byPerson && out.byPerson.code).toBe('IDP_OWN_PLAN');
        expect(out.row.place).toBe('Training room B');
        expect(Number(out.row.estimatedHours)).toBe(7);
    });
});

suite('proposals: the person proposes, the line decides', () => {
    test('accept creates the action (and a draft plan when none is open); decline needs a reason', async () => {
        const out = await inRolledBackTx(db, async () => {
            const w = await loopWorld();
            const p1 = await IDP().proposeAction({
                user: w.PERSON,
                type: 'mentoring',
                skillId: w.S1,
                text: 'Pair with a senior colleague for a month',
            });
            const dup = await IDP().proposeAction({
                user: w.PERSON,
                type: 'mentoring',
                skillId: w.S1,
                text: 'Pair with a senior colleague for a month',
            });
            const pending = await IDP().pendingProposalsFor(w.LINE);
            const pendingAbove = await IDP().pendingProposalsFor(w.ABOVE);
            const own = await refused(() =>
                IDP().decideProposal({
                    proposalId: p1.proposalId,
                    user: w.PERSON,
                    decision: 'accept',
                })
            );
            const acc = await IDP().decideProposal({
                proposalId: p1.proposalId,
                user: w.LINE,
                decision: 'accept',
            });
            const plan = await db.get('SELECT status::text AS status FROM idp_plans WHERE id = ?', [
                acc.idpId,
            ]);
            const act = await db.get(
                `SELECT a.title, a.type::text AS type, l.skill_id FROM idp_actions a
                   LEFT JOIN action_skill_links l ON l.action_id = a.id WHERE a.id = ?`,
                [acc.actionId]
            );
            const twice = await refused(() =>
                IDP().decideProposal({
                    proposalId: p1.proposalId,
                    user: w.LINE,
                    decision: 'accept',
                })
            );
            const p2 = await IDP().proposeAction({
                user: w.PERSON,
                type: 'nonsense',
                text: 'A stretch assignment on the next project',
            });
            const noReason = await refused(() =>
                IDP().decideProposal({
                    proposalId: p2.proposalId,
                    user: w.LINE,
                    decision: 'decline',
                })
            );
            await IDP().decideProposal({
                proposalId: p2.proposalId,
                user: w.LINE,
                decision: 'decline',
                reason: 'Next quarter, once the project is staffed',
            });
            const mine = await require('../../src/services/DevelopmentLoopService').proposals(w.P);
            const admin = await refused(() => IDP().proposeAction({ user: w.VIEWER, text: 'x' }));
            return {
                w,
                p1,
                p2,
                dup,
                pending,
                pendingAbove,
                own,
                acc,
                plan,
                act,
                twice,
                noReason,
                mine,
                admin,
            };
        });
        expect(out.p1.routedTo).toBe('line');
        expect(out.dup).toMatchObject({ proposalId: out.p1.proposalId, duplicate: true });
        expect(out.pending.map((r) => Number(r.id))).toContain(out.p1.proposalId);
        expect(out.pendingAbove.map((r) => Number(r.id))).not.toContain(out.p1.proposalId);
        expect(out.own && out.own.code).toBe('IDP_OWN_PLAN');
        expect(out.plan.status).toBe('draft');
        expect(out.act).toMatchObject({
            title: 'Pair with a senior colleague for a month',
            type: 'mentoring',
        });
        expect(Number(out.act.skillId)).toBe(out.w.S1);
        expect(out.twice && out.twice.code).toBe('IDP_PROPOSAL_DECIDED');
        expect(out.noReason && out.noReason.code).toBe('IDP_REASON_REQUIRED');
        const byId = Object.fromEntries(out.mine.map((p) => [p.id, p]));
        expect(byId[out.p1.proposalId].status).toBe('accepted');
        expect(byId[out.p2.proposalId]).toMatchObject({
            status: 'declined',
            actionType: 'training',
            decisionReason: 'Next quarter, once the project is staffed',
        });
        expect(out.admin && out.admin.code).toBe('IDP_PROPOSAL_EMPLOYEE_ONLY');
        expect(notified.filter((n) => n.kind === 'idp.proposal_received')).toHaveLength(2);
        expect(notified.filter((n) => n.kind === 'idp.proposal_decided')).toHaveLength(2);
    });

    test('with no line, a proposal goes to HR', async () => {
        const out = await inRolledBackTx(db, async () => {
            const w = await loopWorld();
            const r = await IDP().proposeAction({
                user: { id: w.N2, userType: 'employee' },
                text: 'Learn the scheduling tool',
            });
            return r;
        });
        expect(out.routedTo).toBe('hr');
    });
});

suite('a plan is never signed empty; plans towards a target role; completion', () => {
    test('assertSignable refuses a plan without an action or with an undated objective', async () => {
        const out = await inRolledBackTx(db, async () => {
            const w = await loopWorld();
            const d = await db.get(
                "INSERT INTO idp_plans (employee_id, status) VALUES (?, 'draft') RETURNING id",
                [w.P]
            );
            const id = Number(d.id);
            const empty = await refused(() => IDP().assertSignable(id));
            await db.run(
                "INSERT INTO idp_objectives (idp_id, smart_text, priority, state) VALUES (?, 'Undated', 'medium', 'pending')",
                [id]
            );
            await db.run(
                "INSERT INTO idp_actions (idp_id, type, title, status) VALUES (?, 'training', 'One', 'pending')",
                [id]
            );
            const undated = await refused(() => IDP().assertSignable(id));
            await db.run('UPDATE idp_objectives SET due_on = CURRENT_DATE + 30 WHERE idp_id = ?', [
                id,
            ]);
            const ok = await IDP().assertSignable(id);
            return { empty, undated, ok };
        });
        expect(out.empty).toMatchObject({
            code: 'IDP_NOT_SIGNABLE',
            status: 409,
            missing: ['action'],
        });
        expect(out.undated).toMatchObject({ code: 'IDP_NOT_SIGNABLE', missing: ['due_date'] });
        expect(out.ok).toBe(true);
    });

    test('a plan towards a target role tags its objectives; an open plan is extended', async () => {
        const out = await inRolledBackTx(db, async () => {
            const w = await loopWorld();
            const created = await IDP().createManualPlan({
                employeeId: w.P,
                targetRoleId: w.T,
                locale: 'en',
                user: w.LINE,
            });
            const objs = await db.all(
                'SELECT skill_id, target_role_id FROM idp_objectives WHERE idp_id = ? ORDER BY skill_id',
                [created.idpId]
            );
            const plan = await db.get('SELECT target_role_id FROM idp_plans WHERE id = ?', [
                created.idpId,
            ]);
            const again = await IDP().createManualPlan({
                employeeId: w.P,
                targetRoleId: w.T,
                locale: 'en',
                user: w.LINE,
            });
            return { w, created, objs, plan, again };
        });
        // S1 (target level 4 > official 1) and S3 (never assessed) of the target role
        expect(out.objs.map((o) => Number(o.skillId)).sort()).toEqual(
            [out.w.S1, out.w.S3].sort((a, b) => a - b)
        );
        for (const o of out.objs) expect(Number(o.targetRoleId)).toBe(out.w.T);
        expect(Number(out.plan.targetRoleId)).toBe(out.w.T);
        expect(out.again).toMatchObject({ idpId: out.created.idpId, merged: true, objectives: 0 });
    });

    test('completing a plan records the skills at the required level and tells the person', async () => {
        const out = await inRolledBackTx(db, async () => {
            const w = await loopWorld();
            const idpId = await activePlan(w);
            const o = await IDP().addObjective({
                idpId,
                user: w.LINE,
                smartText: 'Reach level 3',
                skillId: w.S1,
                dueOn: '2027-01-01',
            });
            const seeded = await db.get('SELECT id FROM idp_actions WHERE objective_id = ?', [
                o.objectiveId,
            ]);
            const v = await IDP().validateAction({
                actionId: Number(seeded.id),
                user: w.LINE,
                observedLevel: 3,
            });
            await IDP().setObjectiveState({
                objectiveId: o.objectiveId,
                user: w.LINE,
                state: 'completed',
            });
            const done = await IDP().completePlan({ idpId, user: w.LINE });
            return { v, done };
        });
        expect(out.v.objectiveMet).toBe(true);
        expect(out.done).toMatchObject({
            completed: true,
            skillsTotal: 1,
            skillsMet: 1,
            skillsUnmeasured: 0,
        });
        expect(notified.some((n) => n.kind === 'idp.completed')).toBe(true);
    });
});

suite('the read side and the reminder of due actions', () => {
    test('actionStates and dueActions: only dated actions waiting on the person count', async () => {
        const out = await inRolledBackTx(db, async () => {
            const w = await loopWorld();
            const idpId = await activePlan(w);
            const mk = (title, due) =>
                IDP().addAction({ idpId, user: w.LINE, title, dueOn: due, skillId: w.S1 });
            const late = await mk('Late one', '2020-01-01');
            await mk('Undated', null);
            const reported = await mk('Reported', '2020-01-02');
            await IDP().reportActionDone({ actionId: reported.actionId, user: w.PERSON });
            const L = require('../../src/services/DevelopmentLoopService');
            const st = await L.actionStates(w.P);
            const due = await L.dueActions(w.P, { days: 7 });
            return { late, reported, st, due };
        });
        const by = Object.fromEntries(out.st.open.map((a) => [a.id, a.state]));
        expect(by[out.late.actionId]).toBe('overdue');
        expect(by[out.reported.actionId]).toBe('awaiting_validation');
        expect(out.st.awaitingValidation).toBe(1);
        expect(out.due).toMatchObject({ count: 1, overdue: 1, dueOn: '2020-01-01' });
    });
});
