'use strict';

/**
 * Four arithmetic defects in DashboardModel, all of the same family: a figure
 * computed one way in one place and another way somewhere else, or a ratio
 * whose numerator and denominator describe different populations.
 *
 * 1. criticalCompliance mixed populations. critical_met counts critical
 *    requirements that were assessed AND met; total_critical counts ALL
 *    critical requirements. Latent today because the whole expression is
 *    guarded to NULL while nothing critical has been assessed — but proved by
 *    injecting ONE met critical assessment inside a rolled-back transaction:
 *       critical_met 1, critical_assessed 1, total_critical 303
 *       old formula 1/303 = 0.3 %      new formula 1/1 = 100 %
 *    and KpiSnapshotService would have persisted the 0.3 % into the trend.
 *
 * 2/3. "Roles at Risk" printed 23 in the table and 20 in the KPI beside it,
 *    because the table used `readiness_assessed_only >= 80` with no measured
 *    guard while the KPI used `is_role_ready` over measured roles only. The
 *    roles_at_risk CTE's own comment explains why is_role_ready is the right
 *    one: somebody rated on 2 of 13 skills, both met, scored 100 % and counted
 *    as role-ready at 15 % coverage. Three roles nobody has assessed were
 *    being reported as at-risk — "nobody capable" where the truth is "nobody
 *    measured"; they are counted separately as rolesUnmeasured.
 *
 * 4. Top impact gaps displayed SUM(gap) but ordered by
 *    SUM(gap) * COUNT(DISTINCT employee). SUM already spans employees, so
 *    headcount counted twice and the bars were visibly unsorted:
 *       before 42, 33, 33, 36, 28      after 42, 36, 33, 33, 28
 */

const path = require('path');
const fs = require('fs');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

// Needs a POPULATED database (several sites, assessed people, reviews): runs
// only against an opt-in fixture database — see CONTRIBUTING.md.
const HAS_DB = /idevelop_fixtures/.test(String(process.env.DATABASE_URL || ''));
const suite = HAS_DB ? describe : describe.skip;
const db = HAS_DB ? require('../../src/config/database') : null;
const DashboardModel = HAS_DB ? require('../../src/models/DashboardModel') : null;

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

suite('the KPI strip and the table beside it answer the same question', () => {
    let kpis = null;
    let detail = null;
    beforeAll(async () => {
        kpis = await DashboardModel.getOverviewKPIs({});
        detail = await DashboardModel.getCriticalRolesDetail({});
    });

    test('rolesAtRisk equals the number of rows the table draws', () => {
        expect(Number(kpis.rolesAtRisk)).toBe(detail.length);
    });

    test('a role nobody has assessed is not called at-risk', () => {
        // Every listed row must have at least one measured occupant, or the
        // page is saying "nobody capable" about people nobody looked at.
        for (const r of detail) expect(Number(r.measuredCount)).toBeGreaterThan(0);
        // and those roles are still reported, separately
        expect(Number(kpis.rolesUnmeasured)).toBeGreaterThanOrEqual(0);
    });

    test('"ready" has ONE definition across the page', async () => {
        // The adversarial re-audit proved the earlier version of this test was
        // vacuous: `sum(qualifiedCount) <= roleReadyCount` holds by construction
        // (the at-risk table only lists roles with <=1 qualified), so it could
        // never fail for the live defect — the DEPARTMENT-RANKING readyCount,
        // which counted readiness_assessed_only >= 80 and printed "Ready: 50"
        // for IT beside a KPI of 48. Assert the number the tooltip actually
        // shows: every dept's readyCount summed must equal the KPI.
        const oh = await DashboardModel.getOrgHealthMetrics({});
        const byDept = (oh.deptRanking || []).reduce((n, d) => n + Number(d.readyCount), 0);
        expect(byDept).toBe(Number(kpis.roleReadyCount));
    });

    test('the department-ranking readyCount is is_role_ready, not the >=80 score', () => {
        // Pin the definition in the source: the >=80 form here was the defect.
        const src = read('src/models/DashboardModel.js');
        const flat = src.replace(/\s+/g, ' ');
        expect(flat).toMatch(/COUNT\(CASE WHEN e\.isRoleReady = 1 THEN 1 END\) as readyCount/);
        expect(flat).not.toMatch(
            /COUNT\(CASE WHEN c\.readiness_assessed_only >= 80 THEN 1 END\) as readyCount/
        );
    });
});

suite('criticalCompliance divides measured by measured', () => {
    test('it is NULL while nothing critical has been assessed', async () => {
        const k = await DashboardModel.getOverviewKPIs({});
        const a = await db.get(
            'SELECT COALESCE(SUM(critical_assessed),0)::int AS n FROM v_employee_assessment_coverage'
        );
        if (Number(a.n) === 0) expect(k.criticalCompliance).toBeNull();
        else expect(k.criticalCompliance).not.toBeNull();
    });

    test('one met critical assessment reads 100 %, not 0.3 %', async () => {
        const before = await DashboardModel.getOverviewKPIs({});
        let observed = null;
        let totalCritical = null;
        try {
            await db.runTransaction(async () => {
                const r = await db.get(`SELECT rsr.skill_id, rsr.required_level, e.id AS emp
                       FROM role_skill_requirements rsr
                       JOIN employees e ON e.role_id = rsr.role_id AND e.is_active = true
                      WHERE rsr.is_critical = true AND rsr.required_level > 0
                        AND NOT EXISTS (SELECT 1 FROM skill_assessments sa
                                         WHERE sa.employee_id = e.id AND sa.skill_id = rsr.skill_id)
                      LIMIT 1`);
                if (!r) throw new Error('__ROLLBACK__'); // nothing to inject; skip
                const by = await db.get('SELECT id FROM admins ORDER BY id LIMIT 1');
                await db.run(
                    `INSERT INTO skill_assessments (employee_id, skill_id, current_level, assessed_by, assessed_at)
                     VALUES (?, ?, ?, ?, now())`,
                    [r.emp, r.skillId, r.requiredLevel, by.id]
                );
                const after = await DashboardModel.getOverviewKPIs({});
                const t = await db.get(
                    'SELECT SUM(total_critical)::int AS tot FROM v_employee_readiness'
                );
                observed = Number(after.criticalCompliance);
                totalCritical = Number(t.tot);
                throw new Error('__ROLLBACK__');
            });
        } catch (e) {
            if (!String(e.message).includes('__ROLLBACK__')) throw e;
        }

        expect(observed).toBe(100);
        // the old formula's answer, stated so the regression is unmistakable
        expect(Number((100 / totalCritical).toFixed(1))).toBeLessThan(1);

        // and nothing survived the rollback
        const back = await DashboardModel.getOverviewKPIs({});
        expect(back.criticalCompliance).toEqual(before.criticalCompliance);
    });
});

suite('the impact chart is sorted by the number it prints', () => {
    test('totalImpact is non-increasing down the list', async () => {
        const oh = await DashboardModel.getOrgHealthMetrics({});
        const gaps = oh.topImpactGaps || [];
        expect(gaps.length).toBeGreaterThan(1);
        const v = gaps.map((g) => Number(g.totalImpact));
        for (let i = 1; i < v.length; i++) expect(v[i - 1]).toBeGreaterThanOrEqual(v[i]);
    });

    test('the query still returns its rows at all (no comment may sit inside it)', async () => {
        // Any comment inside that statement — line OR block — makes the compat
        // layer snake-case g.skillName in the SELECT while leaving the GROUP BY
        // alone, and PG rejects the whole query. getOrgHealthMetrics swallows
        // the error and returns nothing, so the panel just empties. Assert the
        // rows come back rather than trusting that nobody adds a comment.
        const oh = await DashboardModel.getOrgHealthMetrics({});
        expect(Array.isArray(oh.topImpactGaps)).toBe(true);
        expect(oh.topImpactGaps.length).toBeGreaterThan(0);
        for (const g of oh.topImpactGaps) expect(g.skillName).toBeTruthy();
    });
});
