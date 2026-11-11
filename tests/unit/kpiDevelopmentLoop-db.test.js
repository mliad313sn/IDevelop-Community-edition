'use strict';
/**
 * The development loop's indicators on the real schema (4.0.0 port, wave 4),
 * born on contract kpi-2. Invented people only, inside rolled-back transactions.
 *
 *   K13  the product's own evidence counts: an action the line validated with
 *        an observed level that became official is an uplift at once; a rise
 *        above the requirement is credited at the requirement (no uplift);
 *        a "cannot judge yet" validation is no uplift and no prior.
 *   K28  completions of a mapped course measured before and after; an LMS-less,
 *        course-less install is "not configured", never 0 %.
 *   K30  plans achieved / not achieved; hours never inferred: no entry is
 *        null ("not entered"), never 0.
 *   The new indicators belong to the development module.
 *
 * Runs on idevelop_test* / idevelop_fixtures; skipped otherwise.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { isTestDatabaseUrl } = require('../helpers/testDatabase');
const HAS_DB = isTestDatabaseUrl(process.env.DATABASE_URL || '');
const suite = HAS_DB ? describe : describe.skip;
jest.setTimeout(120000);

jest.mock('../../src/services/NotificationService', () => ({
    notify: async () => ({ inapp: 'ok' }),
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

const K = () => require('../../src/services/KpiService');
const IDP = () => require('../../src/services/IDPService');

/** n people on a role requiring S1 at 3, all supervised by M, each at level 1 (or `start`). */
async function team(n, { start = 1 } = {}) {
    const f = await seedFacts(db);
    const [S1] = f.SKILLS;
    const role = await db.get('INSERT INTO roles (name) VALUES (?) RETURNING id', [
        `KPI-LOOP-${STAMP}-${Math.random().toString(36).slice(2, 7)}`,
    ]);
    await db.run(
        `INSERT INTO role_skill_requirements (role_id, skill_id, required_level, is_critical)
         VALUES (?, ?, 3, false)`,
        [Number(role.id), S1]
    );
    let k = 0;
    const emp = async (sup) => {
        k += 1;
        const r = await db.get(
            `INSERT INTO employees (employee_number, first_name, last_name, site_id, department_id,
                                    service_id, role_id, supervisor_id, is_active)
             VALUES (?, 'Kpi', ?, ?, ?, ?, ?, ?, true) RETURNING id`,
            [
                `KL-${STAMP}-${Math.random().toString(36).slice(2, 8)}`,
                `Loop${k}`,
                f.ORG.siteId,
                f.ORG.departmentId,
                f.ORG.serviceId,
                Number(role.id),
                sup,
            ]
        );
        return Number(r.id);
    };
    const M = await emp(null);
    const people = [];
    for (let i = 0; i < n; i++) {
        const p = await emp(M);
        await db.run(
            `INSERT INTO skill_assessments (employee_id, skill_id, current_level, assessed_by, notes)
             VALUES (?, ?, ?, ?, 'kpi loop fixture')`,
            [p, S1, start, f.adminId]
        );
        people.push(p);
    }
    return { f, S1, M, people, LINE: { id: M, userType: 'manager', role: 'manager' } };
}

async function validatedAction(w, p, level) {
    const plan = await db.get(
        "INSERT INTO idp_plans (employee_id, status) VALUES (?, 'active') RETURNING id",
        [p]
    );
    const a = await IDP().addAction({
        idpId: Number(plan.id),
        user: w.LINE,
        title: 'Practise with a mentor',
        skillId: w.S1,
    });
    await IDP().validateAction({ actionId: a.actionId, user: w.LINE, observedLevel: level });
    return { idpId: Number(plan.id), actionId: a.actionId };
}

const scopeOf = (ids) => ({ system: true, employeeIds: ids });

suite('K13 counts the product’s own validated evidence', () => {
    test('validated observed levels are uplifts at once; a level above the requirement is credited at it', async () => {
        const out = await inRolledBackTx(db, async () => {
            const w = await team(6);
            for (const p of w.people.slice(0, 5)) await validatedAction(w, p, 3);
            const k13 = await K().k13Uplift(scopeOf(w.people.slice(0, 5)));
            // at the requirement already: 3 -> 4 is no credited gain
            const top = await team(1, { start: 3 });
            await validatedAction(top, top.people[0], 4);
            const k13top = await K().k13Uplift(scopeOf(top.people));
            // "cannot judge yet": evidence only, no level, no prior from the action
            const none = await team(1);
            await validatedAction(none, none.people[0], '');
            const k13none = await K().k13Uplift(scopeOf(none.people));
            return { k13, k13top, k13none };
        });
        expect(out.k13).toMatchObject({ numerator: 5, denominator: 5, value: 100, status: null });
        expect(out.k13.breakdown.sources.idp).toBe(5);
        expect(out.k13top.numerator).toBe(0);
        expect(out.k13top.denominator).toBe(1);
        // the evidence-only action keeps the prior read from history and no level after
        expect(out.k13none.numerator).toBe(0);
    });
});

suite('K28 the effect of online training', () => {
    test('measured before and after on a mapped course; never 0 when nothing can be measured', async () => {
        const out = await inRolledBackTx(db, async () => {
            const w = await team(5);
            const course = await db.get(
                `INSERT INTO lms_courses (provider, external_id, title) VALUES ('test', ?, 'Safe lifting')
                 RETURNING id`,
                [`K28-${STAMP}`]
            );
            const cid = Number(course.id);
            await db.run(
                'INSERT INTO course_skill_map (course_id, skill_id, level_delta) VALUES (?, ?, 2)',
                [cid, w.S1]
            );
            let i = 0;
            for (const p of w.people) {
                i += 1;
                await db.run(
                    `INSERT INTO lms_completions (provider, external_ref, employee_id, course_id, completed_at, raw)
                     VALUES ('test', ?, ?, ?, now() - interval '10 days', '{}'::jsonb)`,
                    [`K28-${STAMP}-${i}`, p, cid]
                );
            }
            // a validated level before the course for all, a higher one after it
            // for three of the five (history is append-only: dated rows)
            const hist = (p, from, to, days) =>
                db.run(
                    `INSERT INTO assessment_history (employee_id, skill_id, previous_level, new_level,
                                                     assessed_by, assessed_at, notes, source)
                     VALUES (?, ?, ?, ?, ?, now() - (?::int * interval '1 day'), 'kpi fixture', 'supervisor_review')`,
                    [p, w.S1, from, to, w.f.adminId, days]
                );
            for (const p of w.people) await hist(p, null, 1, 20);
            for (const p of w.people.slice(0, 3)) await hist(p, 1, 2, 5);
            const k28 = await K().k28LmsEffect(scopeOf(w.people));
            return { k28 };
        });
        // the fixture's own level (written now, after the course) is the "after" of the other two
        expect(out.k28.breakdown).toMatchObject({
            completions: 5,
            measured: 5,
            uplifted: 3,
            unmapped: 0,
        });
        expect(out.k28.value).toBe(60);
        expect(out.k28.status).toBeNull();
    });
});

suite('K30 plan outcomes and effort', () => {
    test('achieved and not achieved; hours never inferred', async () => {
        const out = await inRolledBackTx(db, async () => {
            const w = await team(6);
            for (const p of w.people.slice(0, 5)) {
                const { idpId } = await validatedAction(w, p, 3);
                await IDP().completePlan({ idpId, user: w.LINE });
            }
            const k30none = await K().k30PlanOutcomes(scopeOf(w.people));
            // one plan stopped with a reason: not achieved; one action with hours
            const p6 = w.people[5];
            const plan = await db.get(
                "INSERT INTO idp_plans (employee_id, status) VALUES (?, 'active') RETURNING id",
                [p6]
            );
            const a = await IDP().addAction({
                idpId: Number(plan.id),
                user: w.LINE,
                title: 'Course',
                plannedHours: '8',
            });
            await IDP().validateAction({ actionId: a.actionId, user: w.LINE, actualHours: '6.5' });
            await IDP().archivePlan({
                idpId: Number(plan.id),
                user: w.LINE,
                reason: 'Role changed',
            });
            const k30 = await K().k30PlanOutcomes(scopeOf(w.people));
            return { k30none, k30 };
        });
        expect(out.k30none.breakdown.idp).toMatchObject({ achieved: 5, notAchieved: 0 });
        expect(out.k30none.value).toBe(100);
        // nobody entered hours: "not entered", never 0
        expect(out.k30none.effort.plannedHours).toBeNull();
        expect(out.k30none.effort.doneHours).toBeNull();
        expect(out.k30none.effort.levelsPer100h).toBeNull();
        expect(out.k30none.effort.levelsValidated).toBe(5);
        expect(out.k30.breakdown.idp).toMatchObject({ achieved: 5, notAchieved: 1 });
        expect(out.k30.effort.plannedHours).toBe(8);
        expect(out.k30.effort.doneHours).toBe(6.5);
        expect(out.k30.effort.levelsPer100h).toBeNull(); // fewer than 5 people entered hours
    });
});

describe('the contract', () => {
    test('K28 and K30 belong to the development module, on contract kpi-2', () => {
        expect(K().CONTRACT_VERSION).toBe('kpi-2');
        expect(K().CONTRACTS.K28.module).toBe('development');
        expect(K().CONTRACTS.K30.module).toBe('development');
        expect(K().isAvailable('K30', { development: false })).toBe(false);
        expect(K().isAvailable('K28', { development: true })).toBe(true);
    });
});
