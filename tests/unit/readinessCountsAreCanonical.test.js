'use strict';

/**
 * "Role-ready" must mean ready for the ROLE.
 *
 * DashboardModel counted readiness from `readiness_assessed_only` — the score
 * over whatever requirements happened to be measured. ReadinessService warns
 * against precisely that ("100 % of the two skills somebody happened to be
 * rated on is not role-readiness"), and v_employee_readiness.is_role_ready is
 * the canonical verdict: readiness over ALL requirements AND every critical
 * skill met.
 *
 * Consequence measured live:
 *
 *   v_employee_readiness is_role_ready : 48 (of 79)
 *   old assessed-only method           : 51
 *
 * The three people in the gap included one at 15.4 % coverage — rated on 2 of
 * 13 skills, both met — scoring 100 % against a real readiness of 11.8 %. The
 * dashboard said 8 ready where /reports/readiness said 7, for the same team.
 * "Roles at risk" was wrong the same way: a barely-measured role looked staffed.
 *
 * These tests EXECUTE the queries. They also stand in for a static guard that
 * cannot work: annotating the SELECT list of these queries with a `--` comment
 * makes `expandGroupBy` carry the comment into GROUP BY, commenting out the
 * HAVING that follows ("syntax error at or near HAVING"). A source-text probe
 * cannot reproduce that, because the grouping column is an interpolation — so
 * running the query is the only honest check.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

// Same convention as tests/unit/recent-features.test.js: these must EXECUTE the
// queries, so they skip cleanly where no database is configured rather than
// failing the suite (CI-safe).
const HAS_DB = !!process.env.DATABASE_URL;
const suite = HAS_DB ? describe : describe.skip;

const db = HAS_DB ? require('../../src/config/database') : null;
const DashboardModel = HAS_DB ? require('../../src/models/DashboardModel') : null;

let ready = null;

beforeAll(async () => {
    if (!HAS_DB) return;
    await db.connect();
    const row = await db.get(
        'SELECT COUNT(CASE WHEN is_role_ready = 1 THEN 1 END)::int AS ready FROM v_employee_readiness'
    );
    ready = row.ready;
});

// Release the pool, or jest never exits (same convention as recent-features).
afterAll(async () => {
    if (HAS_DB) await db.close();
});

suite('the KPI strip agrees with the canonical view', () => {
    test('roleReadyCount equals is_role_ready', async () => {
        const kpis = await DashboardModel.getOverviewKPIs({});
        expect(Number(kpis.roleReadyCount)).toBe(ready);
    });

    test('it is NOT the assessed-only count, which over-reports', async () => {
        const naive = await db.get(
            'SELECT COUNT(CASE WHEN readiness_assessed_only >= 80 THEN 1 END)::int AS n FROM v_employee_assessment_coverage'
        );
        const kpis = await DashboardModel.getOverviewKPIs({});
        // If these ever coincide the assertion above still holds; what must never
        // happen is the KPI tracking the naive figure when they differ.
        if (naive.n !== ready) expect(Number(kpis.roleReadyCount)).not.toBe(naive.n);
    });

    test('the coverage figures are still reported alongside, not replaced', async () => {
        const kpis = await DashboardModel.getOverviewKPIs({});
        expect(kpis).toHaveProperty('assessmentCoverage');
        expect(kpis).toHaveProperty('measuredEmployees');
        expect(kpis).toHaveProperty('avgReadinessAllRequirements');
    });
});

suite('the grouped breakdown agrees with the same view', () => {
    test.each(['site', 'department', 'service', 'role'])(
        'readyCount summed over %s equals is_role_ready',
        async (groupBy) => {
            const rows = await DashboardModel.getReadinessByGroup(groupBy, {});
            const total = rows.reduce((s, r) => s + Number(r.readyCount || 0), 0);
            expect(total).toBe(ready);
        }
    );

    test.each(['site', 'department', 'service', 'role'])(
        'grouping by %s executes — GROUP BY expansion is not corrupted',
        async (groupBy) => {
            // Guards the "syntax error at or near HAVING" failure mode directly:
            // a comment in this SELECT list is carried into GROUP BY by the
            // compat layer and comments out the HAVING.
            await expect(DashboardModel.getReadinessByGroup(groupBy, {})).resolves.toBeDefined();
        }
    );
});

suite('roles at risk uses the same definition', () => {
    // Committee (analytics lane): is_role_ready COALESCEs an unmeasured
    // requirement to level 0, so a role whose holders were simply never assessed
    // used to count as "at risk" — the whole Internal Audit department, with zero
    // requirements measured, was published in red as a staffing risk. A role with
    // no measured holder is now reported SEPARATELY as rolesUnmeasured, never
    // folded into the risk figure. The two together still equal the old count.
    test('it counts roles with at most one genuinely role-ready holder — among MEASURED roles', async () => {
        const kpis = await DashboardModel.getOverviewKPIs({});
        const expected = await db.get(`
            SELECT COUNT(*)::int AS n FROM (
                SELECT e.role_name
                  FROM v_employee_readiness e
                  LEFT JOIN v_employee_assessment_coverage c ON c.employee_id = e.employee_id
                 GROUP BY e.role_name
                HAVING SUM(CASE WHEN e.is_role_ready = 1 THEN 1 ELSE 0 END) <= 1
                   AND COUNT(c.readiness_assessed_only) > 0
            ) t`);
        expect(Number(kpis.rolesAtRisk)).toBe(expected.n);
    });

    test('roles with no measured holder are reported apart, and nothing is lost in the split', async () => {
        const kpis = await DashboardModel.getOverviewKPIs({});
        const legacy = await db.get(`
            SELECT COUNT(*)::int AS n FROM (
                SELECT role_name FROM v_employee_readiness
                 GROUP BY role_name
                HAVING SUM(CASE WHEN is_role_ready = 1 THEN 1 ELSE 0 END) <= 1
            ) t`);
        const unmeasured = await db.get(`
            SELECT COUNT(*)::int AS n FROM (
                SELECT e.role_name
                  FROM v_employee_readiness e
                  LEFT JOIN v_employee_assessment_coverage c ON c.employee_id = e.employee_id
                 GROUP BY e.role_name
                HAVING SUM(CASE WHEN e.is_role_ready = 1 THEN 1 ELSE 0 END) <= 1
                   AND COUNT(c.readiness_assessed_only) = 0
            ) t`);
        expect(Number(kpis.rolesUnmeasured)).toBe(unmeasured.n);
        expect(Number(kpis.rolesAtRisk) + Number(kpis.rolesUnmeasured)).toBe(legacy.n);
    });
});
