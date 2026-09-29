'use strict';
/**
 * ZDB-3 / ZDB-6 — the Risk Index and the org-health cards never fabricate.
 *
 * Measured on the test base: 0 critical requirements assessed of 303 expected
 * → getWorkforceRiskIndex answered { score: 80, status: 'healthy', compliance:
 * 100 } (`kpis.criticalCompliance || 100`), beside a KPI strip that said
 * criticalCompliance = null. And with db.get/db.all rejecting 57014, five
 * dashboard reads answered zeros and empty lists instead of failing.
 *
 * House rule: an absence of measurement is never a number. Unmeasured axes
 * are NULL and NAMED; the composite covers the measured axes only; a database
 * error is an error.
 */
const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn(), runTransaction: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);

const DashboardModel = require('../../src/models/DashboardModel');

const KPIS_UNMEASURED_CRITICAL = {
    avgReadiness: 70,
    assessedCount: 40,
    totalEmployees: 78,
    assessedRequirements: 400,
    expectedRequirements: 800,
    criticalAssessed: 0,
    criticalCompliance: null,
    readyEmployees: 10,
};
const STAFFING = { totalRoles: 10, healthyRoles: 6 };
const FRESHNESS = { total: 78, fresh: 70 };

function wire({
    kpis = KPIS_UNMEASURED_CRITICAL,
    staffing = STAFFING,
    freshness = FRESHNESS,
} = {}) {
    mockDb.get.mockReset().mockImplementation(async (sql) => {
        if (/criticalCompliance/.test(sql)) return kpis;
        if (/healthyRoles/.test(sql)) return staffing;
        if (/as fresh\b/.test(sql)) return freshness;
        return {};
    });
    mockDb.all.mockReset().mockResolvedValue([]);
}

describe('getWorkforceRiskIndex — unmeasured compliance', () => {
    test('the SQL guards criticalCompliance on assessed critical requirements, like the KPI strip', async () => {
        wire();
        await DashboardModel.getWorkforceRiskIndex({});
        const sql = String(mockDb.get.mock.calls[0][0]);
        expect(sql).toMatch(/SUM\(COALESCE\(c\.critical_assessed,\s*0\)\)\s+as criticalAssessed/);
        expect(sql).toMatch(
            /CASE WHEN SUM\(COALESCE\(c\.critical_assessed,\s*0\)\)\s*>\s*0[\s\S]*?END as criticalCompliance/
        );
    });

    test('zero assessed critical requirements → compliance NULL, named, not 100', async () => {
        wire();
        const r = await DashboardModel.getWorkforceRiskIndex({});
        expect(r.breakdown.compliance).toEqual({ score: null, weight: 25, measured: false });
        expect(r.unmeasured).toEqual(['compliance']);
        expect(r.measured).toBe(true);
        // composite over the measured axes only: readiness 70·25 + coverage 50·15 + staffing 60·15 + freshness ~89.7·20, / 75
        const expected = Math.round((70 * 25 + 50 * 15 + 60 * 15 + (70 / 78) * 100 * 20) / 75);
        expect(r.score).toBe(expected);
        expect(r.score).not.toBe(80);
    });

    test('a measured 0 % compliance stays 0, never 100', async () => {
        wire({
            kpis: { ...KPIS_UNMEASURED_CRITICAL, criticalAssessed: 12, criticalCompliance: 0 },
        });
        const r = await DashboardModel.getWorkforceRiskIndex({});
        expect(r.breakdown.compliance).toEqual({ score: 0, weight: 25, measured: true });
        expect(r.unmeasured).toEqual([]);
    });

    test('no role → staffing unmeasured, not 100; nobody assessed → readiness unmeasured, not 0', async () => {
        wire({
            kpis: { ...KPIS_UNMEASURED_CRITICAL, assessedCount: 0, avgReadiness: null },
            staffing: { totalRoles: 0, healthyRoles: 0 },
        });
        const r = await DashboardModel.getWorkforceRiskIndex({});
        expect(r.breakdown.staffing.score).toBeNull();
        expect(r.breakdown.readiness.score).toBeNull();
        expect(r.unmeasured.sort()).toEqual(['compliance', 'readiness', 'staffing']);
    });

    test('nothing measured at all → score null / unknown, not 0', async () => {
        wire({
            kpis: {
                avgReadiness: null,
                assessedCount: 0,
                expectedRequirements: 0,
                criticalAssessed: 0,
                criticalCompliance: null,
            },
            staffing: { totalRoles: 0 },
            freshness: { total: 0 },
        });
        const r = await DashboardModel.getWorkforceRiskIndex({});
        expect(r).toMatchObject({ score: null, status: 'unknown', measured: false });
        expect(r.unmeasured).toHaveLength(5);
    });
});

describe('a database error is an error, never zeros', () => {
    const timeout = () => {
        const e = new Error('canceling statement due to statement timeout');
        e.code = '57014';
        return e;
    };
    beforeEach(() => {
        mockDb.get.mockReset().mockRejectedValue(timeout());
        mockDb.all.mockReset().mockRejectedValue(timeout());
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    test.each([
        'getWorkforceRiskIndex',
        'getOrgHealthMetrics',
        'getStaleAssessments',
        'getTeamExperts',
        'getCriticalRolesDetail',
    ])('%s rethrows', async (m) => {
        await expect(DashboardModel[m]({})).rejects.toMatchObject({ code: '57014' });
    });
});

describe('getOrgHealthMetrics — unmeasured is NULL', () => {
    test('no roster, no requirement, no role → nulls, not 0 %', async () => {
        mockDb.get.mockReset().mockImplementation(async (sql) => {
            if (/avgBenchDepth/.test(sql)) return { avgBenchDepth: null };
            if (/neverAssessed/.test(sql)) return { total: 0, freshCount: 0, neverAssessed: 0 };
            if (/totalRequired/.test(sql)) return { totalRequired: 0, assessed: 0 };
            return {};
        });
        mockDb.all.mockReset().mockResolvedValue([]);
        const out = await DashboardModel.getOrgHealthMetrics({});
        expect(out.benchDepth).toBeNull();
        expect(out.assessmentFreshness).toBeNull();
        expect(out.skillCoverage).toBeNull();
        expect(out.neverAssessedCount).toBe(0);
    });

    test('measured values are numbers', async () => {
        mockDb.get.mockReset().mockImplementation(async (sql) => {
            if (/avgBenchDepth/.test(sql)) return { avgBenchDepth: '1.6' };
            if (/neverAssessed/.test(sql)) return { total: 78, freshCount: 73, neverAssessed: 5 };
            if (/totalRequired/.test(sql)) return { totalRequired: 800, assessed: 592 };
            return {};
        });
        mockDb.all.mockReset().mockResolvedValue([]);
        const out = await DashboardModel.getOrgHealthMetrics({});
        expect(out).toMatchObject({
            benchDepth: 1.6,
            assessmentFreshness: 94,
            skillCoverage: 74,
            neverAssessedCount: 5,
        });
    });
});
