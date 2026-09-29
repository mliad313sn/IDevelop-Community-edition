'use strict';

/**
 * One page showed the same person against the same benchmark twice, 17 points
 * apart.
 *
 * `/benchmark/role/:id` has an occupant table above and a candidate table
 * below. Candidate fit is computed over the ASSESSED requirements — which was
 * itself a deliberate fix, and `getRoleCandidates`'s docstring names the
 * arithmetic it replaced. Occupant fit was left folding every never-assessed
 * requirement in as level 0, because `v_employee_skill_gaps` coalesces an
 * absent level to 0.
 *
 * Measured on the dev dataset, employee 158 against role 87 (63 requirements,
 * 51 assessed, 81 % coverage):
 *
 *   occupant table   74 %   all 63 requirements, 12 never-assessed as misses
 *   candidate rule   91 %   the 51 that were measured
 *   ReadinessService 91 %
 *   coverage view    91 %
 *   succession bench 91 %
 *
 * Four surfaces said 91 and the occupant row said 74. Worse, the occupant
 * list's colour bands (>= 80 green, >= 50 amber) were therefore being driven
 * by requirements nobody had measured, so an amber row meant "we have not
 * looked" as often as "this person is short".
 *
 * Both occupant paths — the per-occupant list and the role-level getFit
 * aggregate — now use measured-over-measured. Coverage is unchanged and still
 * travels alongside, so a high fit at low coverage is still readable as thin
 * evidence rather than strength.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

// Needs a POPULATED database (several sites, assessed people, reviews): runs
// only against an opt-in fixture database — see CONTRIBUTING.md.
const HAS_DB = /idevelop_fixtures/.test(String(process.env.DATABASE_URL || ''));
const suite = HAS_DB ? describe : describe.skip;
const db = HAS_DB ? require('../../src/config/database') : null;
const BenchmarkModel = HAS_DB ? require('../../src/models/BenchmarkModel') : null;
const ContinuityService = HAS_DB ? require('../../src/services/ContinuityService') : null;

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

suite('occupant fit agrees with every other reading of the same person', () => {
    const ROLE = 87;
    let occupants = null;
    beforeAll(async () => {
        const o = await BenchmarkModel.getRoleOccupants(ROLE);
        occupants = o.occupants || o;
    });

    test('the fixture we rely on still exists (guards against a vacuous suite)', async () => {
        expect(occupants.length).toBeGreaterThan(0);
        // At least one occupant must be PARTIALLY measured, or assessed-only
        // and all-requirements give the same answer and nothing is tested.
        const partial = await db.get(
            `SELECT COUNT(*)::int AS n FROM (
                 SELECT g.employee_id, COUNT(*) AS n, SUM(g.is_assessed) AS a
                   FROM v_employee_skill_gaps g
                  WHERE g.required_level > 0 AND g.role_id = ?
                  GROUP BY g.employee_id
             ) t WHERE t.a > 0 AND t.a < t.n`,
            [ROLE]
        );
        expect(Number(partial.n)).toBeGreaterThan(0);
    });

    test('each occupant fit matches the coverage view to rounding', async () => {
        for (const o of occupants) {
            const v = await db.get(
                'SELECT readiness_assessed_only AS r FROM v_employee_assessment_coverage WHERE employee_id = ?',
                [o.employeeId]
            );
            if (o.fit == null || v == null || v.r == null) continue;
            expect(Math.abs(Number(o.fit) - Number(v.r))).toBeLessThanOrEqual(1);
        }
    });

    test('and matches the succession bench for the same role', async () => {
        for (const o of occupants) {
            const c = await ContinuityService.readinessForRole(o.employeeId, ROLE);
            if (o.fit == null || c.pct == null) continue;
            expect(Math.abs(Number(o.fit) - Number(c.pct))).toBeLessThanOrEqual(1);
        }
    });

    test('the specific case the committee measured: 158 reads 91, not 74', async () => {
        const o = occupants.find((x) => Number(x.employeeId) === 158);
        expect(o).toBeTruthy();
        expect(Number(o.fit)).toBe(91);
    });

    test('coverage is untouched — the department-designed count is still the denominator there', () => {
        const o = occupants.find((x) => Number(x.employeeId) === 158);
        // 51 of 63 assessed. Coverage is still over the department-designed 63,
        // so a 91 % fit on 81 % coverage stays readable as thin evidence.
        expect(Number(o.reqCount)).toBe(63);
        expect(Number(o.coverage)).toBe(81);
    });
});

suite('the role-level aggregate uses the same rule', () => {
    test('getFit is measured-over-measured too', async () => {
        const rows = await BenchmarkModel.getFit({});
        const r = rows.find((x) => Number(x.roleId) === 87);
        expect(r).toBeTruthy();
        // The role's fit is an average of occupant fits, so it cannot sit
        // below the lowest of them.
        const o = await BenchmarkModel.getRoleOccupants(87);
        const list = (o.occupants || o).filter((x) => x.fit != null).map((x) => Number(x.fit));
        expect(Number(r.benchmarkFit)).toBeGreaterThanOrEqual(Math.min(...list) - 1);
        expect(Number(r.benchmarkFit)).toBeLessThanOrEqual(Math.max(...list) + 1);
    });

    test('a role nobody has assessed still reports NULL fit, not 0', async () => {
        const rows = await BenchmarkModel.getFit({});
        for (const r of rows.filter((x) => Number(x.coverage) === 0)) {
            expect(r.benchmarkFit).toBeNull();
            expect(r.criticalFit).toBeNull();
        }
    });
});
