'use strict';
/**
 * The module indicators of the KPI module on the REAL test database: bench
 * strength K5 / K6 (talent), the self-versus-validated gap K12 and the
 * development uplift K13 (development), time to competence K14 (mobility,
 * not measured in this release), and computeAvailable at stages 1, 2 and 3.
 * Every test builds invented fixtures inside a rolled-back transaction.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { isTestDatabaseUrl } = require('../helpers/testDatabase');
const HAS_DB = isTestDatabaseUrl(process.env.DATABASE_URL);
const suite = HAS_DB ? describe : describe.skip;
jest.setTimeout(240000);

const W = require('../helpers/kpiWorld');
const M = require('../../src/config/modules');
const db = HAS_DB ? require('../../src/config/database') : null;
const K = HAS_DB ? require('../../src/services/KpiService') : null;

let F = null;
beforeAll(async () => {
    if (!HAS_DB) return;
    await db.connect();
    F = await W.seedFacts(db);
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

const tx = (fn) => W.inRolledBackTx(db, fn);

async function role(tag, reqs = []) {
    const r = await db.get('INSERT INTO roles (name) VALUES (?) RETURNING id', [
        `KPI-C-${tag}-${W.STAMP}`,
    ]);
    const id = Number(r.id);
    for (const [skill, lvl, crit] of reqs) {
        await db.run(
            `INSERT INTO role_skill_requirements (role_id, skill_id, required_level, is_critical)
             VALUES (?, ?, ?, ?)`,
            [id, skill, lvl, crit]
        );
    }
    return id;
}
async function emp(tag, roleId, extra = {}) {
    const r = await db.get(
        `INSERT INTO employees (employee_number, first_name, last_name, site_id, department_id,
                                service_id, role_id, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        [
            `KPI-C-${tag}-${W.STAMP}`,
            `KpiC${tag}`,
            `Fixture${W.STAMP}`,
            F.ORG.siteId,
            F.ORG.departmentId,
            F.ORG.serviceId,
            roleId,
            extra.active !== false,
        ]
    );
    return Number(r.id);
}
const assess = (e, s, lvl, validation = 'manager_validated') =>
    db.run(
        `INSERT INTO skill_assessments (employee_id, skill_id, current_level, assessed_by, notes, validation)
         VALUES (?, ?, ?, ?, 'KPI fixture', ?::skill_validation)`,
        [e, s, lvl, F.adminId, validation]
    );

function flagsFor(stage) {
    const on = new Set(M.PRESETS[stage]);
    const f = {};
    for (const k of M.MODULE_KEYS) f[k] = on.has(k);
    return f;
}

suite('module indicators on the real database', () => {
    test('K5 / K6: the figure is the drill; a leaver never covers; a not-ready successor never covers', async () => {
        const out = await tx(async () => {
            const [S1, S2] = F.SKILLS;
            const R = await role('R', [
                [S1, 2, true],
                [S2, 2, false],
            ]);
            const R2 = await role('R2', [[S1, 2, true]]);
            const R3 = await role('R3', [[S2, 1, false]]);
            await db.run(
                `INSERT INTO role_criticality (role_id, criticality_score) VALUES (?, 5), (?, 4), (?, 3)`,
                [R, R2, R3]
            );
            const inc = await emp('INC', R);
            const ready = await emp('READY', R3); // on another role, fully meets R
            await assess(ready, S1, 2);
            await assess(ready, S2, 2);
            const inc2 = await emp('INC2', R2);
            const leaver = await emp('LEFT', R3, { active: false }); // ready on R2 but a leaver
            await assess(leaver, S1, 2);
            const notReady = await emp('NR', R3);
            await assess(notReady, S1, 1);
            const plan = await db.get(
                'INSERT INTO succession_plans (position_role_id, incumbent_employee_id) VALUES (?, ?) RETURNING id',
                [R, inc]
            );
            await db.run('INSERT INTO successors (plan_id, candidate_employee_id) VALUES (?, ?)', [
                plan.id,
                ready,
            ]);
            const plan2 = await db.get(
                'INSERT INTO succession_plans (position_role_id, incumbent_employee_id) VALUES (?, ?) RETURNING id',
                [R2, inc2]
            );
            await db.run(
                'INSERT INTO successors (plan_id, candidate_employee_id) VALUES (?, ?), (?, ?)',
                [plan2.id, leaver, plan2.id, notReady]
            );
            const scope = { viewer: F.SUPER, employeeIds: [inc, ready, inc2, notReady, leaver] };
            return {
                R,
                R2,
                k5: await K.k5BenchStrength(scope),
                k6: await K.k6CriticalRolesWithoutReady(scope),
            };
        });
        const { R, R2, k5, k6 } = out;
        expect([k5.numerator, k5.denominator]).toEqual([1, 2]);
        expect(k5.status).toBe('small_n'); // 2 critical roles: counts, no %
        expect(k5.numeratorDrill).toEqual([R]);
        expect(k5.drill.sort()).toEqual([R, R2].sort());
        expect(k6.value).toBe(1);
        expect(k6.drill).toEqual([R2]);
        expect(k6.status).toBe('watch');
        expect(k6.breakdown).toMatchObject({ criticalRoles: 2, covered: 1, namedNotReady: 1 });
        // no successor NAME leaves the bench
        expect(JSON.stringify(k6)).not.toMatch(/Fixture/);
    });

    test('K5 / K6: no critical role designated gives not_configured, never a green 0', async () => {
        const out = await tx(async () => {
            const R = await role('NC', [[F.SKILLS[0], 1, false]]);
            const e = await emp('NC', R);
            const scope = { viewer: F.SUPER, employeeIds: [e] };
            return {
                k5: await K.k5BenchStrength(scope),
                k6: await K.k6CriticalRolesWithoutReady(scope),
            };
        });
        expect(out.k5.status).toBe('not_configured');
        expect(out.k6.status).toBe('not_configured');
        expect(out.k6.value).toBeNull();
    });

    test('K12: a level whose provenance is "self" is never a validated level; the figure is the drill', async () => {
        const out = await tx(async () => {
            const [S1] = F.SKILLS;
            const R = await role('K12', [[S1, 2, false]]);
            const ids = [];
            for (let i = 0; i < 6; i++) {
                const e = await emp('P' + i, R);
                ids.push(e);
                await db.run(
                    `INSERT INTO self_assessments (employee_id, skill_id, self_rated_level, status, workflow_state, submitted_at)
                     VALUES (?, ?, 3, 'submitted', 'submitted', now())`,
                    [e, S1]
                );
                // P0 has only a SELF-provenance official level: out of K12
                await assess(e, S1, 2, i === 0 ? 'self' : 'manager_validated');
            }
            return { ids, r: await K.k12Drift({ viewer: F.SUPER, employeeIds: ids }) };
        });
        const { ids, r } = out;
        expect(r.breakdown.pairs).toBe(5);
        expect(r.drill.map((p) => p.employeeId)).not.toContain(ids[0]);
        expect(r.value).toBe(1); // self 3 − validated 2
        expect(r.status).toBe('at_risk');
        expect(r.drill).toHaveLength(r.denominator);
        expect(r.breakdown.largeGapPairs).toBe(0);
    });

    test('K13: a prior measured level is required, a validated uplift within 180 days counts, an open window stays outside', async () => {
        const out = await tx(async () => {
            const S = F.SKILLS[2];
            const R = await role('K13', [[S, 3, false]]);
            const h = (e, lvl, daysAgo, source = 'manual') =>
                db.run(
                    `INSERT INTO assessment_history (employee_id, skill_id, previous_level, new_level, assessed_by, assessed_at, source)
                     VALUES (?, ?, NULL, ?, ?, now() - (?::int * interval '1 day'), ?)`,
                    [e, S, lvl, F.adminId, daysAgo, source]
                );
            const action = async (e, daysAgo) => {
                const p = await db.get(
                    "INSERT INTO idp_plans (employee_id, status) VALUES (?, 'active') RETURNING id",
                    [e]
                );
                const o = await db.get(
                    "INSERT INTO idp_objectives (idp_id, skill_id, smart_text) VALUES (?, ?, 'KPI') RETURNING id",
                    [p.id, S]
                );
                await db.run(
                    `INSERT INTO idp_actions (idp_id, objective_id, type, title, status, completed_at)
                     VALUES (?, ?, 'training', 'KPI', 'completed', now() - (?::int * interval '1 day'))`,
                    [p.id, o.id, daysAgo]
                );
            };
            const up = await emp('UP', R);
            await h(up, 1, 300);
            await action(up, 200);
            await h(up, 2, 150);
            const flat = await emp('FLAT', R);
            await h(flat, 1, 300);
            await action(flat, 200);
            const selfOnly = await emp('SELF', R);
            await h(selfOnly, 1, 300);
            await action(selfOnly, 200);
            await h(selfOnly, 3, 150, 'self_assessment'); // a self-assessment is never an uplift
            const first = await emp('FIRST', R);
            await action(first, 200);
            await h(first, 2, 150); // a first measurement after the action: never an uplift
            const open = await emp('OPEN', R);
            await h(open, 1, 300);
            await action(open, 10);
            const ids = [up, flat, selfOnly, first, open];
            return {
                r: await K.k13Uplift({ viewer: F.SUPER, employeeIds: ids }),
                up,
                flat,
                selfOnly,
                open,
            };
        });
        const { r, up, flat, selfOnly, open } = out;
        expect(r.numeratorDrill).toEqual([up]);
        expect(r.drill).toEqual([up, flat, selfOnly].sort((a, b) => a - b));
        expect(r.drillPending).toEqual([open]);
        expect(r.breakdown.noPriorActions).toBe(1);
        expect([r.numerator, r.denominator]).toEqual([1, 3]);
        expect(r.status).toBe('small_n'); // 3 people: counts only, never red
    });

    test('K14 is "not measured" in this release: no role start date is ever assumed', async () => {
        const r = await tx(async (q) => {
            const w = await W.world(db, F, q);
            return K.k14TimeToCompetence({ viewer: F.SUPER, employeeIds: W.fixtureIds(w) });
        });
        expect(r.status).toBe('not_measured');
        expect(r.notCaptured).toBe(true);
        expect(r.value).toBeNull();
    });

    test.each(['1', '2', '3'])(
        'stage %s: computeAvailable returns exactly the indicators of the modules that are on',
        async (stage) => {
            const flags = flagsFor(stage);
            const out = await tx(async (q) => {
                const w = await W.world(db, F, q);
                return K.computeAvailable(
                    { viewer: F.SUPER, employeeIds: W.fixtureIds(w) },
                    { flags }
                );
            });
            expect(out.map((r) => r.kpi)).toEqual(K.availableKpis(flags));
            for (const r of out) {
                const m = K.CONTRACTS[r.kpi].module;
                expect([r.kpi, m === null || flags[m] === true]).toEqual([r.kpi, true]);
            }
            const k16 = out.find((r) => r.kpi === 'K16');
            expect(Object.keys(k16.byType).includes('pip')).toBe(flags.development === true);
            expect(Object.keys(k16.byType).includes('coaching')).toBe(flags.development === true);
        }
    );
});
