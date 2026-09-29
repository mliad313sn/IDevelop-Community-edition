'use strict';
/**
 * ONE READINESS NUMBER, EVERYWHERE, WITH COVERAGE ATTACHED (Wave 2).
 *
 * The same question used to have four answers:
 *   1. DashboardModel        — AVG(v_employee_readiness.readiness), plus a
 *                              "coverage" that was really COUNT(readiness IS
 *                              NOT NULL)/COUNT(*) and therefore pinned at
 *                              ~100 % on any real roster.
 *   2. ReportBuilderService  — v.readiness.
 *   3. api/v1 repository     — v.readiness, emitted to Power BI.
 *   4. NineBoxService        — count-of-met over skill_assessments alone, the
 *                              strictest of the four, feeding PIP/IDP triggers.
 *   (and ReadinessService read skill_assessments while the SQL views UNION
 *    approved self_assessments.)
 *
 * The canonical answer is migration 71's readiness_assessed_only, with
 * assessed/expected travelling beside it. These tests lock that in.
 *
 * DB is mocked; the live-data behaviour (identical numbers on every surface,
 * for a fully / partially / never assessed employee) is proved by the
 * rolled-back probe recorded in the delivery report.
 */

const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn(), runTransaction: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);

const DashboardModel = require('../../src/models/DashboardModel');
const ReadinessService = require('../../src/services/ReadinessService');

/** Last SQL string handed to db.get / db.all. */
const lastSql = (fn) => String(fn.mock.calls[fn.mock.calls.length - 1][0]);

beforeEach(() => {
    mockDb.get.mockReset().mockResolvedValue({});
    mockDb.all.mockReset().mockResolvedValue([]);
    mockDb.run.mockReset().mockResolvedValue({});
});

// ---------------------------------------------------------------------------
describe('DashboardModel — the KPI strip', () => {
    // NOTE ON SHAPE: getOverviewKPIs used to scan `v_employee_readiness LEFT
    // JOIN v_employee_assessment_coverage` TWICE in one statement (once for the
    // KPI strip, once inside the rolesAtRisk subquery — measured at exactly
    // double the cost at 4 000 employees). It now names that scan once in a CTE
    // and aggregates over it, so the outer SELECT reads CTE column names instead
    // of `c.`/`e.`-qualified ones. The assertions below therefore check BOTH
    // ends: that the CTE projects the canonical source column, and that the
    // outer aggregate consumes it. The property under test is unchanged.
    test('coverage is assessed/expected REQUIREMENTS, not "has a benchmark"', async () => {
        await DashboardModel.getOverviewKPIs({});
        const sql = lastSql(mockDb.get);
        // The old formula was 100 * COUNT(readiness IS NOT NULL) / COUNT(*).
        expect(sql).not.toMatch(
            /COUNT\(CASE WHEN readiness IS NOT NULL THEN 1 END\)[^)]*as assessmentCoverage/i
        );
        expect(sql).toMatch(/COALESCE\(c\.assessed_skills, 0\)\s+AS assessed_skills/);
        expect(sql).toMatch(/COALESCE\(c\.expected_skills, 0\)\s+AS expected_skills/);
        expect(sql).toMatch(
            /SUM\(assessed_skills\)\s*\/ NULLIF\(SUM\(expected_skills\), 0\), 1\) as assessmentCoverage/
        );
        // The denominators ship with the percentage.
        expect(sql).toMatch(/as assessedRequirements/);
        expect(sql).toMatch(/as expectedRequirements/);
    });

    // A SCORE and a VERDICT are different questions, and this test used to
    // conflate them.
    //
    // The Wave 2 rule — one readiness NUMBER everywhere, readiness_assessed_only,
    // with coverage travelling beside it — stands, and avgReadiness/criticalGap
    // still read it.
    //
    // But "how many people are role-ready" is not a score, it is a verdict, and
    // ReadinessService defines that verdict deliberately and explicitly:
    // readiness over ALL requirements AND every critical skill met, mirroring
    // v_employee_readiness.is_role_ready, with the comment "Deliberately NOT the
    // assessed-only figure: 100 % of the two skills somebody happened to be
    // rated on is not role-readiness."
    //
    // Counting the verdict from the score contradicted that. Live: 51 counted
    // ready against 48 genuinely ready, including one person at 15.4 % coverage
    // (2 of 13 skills, both met) scoring 100 % against a real 11.8 %. The
    // dashboard reported 8 ready where /reports/readiness reported 7.
    test('avgReadiness and criticalGap read the assessed-only SCORE', async () => {
        await DashboardModel.getOverviewKPIs({});
        const sql = lastSql(mockDb.get);
        expect(sql).toMatch(/c\.readiness_assessed_only\s+AS readiness_assessed_only/);
        expect(sql).toMatch(/ROUND\(AVG\(readiness_assessed_only\), 1\) as avgReadiness/);
        expect(sql).toMatch(
            /COUNT\(CASE WHEN readiness_assessed_only < 50 THEN 1 END\) as criticalGapCount/
        );
        // and NOT the all-requirements figure, which counts an unrated
        // requirement as a scored 0.
        expect(sql).not.toMatch(/ROUND\(AVG\(readiness_all\), 1\) as avgReadiness\b/);
    });

    test('roleReadyCount reads the canonical VERDICT, not the score', async () => {
        await DashboardModel.getOverviewKPIs({});
        const sql = lastSql(mockDb.get);
        expect(sql).toMatch(/e\.isRoleReady\s+AS is_role_ready/);
        expect(sql).toMatch(/COUNT\(CASE WHEN is_role_ready = 1 THEN 1 END\) as roleReadyCount/);
        expect(sql).not.toMatch(
            /COUNT\(CASE WHEN readiness_assessed_only >= 80 THEN 1 END\) as roleReadyCount/
        );
    });

    test('roles at risk uses the same verdict, so a barely-measured role is not "staffed"', async () => {
        await DashboardModel.getOverviewKPIs({});
        const sql = lastSql(mockDb.get);
        expect(sql).toMatch(/HAVING SUM\(CASE WHEN is_role_ready = 1 THEN 1 ELSE 0 END\) <= 1/);
    });

    test('the all-requirements figure survives under a DISTINCT label', async () => {
        await DashboardModel.getOverviewKPIs({});
        const sql = lastSql(mockDb.get);
        expect(sql).toMatch(/e\.readiness\s+AS readiness_all/);
        expect(sql).toMatch(/ROUND\(AVG\(readiness_all\), 1\) as avgReadinessAllRequirements/);
        expect(sql).toMatch(/as criticalGapCountAllRequirements/);
    });

    test('every readiness query joins the canonical coverage view', async () => {
        const calls = [
            () => DashboardModel.getOverviewKPIs({}),
            () => DashboardModel.getReadinessByGroup('site', {}),
            () => DashboardModel.getReadinessDistribution({}),
            () => DashboardModel.getRoleStaffing({}),
            () => DashboardModel.getCriticalRolesDetail({}),
        ];
        for (const call of calls) {
            mockDb.get.mockClear();
            mockDb.all.mockClear();
            await call();
            const sql = lastSql(mockDb.get.mock.calls.length ? mockDb.get : mockDb.all);
            expect(sql).toMatch(/LEFT JOIN v_employee_assessment_coverage/);
            expect(sql).toMatch(/readiness_assessed_only/);
        }
    });

    test('the distribution gives the unmeasured their own bucket', async () => {
        await DashboardModel.getReadinessDistribution({});
        const sql = lastSql(mockDb.all);
        expect(sql).toMatch(/WHEN c\.readiness_assessed_only IS NULL THEN 'never-assessed'/);
        // …and no longer silently drops them with WHERE readiness IS NOT NULL.
        expect(sql).not.toMatch(/WHERE readiness IS NOT NULL/);
    });

    test('org health coverage comes from the coverage view, not skill_assessments', async () => {
        mockDb.get.mockResolvedValue({ totalRequired: 96, assessed: 14, total: 0 });
        const out = await DashboardModel.getOrgHealthMetrics({});
        const sqls = mockDb.get.mock.calls.map((c) => String(c[0]));
        expect(sqls.some((s) => /FROM v_employee_assessment_coverage c/.test(s))).toBe(true);
        // 14 / 96 → 15 %, the same fraction the KPI strip prints.
        expect(out.skillCoverage).toBe(15);
        expect(out.assessedRequirements).toBe(14);
        expect(out.expectedRequirements).toBe(96);
    });
});

// ---------------------------------------------------------------------------
describe('ReadinessService — same source, same answer', () => {
    const req = (skillId, requiredLevel, isCritical = false) => ({
        skillId,
        requiredLevel,
        isCritical,
        skillName: 's' + skillId,
        domainName: 'd',
    });

    test('reads v_resolved_assessments, so approved self-assessments count', async () => {
        await ReadinessService._resolvedLevels([11, 12]);
        const sql = lastSql(mockDb.all);
        expect(sql).toMatch(/FROM v_resolved_assessments/);
        expect(mockDb.all.mock.calls[0][1]).toEqual([11, 12]);
    });

    test('an empty id list never issues a query', async () => {
        await expect(ReadinessService._resolvedLevels([])).resolves.toEqual([]);
        expect(mockDb.all).not.toHaveBeenCalled();
    });

    test('FULLY assessed: the canonical number equals the legacy one', () => {
        const reqs = [req(1, 4), req(2, 4), req(3, 2)];
        const assessed = [
            { skillId: 1, currentLevel: 4 },
            { skillId: 2, currentLevel: 2 },
            { skillId: 3, currentLevel: 2 },
        ];
        const r = ReadinessService._calculateSingleReadiness(1, reqs, assessed, 80);
        // 8 of 10 points either way — no regression for a complete record.
        expect(r.readinessPercent).toBe(80);
        expect(r.readinessAllRequirements).toBe(80);
        expect(r.coveragePercent).toBe(100);
        expect(r.assessedRequired).toBe(3);
    });

    test('PARTIALLY assessed: the unrated requirements are not a deficit', () => {
        const reqs = [req(1, 4), req(2, 4), req(3, 4), req(4, 4)];
        const assessed = [{ skillId: 1, currentLevel: 4 }]; // 1 of 4 rated, at level
        const r = ReadinessService._calculateSingleReadiness(1, reqs, assessed, 80);
        expect(r.readinessPercent).toBe(100); // measured: 4/4 points
        expect(r.readinessAllRequirements).toBe(25); // legacy: 4/16 points
        expect(r.coveragePercent).toBe(25);
        expect(r.neverAssessedRequired).toBe(3);
        // The FULL department-designed count is untouched.
        expect(r.totalRequired).toBe(4);
        // …and "ready" still needs the whole role measured.
        expect(r.isReady).toBe(false);
    });

    test('NEVER assessed: null, never an earned zero', () => {
        const r = ReadinessService._calculateSingleReadiness(1, [req(1, 4), req(2, 3)], [], 80);
        expect(r.readinessPercent).toBeNull();
        expect(r.coveragePercent).toBe(0);
        expect(r.assessedRequired).toBe(0);
        expect(r.totalRequired).toBe(2);
        expect(r.isReady).toBe(false);
    });

    test('a rated 0 IS assessed — it is a real measurement, not a blank', () => {
        const r = ReadinessService._calculateSingleReadiness(
            1,
            [req(1, 4)],
            [{ skillId: 1, currentLevel: 0 }],
            80
        );
        expect(r.assessedRequired).toBe(1);
        expect(r.readinessPercent).toBe(0); // an honest, earned zero
        expect(r.coveragePercent).toBe(100);
    });

    test('a lapsed certificate degrades the LEVEL, not the fact of measurement', () => {
        const lapsed = new Set(['1:1']);
        const r = ReadinessService._calculateSingleReadiness(
            1,
            [req(1, 4), req(2, 4)],
            [
                { skillId: 1, currentLevel: 4 },
                { skillId: 2, currentLevel: 4 },
            ],
            80,
            lapsed
        );
        expect(r.assessedRequired).toBe(2); // still measured
        expect(r.coveragePercent).toBe(100);
        expect(r.readinessPercent).toBe(50); // 4 of 8 points — the lapse bites
    });

    test('a role with no positive requirement is null, not 0 %', () => {
        const r = ReadinessService._calculateSingleReadiness(1, [req(1, 0)], [], 80);
        expect(r.totalRequired).toBe(0);
        expect(r.readinessPercent).toBeNull();
    });

    test('never-assessed gaps are excluded from the org gap analysis (migration 79 parity)', () => {
        const r = ReadinessService._calculateSingleReadiness(
            1,
            [req(1, 4), req(2, 4)],
            [{ skillId: 1, currentLevel: 1 }],
            80
        );
        const measured = r.gaps.filter((g) => g.isAssessed);
        const unmeasured = r.gaps.filter((g) => !g.isAssessed);
        expect(measured).toHaveLength(1);
        expect(measured[0].gap).toBe(3);
        expect(unmeasured).toHaveLength(1); // present, flagged, and NOT summed
    });
});

// ---------------------------------------------------------------------------
describe('api/v1 — Power BI gets the canonical number with its denominator', () => {
    const { ReadinessRepository } = require('../../src/api/v1/repository');

    test('the shared projection selects readiness_assessed_only + coverage', () => {
        const cols = ReadinessRepository.READINESS_COLS;
        expect(cols).toMatch(/c\.readiness_assessed_only AS readinessPercent/);
        expect(cols).not.toMatch(/v\.readiness\s+AS readinessPercent/);
        expect(cols).toMatch(/v\.readiness\s+AS readinessAllRequirementsPercent/);
        expect(cols).toMatch(/AS assessedSkills/);
        expect(cols).toMatch(/AS expectedSkills/);
        expect(cols).toMatch(/AS coveragePercent/);
        expect(cols).toMatch(/AS assessmentStatus/);
    });

    test('_mapReadiness carries coverage and keeps null as null', () => {
        const out = ReadinessRepository._mapReadiness({
            employeeId: '7',
            employeeName: 'A',
            readinessPercent: null,
            readinessAllRequirementsPercent: '0',
            isReady: 0,
            totalRequired: '44',
            skillsMet: '0',
            assessedSkills: '0',
            expectedSkills: '44',
            neverAssessedSkills: '44',
            coveragePercent: null,
            assessmentStatus: 'never_assessed',
        });
        expect(out.readinessPercent).toBeNull();
        expect(out.readinessAllRequirementsPercent).toBe(0);
        expect(out.assessedSkills).toBe(0);
        expect(out.expectedSkills).toBe(44);
        expect(out.assessmentStatus).toBe('never_assessed');
    });
});

// ---------------------------------------------------------------------------
describe('dept-digest — the manager gets the same number as the dashboard', () => {
    const digest = require('../../src/jobs/dept-digest');

    test('readiness comes from the coverage view, with the denominator attached', async () => {
        // 1st all() = matrix completion, 2nd = readiness, then reviews/pips/idp.
        mockDb.all
            .mockResolvedValueOnce([
                {
                    departmentId: 3,
                    siteName: 'Lakeside',
                    departmentName: 'IT',
                    headcount: 2,
                    completionPct: 11.4,
                },
            ])
            .mockResolvedValueOnce([
                {
                    departmentId: 3,
                    avgReadiness: 81.8,
                    measuredCount: 1,
                    scopedCount: 2,
                    assessedSkills: 5,
                    expectedSkills: 44,
                    coveragePct: 11.4,
                },
            ])
            .mockResolvedValue([]);

        const rows = await digest.__test.departmentStats([11, 12]);

        const readinessSql = String(mockDb.all.mock.calls[1][0]);
        expect(readinessSql).toMatch(/FROM v_employee_assessment_coverage/);
        expect(readinessSql).toMatch(/AVG\(readiness_assessed_only\)/);
        // The old AVG(readiness) over v_employee_readiness is gone.
        expect(readinessSql).not.toMatch(/AVG\(readiness\)/);

        expect(rows[0].avgReadiness).toBe(81.8);
        expect(rows[0].assessedSkills).toBe(5);
        expect(rows[0].expectedSkills).toBe(44);
        expect(rows[0].readinessCoveragePct).toBe(11.4);
    });

    test('a department nobody has measured renders "non mesuré", not 0 %', () => {
        const html = digest.__test.renderHtml(
            'Amina',
            [
                {
                    siteName: 'Lakeside',
                    departmentName: 'IT',
                    headcount: 6,
                    completionPct: null,
                    avgReadiness: null,
                    measuredCount: 0,
                    readinessCoveragePct: 0,
                    assessedSkills: 0,
                    expectedSkills: 264,
                    pendingReviews: 0,
                    openPips: 0,
                    openIdpActions: 0,
                },
            ],
            'mensuel / monthly'
        );
        expect(html).toMatch(/non mesuré/);
        expect(html).not.toMatch(/>0%</);
    });
});
