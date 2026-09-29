'use strict';
/**
 * WAVE 3 — the executive-overview cache.
 *
 * getExecutiveData fires seven view aggregates plus the provenance rollup per
 * call and is the hottest read in the product. Caching it is only safe if the
 * key IS the resolved RBAC scope: a cache that hands one site's numbers to
 * another site's director is a security defect, not a perf win.
 *
 * These tests lock down, in order of what would hurt most if it broke:
 *   1. two different scopes NEVER share an entry;
 *   2. an unknown filter dimension disables the cache instead of mis-keying it
 *      (fail closed — a future filter can never be silently dropped);
 *   3. the cached payload is IDENTICAL to the uncached one;
 *   4. a caller cannot mutate what the next caller in the same scope sees;
 *   5. invalidation: explicit, and fanned out from the ONE existing bust signal
 *      that assessment writes and imports already fire.
 */

const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(),
    inTransaction: jest.fn(() => false),
};
jest.mock('../../src/config/database', () => mockDb);

// The model is the thing we are counting calls to.
jest.mock('../../src/models/DashboardModel', () => ({
    getOverviewKPIs: jest.fn(),
    getReadinessByGroup: jest.fn(),
    getReadinessDistribution: jest.fn(),
    getRoleStaffing: jest.fn(),
    getReadinessTrend: jest.fn(),
    _buildFilterClause: jest.fn(() => ''),
}));

const DashboardModel = require('../../src/models/DashboardModel');
const DashboardService = require('../../src/services/DashboardService');
const { dashboardCache } = require('../../src/utils/ttlCache');

/** Make every model call return something that identifies the scope it saw. */
function primeModel() {
    DashboardModel.getOverviewKPIs.mockImplementation(async (f) => ({
        totalEmployees: (f.siteIds || ['org']).join(','),
        avgReadiness: 42.5,
    }));
    DashboardModel.getReadinessByGroup.mockImplementation(async () => [
        { group: 'x', readiness: 1 },
    ]);
    DashboardModel.getReadinessDistribution.mockImplementation(async () => [
        { band: 'high', n: 3 },
    ]);
    DashboardModel.getRoleStaffing.mockImplementation(async () => [{ roleId: 1 }]);
    DashboardModel.getReadinessTrend.mockImplementation(async () => ({
        current: { totalPoints: 10, empCount: 2 },
        history: [],
    }));
    // getAssessmentProvenance goes straight to db.get
    mockDb.get.mockResolvedValue({
        employeesTotal: 2,
        employeesAssessed: 1,
        employeesFullyAssessed: 0,
        expectedSkills: 20,
        assessedSkills: 5,
        neverAssessedSkills: 15,
        selfOnlySkills: 1,
        validatedSkills: 4,
        avgReadinessAssessedOnly: 61.5,
    });
    mockDb.all.mockResolvedValue([]);
}

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.inTransaction.mockReturnValue(false);
    primeModel();
    DashboardService.invalidate();
});

const kpiCalls = () => DashboardModel.getOverviewKPIs.mock.calls.length;

// ---------------------------------------------------------------------------
describe('scope isolation — the security property', () => {
    test('two different site scopes never share a cache entry', async () => {
        const a = await DashboardService.getExecutiveData({ siteIds: [11] });
        const b = await DashboardService.getExecutiveData({ siteIds: [19] });

        expect(a.kpis.totalEmployees).toBe('11');
        expect(b.kpis.totalEmployees).toBe('19');
        expect(kpiCalls()).toBe(2); // neither served the other
    });

    test('an org-wide (unfiltered) read never serves a scoped caller, or vice versa', async () => {
        const org = await DashboardService.getExecutiveData({});
        const site = await DashboardService.getExecutiveData({ siteIds: [11] });
        expect(org.kpis.totalEmployees).toBe('org');
        expect(site.kpis.totalEmployees).toBe('11');
        expect(kpiCalls()).toBe(2);
    });

    test('every scope dimension participates in the key', async () => {
        const scopes = [
            {},
            { siteName: 'Lakeside' },
            { departmentName: 'IT' },
            { serviceName: 'Ops' },
            { roleName: 'Foreman' },
            { domainName: 'HSE' },
            { siteIds: [1] },
            { departmentIds: [1] },
            { serviceIds: [1] },
            { employeeIds: [1] },
            { requiredOnly: true },
        ];
        for (const s of scopes) await DashboardService.getExecutiveData(s);
        // No two of these may collide.
        expect(kpiCalls()).toBe(scopes.length);
        expect(DashboardService._cacheSize()).toBe(scopes.length);
    });

    test('a manager scope and a superset of it are different entries', async () => {
        await DashboardService.getExecutiveData({ employeeIds: [1, 2] });
        await DashboardService.getExecutiveData({ employeeIds: [1, 2, 3] });
        expect(kpiCalls()).toBe(2);
    });

    test('id arrays are normalised: [2,1] and ["1","2"] are ONE scope, not two', async () => {
        await DashboardService.getExecutiveData({ siteIds: [2, 1] });
        await DashboardService.getExecutiveData({ siteIds: ['1', '2'] });
        expect(kpiCalls()).toBe(1);
    });

    test('a delimiter inside a filter VALUE cannot forge another scope', async () => {
        // A site literally named 'A|B' must not collide with {site:'A', dept:'B'}.
        await DashboardService.getExecutiveData({ siteName: 'A|B' });
        await DashboardService.getExecutiveData({ siteName: 'A', departmentName: 'B' });
        expect(kpiCalls()).toBe(2);
        expect(DashboardService._cacheSize()).toBe(2);
    });
});

// ---------------------------------------------------------------------------
describe('fail closed', () => {
    test('an unknown filter dimension DISABLES the cache instead of mis-keying it', async () => {
        // If a future filter is added to the model but not to SCOPE_FIELDS, the
        // two calls below differ in a dimension the key cannot see. The correct
        // behaviour is to recompute both, never to serve the first to the second.
        const a = await DashboardService.getExecutiveData({ siteIds: [11], countryId: 1 });
        const b = await DashboardService.getExecutiveData({ siteIds: [11], countryId: 2 });
        expect(kpiCalls()).toBe(2);
        expect(DashboardService._cacheSize()).toBe(0); // nothing was stored either
        expect(a.kpis.totalEmployees).toBe('11');
        expect(b.kpis.totalEmployees).toBe('11');
    });

    test('an EMPTY unknown dimension is harmless (absent scope, still cacheable)', async () => {
        await DashboardService.getExecutiveData({ siteIds: [11], countryId: null });
        await DashboardService.getExecutiveData({ siteIds: [11], countryId: undefined });
        expect(kpiCalls()).toBe(1);
    });

    test('reads inside a transaction bypass the cache (never publish uncommitted numbers)', async () => {
        mockDb.inTransaction.mockReturnValue(true);
        await DashboardService.getExecutiveData({ siteIds: [11] });
        await DashboardService.getExecutiveData({ siteIds: [11] });
        expect(kpiCalls()).toBe(2);
        expect(DashboardService._cacheSize()).toBe(0);
    });

    test('options.cache === false always bypasses', async () => {
        await DashboardService.getExecutiveData({ siteIds: [11] });
        await DashboardService.getExecutiveData({ siteIds: [11] }, { cache: false });
        expect(kpiCalls()).toBe(2);
    });
});

// ---------------------------------------------------------------------------
describe('the cached payload is the uncached payload', () => {
    test('deep-equal to a forced-uncached read, and the model ran once', async () => {
        const uncached = await DashboardService.getExecutiveData(
            { siteIds: [11] },
            { cache: false }
        );
        const before = kpiCalls();

        const first = await DashboardService.getExecutiveData({ siteIds: [11] });
        const second = await DashboardService.getExecutiveData({ siteIds: [11] });

        expect(first).toEqual(uncached);
        expect(second).toEqual(uncached);
        expect(kpiCalls()).toBe(before + 1); // one compute served both hits
    });

    test('provenance (Wave 2 coverage) survives the round trip intact', async () => {
        const hit = await DashboardService.getExecutiveData({ siteIds: [11] });
        const again = await DashboardService.getExecutiveData({ siteIds: [11] });
        expect(again.kpis.provenance).toEqual(hit.kpis.provenance);
        expect(again.kpis.provenance.avgReadinessAssessedOnly).toBe(61.5);
        expect(again.kpis.provenance.expectedSkills).toBe(20);
        expect(again.kpis.provenance.assessedSkills).toBe(5);
    });

    test('concurrent misses in one scope share ONE computation (no stampede)', async () => {
        const [a, b, c] = await Promise.all([
            DashboardService.getExecutiveData({ siteIds: [11] }),
            DashboardService.getExecutiveData({ siteIds: [11] }),
            DashboardService.getExecutiveData({ siteIds: [11] }),
        ]);
        expect(kpiCalls()).toBe(1);
        expect(b).toEqual(a);
        expect(c).toEqual(a);
    });

    test('a caller mutating its result cannot corrupt the next caller', async () => {
        const first = await DashboardService.getExecutiveData({ siteIds: [11] });
        first.kpis.avgReadiness = 999;
        first.kpis.provenance = null;
        first.distribution.push({ band: 'injected' });

        const second = await DashboardService.getExecutiveData({ siteIds: [11] });
        expect(second.kpis.avgReadiness).toBe(42.5);
        expect(second.kpis.provenance).not.toBeNull();
        expect(second.distribution).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
describe('invalidation', () => {
    test('invalidate() drops every scope', async () => {
        await DashboardService.getExecutiveData({ siteIds: [11] });
        await DashboardService.getExecutiveData({ siteIds: [19] });
        expect(DashboardService._cacheSize()).toBe(2);

        DashboardService.invalidate();
        expect(DashboardService._cacheSize()).toBe(0);

        await DashboardService.getExecutiveData({ siteIds: [11] });
        expect(kpiCalls()).toBe(3);
    });

    test('dashboardCache.bust() — the signal assessment writes and imports already fire — clears it too', async () => {
        // SkillAssessmentService and UnifiedJsonService call dashboardCache.bust()
        // after a write. There must be exactly ONE invalidation point, or a
        // validated level would keep reading as unvalidated for a whole TTL.
        await DashboardService.getExecutiveData({ siteIds: [11] });
        expect(DashboardService._cacheSize()).toBe(1);

        dashboardCache.bust();
        expect(DashboardService._cacheSize()).toBe(0);

        await DashboardService.getExecutiveData({ siteIds: [11] });
        expect(kpiCalls()).toBe(2);
    });

    test('a throwing bust hook can never fail the write that triggered it', () => {
        const { TtlCache } = require('../../src/utils/ttlCache');
        const c = new TtlCache(1000);
        c.set('k', 1);
        c.onBust(() => {
            throw new Error('boom');
        });
        expect(() => c.bust()).not.toThrow();
        expect(c.get('k')).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
describe('the compute path still works when a dependency fails', () => {
    test('a model error propagates rather than being cached as a result', async () => {
        DashboardModel.getOverviewKPIs.mockRejectedValueOnce(new Error('db down'));
        await expect(DashboardService.getExecutiveData({ siteIds: [11] })).rejects.toThrow();
        expect(DashboardService._cacheSize()).toBe(0);

        // and the next call recomputes cleanly
        const ok = await DashboardService.getExecutiveData({ siteIds: [11] });
        expect(ok.kpis.totalEmployees).toBe('11');
    });
});
