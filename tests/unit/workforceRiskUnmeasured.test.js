'use strict';

/**
 * The Workforce Risk gauge painted "never measured" as a red 0/critical.
 *
 * Model (N6): getWorkforceRiskIndex's staffing axis counted never-measured
 * roles as unhealthy (qc 0 in the denominator) and getOrgHealthMetrics.benchDepth
 * averaged qc over them too — so Internal Audit (3 roles, 0 assessments) scored
 * staffing 0 and org staffing/benchDepth were depressed (28.1 vs 31.0, 1.56 vs
 * 1.72). freshness counted never-assessed people as stale (0 %). Both axes now
 * exclude the unmeasured basis and yield null.
 *
 * Renderer (N1/N2/N3): renderRiskGauge did `score || 0` (a null scope printed a
 * big red 0), the breakdown bars sent a null axis to the red branch with
 * width:null% and the literal text "null", and neither surface disclosed that a
 * composite covered only some of the axes. Now: em dash for a null score, grey
 * empty bar + em dash for a null axis, and an "N of M dimensions not measured"
 * caveat.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { isFixturesDatabaseUrl } = require('../helpers/testDatabase');
// Needs a POPULATED database (several sites, assessed people, reviews): runs
// only against an opt-in fixture database — see CONTRIBUTING.md.
const HAS_DB = isFixturesDatabaseUrl(process.env.DATABASE_URL);
const suite = HAS_DB ? describe : describe.skip;
const db = HAS_DB ? require('../../src/config/database') : null;
const DashboardModel = HAS_DB ? require('../../src/models/DashboardModel') : null;

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

// ---- model -----------------------------------------------------------------
suite('N6 — unmeasured axes are excluded, not scored 0', () => {
    test('a fully-unmeasured department has null staffing, freshness and benchDepth', async () => {
        const isEmpty = await db.get(
            `SELECT COALESCE(SUM(assessed_skills),0)::int AS a
               FROM v_employee_assessment_coverage v
               JOIN employees e ON e.id = v.employee_id
               JOIN departments d ON d.id = e.department_id
              WHERE d.name = 'Internal Audit'`
        );
        if (!isEmpty || Number(isEmpty.a) !== 0) return; // fixture changed; do not mislead

        const wri = await DashboardModel.getWorkforceRiskIndex({
            departmentName: 'Internal Audit',
        });
        expect(wri.breakdown.staffing.score).toBeNull();
        expect(wri.breakdown.staffing.measured).toBe(false);
        expect(wri.breakdown.freshness.score).toBeNull();
        expect(wri.unmeasured).toEqual(expect.arrayContaining(['staffing', 'freshness']));

        const oh = await DashboardModel.getOrgHealthMetrics({ departmentName: 'Internal Audit' });
        expect(oh.benchDepth).toBeNull();
    });

    test('org staffing and benchDepth are computed over MEASURED roles only', async () => {
        const wri = await DashboardModel.getWorkforceRiskIndex({});
        // staffing = healthy measured roles / measured roles; must be a real %
        expect(wri.breakdown.staffing.measured).toBe(true);
        expect(Number(wri.breakdown.staffing.score)).toBeGreaterThan(0);

        // independent recompute over measured roles, is_role_ready
        const roles = await db.all(
            `SELECT e.role_name,
                    SUM(CASE WHEN e.is_role_ready = 1 THEN 1 ELSE 0 END)::int AS qc,
                    COUNT(c.readiness_assessed_only)::int AS mc
               FROM v_employee_readiness e
               LEFT JOIN v_employee_assessment_coverage c ON c.employee_id = e.employee_id
              GROUP BY e.role_name`
        );
        const measured = roles.filter((r) => Number(r.mc) > 0);
        const healthy = measured.filter((r) => Number(r.qc) > 1).length;
        const expected = Math.round((100 * healthy) / measured.length);
        expect(Number(wri.breakdown.staffing.score)).toBe(expected);
    });

    test('the composite still lists the axes it left out', async () => {
        const wri = await DashboardModel.getWorkforceRiskIndex({});
        // org has 0 critical assessed, so compliance is unmeasured
        expect(wri.unmeasured).toContain('compliance');
        expect(Number.isFinite(Number(wri.score))).toBe(true);
    });
});

// ---- renderer --------------------------------------------------------------
// the former dashboard page and public/js/dashboard.js were retired in wave 12 (D3); the server-rendered dashboard has its own tests (dash*.test.js)
