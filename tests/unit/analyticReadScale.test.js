'use strict';
/**
 * ANALYTIC READ PATH — scale pass.
 *
 * Everything here locks down a change that was made because a MEASUREMENT said
 * so (scripts/loadtest-readiness.js against idevelop seeded to 4 000 employees /
 * 173 691 requirement rows, entirely inside a rolled-back transaction):
 *
 *   * the dashboard's readiness join left the COVERAGE view unscoped, so a
 *     manager of 76 people paid for an organisation-wide aggregate on every
 *     read (2 156 ms / 1 970 550 buffers for a 76-person scope; 36 ms / 38 425
 *     once both ends of the join carry the scope);
 *   * getOverviewKPIs scanned that join TWICE in one statement;
 *   * a 45-skill assessment sheet busted the whole dashboard cache 45 times;
 *   * seeding a succession bench ran one query PER CANDIDATE — 4 000 sequential
 *     round-trips inside one HTTP request for a superadmin;
 *   * TtlCache evicted FIFO, so an entry being read every second was dropped as
 *     readily as one nobody had touched.
 *
 * The security property comes first, because it is the one that would hurt
 * most if it broke: two callers with DIFFERENT resolved RBAC scopes must never
 * share a cached payload.
 */

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

// ---------------------------------------------------------------------------
// shared mocks
// ---------------------------------------------------------------------------
const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(async (fn) => fn()),
    inTransaction: jest.fn(() => false),
};
jest.mock('../../src/config/database', () => mockDb);

jest.mock('../../src/models/DashboardModel', () => ({
    getOverviewKPIs: jest.fn(),
    getReadinessByGroup: jest.fn(),
    getReadinessDistribution: jest.fn(),
    getRoleStaffing: jest.fn(),
    getReadinessTrend: jest.fn(),
    _buildFilterClause: jest.fn(() => ''),
}));

const DashboardModelMock = require('../../src/models/DashboardModel');
const DashboardService = require('../../src/services/DashboardService');
const { TtlCache, dashboardCache } = require('../../src/utils/ttlCache');

function primeModel() {
    DashboardModelMock.getOverviewKPIs.mockImplementation(async (f) => ({
        // echo the scope so a leak is visible in the payload, not just in a counter
        scopeSeen: JSON.stringify(f.employeeIds || f.siteIds || 'org'),
    }));
    DashboardModelMock.getReadinessByGroup.mockResolvedValue([]);
    DashboardModelMock.getReadinessDistribution.mockResolvedValue([]);
    DashboardModelMock.getRoleStaffing.mockResolvedValue([]);
    DashboardModelMock.getReadinessTrend.mockResolvedValue({
        current: { totalPoints: 0, empCount: 0 },
        history: [],
    });
    mockDb.get.mockResolvedValue({ employeesTotal: 0, expectedSkills: 0, assessedSkills: 0 });
    mockDb.all.mockResolvedValue([]);
}

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.runTransaction.mockImplementation(async (fn) => fn());
    mockDb.inTransaction.mockReturnValue(false);
    primeModel();
    DashboardService.invalidate();
});

// ===========================================================================
// 1. THE SECURITY PROPERTY — resolved through the ONE real scope resolver
// ===========================================================================
describe('cache scope isolation, resolved via rbacScope.scopedEmployeeIds', () => {
    // scopedEmployeeIds is the single correct resolver for ANY userType, and it
    // is deliberately asymmetric: a manager/employee resolves through
    // EmployeeModel.findGovernedIds (their id is an EMPLOYEE id), a local admin
    // or viewer resolves through RBACService.getFilteredEmployees (an ADMIN id),
    // and a superadmin resolves to null = unrestricted. Feeding an admin id into
    // the employee path — or vice versa — would silently produce SOMEBODY
    // ELSE'S scope, which is exactly the mistake this test exists to catch.
    const GOVERNED = { 7: [101, 102, 103], 9: [201, 202] };
    const ADMIN_SCOPE = { 7: [901, 902] };

    // Stubs the two collaborators, resolves, then UNREGISTERS them again — a
    // jest.doMock survives jest.resetModules(), so leaving them in place would
    // hand a stubbed EmployeeModel to every later describe in this file.
    const resolve = async (user) => {
        jest.resetModules();
        jest.doMock('../../src/models/EmployeeModel', () => ({
            findGovernedIds: jest.fn(async (id) => GOVERNED[id] || []),
        }));
        jest.doMock('../../src/services/RBACService', () => ({
            getFilteredEmployees: jest.fn(async (u) =>
                (ADMIN_SCOPE[u.id] || []).map((id) => ({ id }))
            ),
        }));
        try {
            const { scopedEmployeeIds } = require('../../src/utils/rbacScope');
            return await scopedEmployeeIds(user);
        } finally {
            jest.dontMock('../../src/models/EmployeeModel');
            jest.dontMock('../../src/services/RBACService');
            jest.resetModules();
        }
    };

    test('two managers with different sub-trees never share a cache entry', async () => {
        const a = await resolve({ userType: 'manager', id: 7 });
        const b = await resolve({ userType: 'manager', id: 9 });
        expect(a).toEqual([101, 102, 103]);
        expect(b).toEqual([201, 202]);

        const ra = await DashboardService.getExecutiveData({ employeeIds: a });
        const rb = await DashboardService.getExecutiveData({ employeeIds: b });

        expect(ra.kpis.scopeSeen).toBe(JSON.stringify(a));
        expect(rb.kpis.scopeSeen).toBe(JSON.stringify(b));
        // Neither call was served the other's payload.
        expect(DashboardModelMock.getOverviewKPIs).toHaveBeenCalledTimes(2);
        expect(DashboardService._cacheSize()).toBe(2);
    });

    test('a MANAGER id and an ADMIN id that happen to be equal are different scopes', async () => {
        const asManager = await resolve({ userType: 'manager', id: 7 });
        const asAdmin = await resolve({ userType: 'admin', role: 'localadmin', id: 7 });
        expect(asManager).toEqual([101, 102, 103]);
        expect(asAdmin).toEqual([901, 902]);

        await DashboardService.getExecutiveData({ employeeIds: asManager });
        await DashboardService.getExecutiveData({ employeeIds: asAdmin });
        expect(DashboardModelMock.getOverviewKPIs).toHaveBeenCalledTimes(2);
    });

    test('an unrestricted superadmin read never serves a scoped caller', async () => {
        const su = await resolve({ userType: 'admin', role: 'superadmin', id: 1 });
        expect(su).toBeNull(); // unrestricted → no employeeIds filter at all

        const org = await DashboardService.getExecutiveData({});
        const mgr = await DashboardService.getExecutiveData({ employeeIds: [101, 102, 103] });
        expect(org.kpis.scopeSeen).toBe('"org"');
        expect(mgr.kpis.scopeSeen).toBe(JSON.stringify([101, 102, 103]));
        expect(DashboardModelMock.getOverviewKPIs).toHaveBeenCalledTimes(2);
    });

    test('a caller with NO visible employees gets its own entry, never the org one', async () => {
        const nobody = await resolve({ userType: 'manager', id: 4242 });
        expect(nobody).toEqual([]);
        // An empty scope must not normalise to "no filter" — rbac.js forces -1.
        await DashboardService.getExecutiveData({ employeeIds: [-1] });
        await DashboardService.getExecutiveData({});
        expect(DashboardModelMock.getOverviewKPIs).toHaveBeenCalledTimes(2);
    });

    test('the same scope IS reused — otherwise the cache would be pointless', async () => {
        const a = await resolve({ userType: 'manager', id: 7 });
        await DashboardService.getExecutiveData({ employeeIds: a });
        await DashboardService.getExecutiveData({ employeeIds: [...a].reverse() });
        expect(DashboardModelMock.getOverviewKPIs).toHaveBeenCalledTimes(1);
    });
});

// ===========================================================================
// 2. TtlCache — recency-aware eviction, unchanged staleness bound
// ===========================================================================
describe('TtlCache eviction', () => {
    test('evicts the LEAST RECENTLY USED entry, not the oldest inserted', () => {
        const c = new TtlCache(60_000, 3);
        c.set('a', 1);
        c.set('b', 2);
        c.set('c', 3);
        expect(c.get('a')).toBe(1); // 'a' is now the most recently used
        c.set('d', 4); // must evict 'b' (LRU), not 'a' (FIFO)
        expect(c.get('a')).toBe(1);
        expect(c.get('b')).toBeUndefined();
        expect(c.get('c')).toBe(3);
        expect(c.get('d')).toBe(4);
    });

    test('a hit does NOT extend the TTL — staleness stays bounded by write time', () => {
        jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));
        const c = new TtlCache(1000, 10);
        c.set('k', 'v');
        jest.advanceTimersByTime(900);
        expect(c.get('k')).toBe('v'); // a hit, which re-inserts for recency
        jest.advanceTimersByTime(200); // 1100 ms since the WRITE
        expect(c.get('k')).toBeUndefined();
        jest.useRealTimers();
    });

    test('never exceeds maxEntries', () => {
        const c = new TtlCache(60_000, 5);
        for (let i = 0; i < 50; i++) c.set(`k${i}`, i);
        expect(c.map.size).toBeLessThanOrEqual(5);
    });

    test('the shipped dashboard cache is sized past a single dashboard load', () => {
        // 17 distinct endpoints per load; 500 slots was saturated by ~30
        // concurrent users, at which point every new user evicted an entry
        // somebody else was actively reading.
        expect(dashboardCache.maxEntries).toBeGreaterThanOrEqual(2000);
    });
});

// ===========================================================================
// 3. The SQL shapes the measurements are about
// ===========================================================================
describe('DashboardModel query shapes', () => {
    let RealModel;
    beforeAll(() => {
        jest.resetModules();
        jest.doMock('../../src/config/database', () => mockDb);
        RealModel = jest.requireActual('../../src/models/DashboardModel');
    });

    const captureAll = async (fn) => {
        mockDb.all.mockResolvedValue([]);
        mockDb.get.mockResolvedValue({ total: 0 });
        await fn();
        return [
            ...mockDb.all.mock.calls.map((c) => c[0]),
            ...mockDb.get.mock.calls.map((c) => c[0]),
        ];
    };

    test('the coverage join carries the scope columns, for any alias pair', () => {
        for (const [e, c] of [
            ['e', 'c'],
            ['e2', 'c2'],
        ]) {
            const from = RealModel._readinessFrom(e, c);
            expect(from).toMatch(new RegExp(`${c}\\.employeeId = ${e}\\.employeeId`));
            for (const col of [
                'siteId',
                'departmentId',
                'serviceId',
                'roleId',
                'siteName',
                'departmentName',
                'serviceName',
                'roleName',
            ]) {
                expect(from).toContain(`AND ${c}.${col} = ${e}.${col}`);
            }
        }
    });

    test('getOverviewKPIs scans the readiness join ONCE, not twice', async () => {
        const sqls = await captureAll(() => RealModel.getOverviewKPIs({ siteIds: [11] }));
        const sql = sqls.find((s) => /rolesAtRisk/i.test(s));
        expect(sql).toBeDefined();
        // Count SCANS, not mentions: strip `--` comments first. The guard is about
        // the query touching each view once; a comment that names a view (e.g.
        // explaining where critical_met comes from) is not a second scan, and
        // counting raw text made this fail on documentation alone.
        const executable = sql.replace(/--[^\n]*/g, '');
        const joins = executable.match(/v_employee_assessment_coverage/g) || [];
        expect(joins).toHaveLength(1);
        expect(executable.match(/v_employee_readiness/g) || []).toHaveLength(1);
        // and rolesAtRisk still aggregates over the single CTE scan. The
        // DEFINITION changed (is_role_ready — ready for the whole role — rather
        // than a >= 80 score on whatever was measured, which made a
        // barely-measured role look staffed); the scan shape this test guards
        // did not.
        expect(sql).toMatch(/HAVING SUM\(CASE WHEN is_role_ready = 1 THEN 1 ELSE 0 END\) <= 1/);
    });

    test('getOverviewKPIs binds the scope params ONCE (they were duplicated for the second scan)', async () => {
        mockDb.get.mockResolvedValue({});
        await RealModel.getOverviewKPIs({ siteIds: [11, 12] });
        const params = mockDb.get.mock.calls.at(-1)[1];
        expect(params).toEqual([11, 12]);
    });

    test('getEmployeeList COUNT does not join the coverage aggregate', async () => {
        const sqls = await captureAll(() =>
            RealModel.getEmployeeList(
                { siteIds: [11] },
                { page: 1, pageSize: 25, sortBy: 'readiness', sortDir: 'desc' }
            )
        );
        const countSql = sqls.find((s) => /COUNT\(\*\) as total/i.test(s));
        expect(countSql).toBeDefined();
        expect(countSql).not.toMatch(/v_employee_assessment_coverage/);
    });

    test('getEmployeeList paging is deterministic — the sort has a tie-break', async () => {
        const sqls = await captureAll(() =>
            RealModel.getEmployeeList(
                {},
                { page: 2, pageSize: 25, sortBy: 'readiness', sortDir: 'desc' }
            )
        );
        const pageSql = sqls.find((s) => /LIMIT \? OFFSET \?/.test(s));
        expect(pageSql).toMatch(
            /ORDER BY c\.readiness_assessed_only DESC NULLS LAST, e\.employeeId ASC/
        );
    });

    test('search and supervisor filters read the view that actually has those columns', async () => {
        const sqls = await captureAll(() =>
            RealModel.getEmployeeList(
                {},
                {
                    search: 'ab',
                    supervisorId: 3,
                    page: 1,
                    pageSize: 10,
                    sortBy: 'name',
                    sortDir: 'asc',
                }
            )
        );
        const pageSql = sqls.find((s) => /LIMIT \? OFFSET \?/.test(s));
        // v_employee_readiness has NO employee_number and NO supervisor_id;
        // reading them off `e` made both filters a hard 500.
        expect(pageSql).toContain('d.employeeNumber ILIKE ?');
        expect(pageSql).toContain('d.supervisorId = ?');
        expect(pageSql).not.toMatch(/\be\.employeeNumber\b/);
        expect(pageSql).not.toMatch(/\be\.supervisorId\b/);
    });
});

// ===========================================================================
// 4. Invalidation is coalesced, and happens AFTER the commit
// ===========================================================================
describe('assessment writes invalidate the dashboard cache once per sheet', () => {
    let SkillAssessmentService;
    let bustSpy;

    beforeEach(() => {
        jest.resetModules();
        jest.doMock('../../src/config/database', () => mockDb);
        jest.doMock('../../src/models/SkillAssessmentModel', () => ({
            findByEmployeeIdAndSkillId: jest.fn(async () => ({ currentLevel: 1 })),
            upsert: jest.fn(async (a) => ({ id: a.skillId, ...a })),
        }));
        jest.doMock('../../src/services/LogService', () => ({ log: jest.fn() }));
        const ttl = require('../../src/utils/ttlCache');
        bustSpy = jest.spyOn(ttl.dashboardCache, 'bust');
        SkillAssessmentService = require('../../src/services/SkillAssessmentService');
    });

    test('a 45-skill sheet busts ONCE, not 45 times', async () => {
        const sheet = Array.from({ length: 45 }, (_, i) => ({ skillId: i + 1, currentLevel: 3 }));
        await SkillAssessmentService.bulkUpdateAssessments(10, sheet, 1, null);
        expect(bustSpy).toHaveBeenCalledTimes(1);
    });

    test('the bust happens AFTER the transaction, not inside it', async () => {
        const order = [];
        mockDb.runTransaction.mockImplementation(async (fn) => {
            order.push('tx:start');
            const r = await fn();
            order.push('tx:commit');
            return r;
        });
        bustSpy.mockImplementation(() => order.push('bust'));
        await SkillAssessmentService.bulkUpdateAssessments(
            10,
            [{ skillId: 1, currentLevel: 2 }],
            1,
            null
        );
        expect(order).toEqual(['tx:start', 'tx:commit', 'bust']);
    });

    test('a SINGLE assessment write still busts immediately (default unchanged)', async () => {
        await SkillAssessmentService.updateAssessment(10, 1, 3, 1, null, null);
        expect(bustSpy).toHaveBeenCalledTimes(1);
    });
});

// ===========================================================================
// 5. Succession bench seeding is set-based
// ===========================================================================
describe('ContinuityService.seedSuccessors', () => {
    let ContinuityService;
    beforeEach(() => {
        jest.resetModules();
        jest.doMock('../../src/config/database', () => mockDb);
        ContinuityService = require('../../src/services/ContinuityService');
    });

    /** 3 candidates x 2 required skills, one of them lapsed for candidate 3. */
    const rows = [
        { employeeId: 1, skillId: 10, skillName: 'A', required: 4, current: 4 },
        { employeeId: 1, skillId: 11, skillName: 'B', required: 4, current: 4 },
        { employeeId: 2, skillId: 10, skillName: 'A', required: 4, current: 2 },
        { employeeId: 2, skillId: 11, skillName: 'B', required: 4, current: 0 },
        { employeeId: 3, skillId: 10, skillName: 'A', required: 4, current: 4 },
        { employeeId: 3, skillId: 11, skillName: 'B', required: 4, current: 0 },
    ];

    test('ONE query for the whole candidate pool, however many candidates', async () => {
        mockDb.get.mockResolvedValue({ positionRoleId: 5, incumbentEmployeeId: 9999 });
        mockDb.all.mockResolvedValue(rows);
        mockDb.run.mockResolvedValue({});

        const pool = Array.from({ length: 400 }, (_, i) => i + 1);
        await ContinuityService.seedSuccessors(1, pool, { floorPct: 0, limit: 3 });

        // The defect being locked out: one readinessForRole per candidate.
        expect(mockDb.all).toHaveBeenCalledTimes(1);
        const [sql, params] = mockDb.all.mock.calls[0];
        expect(sql).toMatch(/unnest\(\?::bigint\[\]\)/);
        expect(Array.isArray(params[0])).toBe(true);
        expect(params[0]).toHaveLength(400);
        // the full department-designed requirement list, not a sample
        expect(sql).toMatch(/rsr\.required_level > 0/);
        expect(sql).not.toMatch(/\bLIMIT\b/i);
    });

    test('scores match the per-candidate points formula, and honour the floor', async () => {
        mockDb.get.mockResolvedValue({ positionRoleId: 5, incumbentEmployeeId: 99 });
        mockDb.all.mockResolvedValue(rows);
        const inserted = [];
        mockDb.run.mockImplementation(async (_sql, p) => {
            inserted.push(p);
        });

        await ContinuityService.seedSuccessors(1, [1, 2, 3], { floorPct: 50, limit: 10 });

        // 1 → 8/8 = 100 %, 2 → 2/8 = 25 % (below the floor), 3 → 4/8 = 50 %
        const ranked = inserted.map((p) => ({ empId: p[1], rank: p[3] }));
        expect(ranked).toEqual([
            { empId: 1, rank: 1 },
            { empId: 3, rank: 2 },
        ]);
    });

    test('the incumbent is never benched against their own position', async () => {
        mockDb.get.mockResolvedValue({ positionRoleId: 5, incumbentEmployeeId: 2 });
        mockDb.all.mockResolvedValue(rows);
        mockDb.run.mockResolvedValue({});
        await ContinuityService.seedSuccessors(1, [1, 2, 3], { floorPct: 0 });
        expect(mockDb.all.mock.calls[0][1][0]).toEqual([1, 3]);
    });
});

// ===========================================================================
// 6. Per-request RBAC id resolution: constant SQL template, array parameter
// ===========================================================================
describe('EmployeeModel.findGovernedIds', () => {
    let EmployeeModel;
    beforeEach(() => {
        jest.resetModules();
        jest.doMock('../../src/config/database', () => mockDb);
        EmployeeModel = require('../../src/models/EmployeeModel');
    });

    test('binds ONE array per relationship instead of N placeholders', async () => {
        mockDb.all
            .mockResolvedValueOnce([{ id: 2 }, { id: 3 }])
            .mockResolvedValueOnce([{ id: 4 }])
            .mockResolvedValueOnce([]);
        const ids = await EmployeeModel.findGovernedIds(1);
        expect(ids).toEqual([2, 3, 4]);

        const templates = new Set(mockDb.all.mock.calls.map((c) => c[0]));
        // Same string on every BFS level — the driver's translation memo can hit
        // and PostgreSQL can reuse the plan.
        expect(templates.size).toBe(1);
        const [sql, params] = mockDb.all.mock.calls[1];
        // Still ONE bound array per relationship (the point of this test), and
        // the manager branch now carries `manager_type = 'employee'`: manager_id
        // is polymorphic and the employee/admin id spaces overlap, so without the
        // discriminator this traversal handed an admin's people to the employee
        // who happened to share that number. See uat3-governed-ids-manager-type.
        expect(sql).toMatch(
            /supervisor_id = ANY\(\?\) OR \(manager_id = ANY\(\?\) AND manager_type = 'employee'\)/
        );
        expect(params).toEqual([
            [2, 3],
            [2, 3],
        ]);
    });

    test('terminates on a reporting cycle', async () => {
        mockDb.all
            .mockResolvedValueOnce([{ id: 2 }])
            .mockResolvedValueOnce([{ id: 1 }]) // 1 governs 2, 2 governs 1
            .mockResolvedValueOnce([{ id: 2 }]) // already seen → frontier empties
            .mockResolvedValue([]);
        await expect(EmployeeModel.findGovernedIds(1)).resolves.toEqual([2, 1]);
    });
});

// ===========================================================================
// 7. Migration 81 contract
// ===========================================================================
describe('migration 81 — readiness scope pushdown', () => {
    const DIR = path.join(__dirname, '..', '..', 'db', 'postgres');
    const FILE = path.join(DIR, '81_readiness_scope_pushdown.sql');
    const sql = fs.readFileSync(FILE, 'utf8');
    const code = sql.replace(/--[^\n]*/g, ''); // assert on executable SQL only

    test('is transactional, idempotent and stamps schema_meta', () => {
        expect(code).toMatch(/^\s*BEGIN;/);
        expect(code.trim()).toMatch(/COMMIT;$/);
        expect(code).toMatch(/CREATE OR REPLACE VIEW v_employee_readiness/);
        expect(code).toMatch(
            /INSERT INTO schema_meta\(key, value\) VALUES \('81_readiness_scope_pushdown'/
        );
        expect(code).toMatch(/ON CONFLICT \(key\) DO UPDATE/);
    });

    test('81 does not collide with another migration number', () => {
        const others = fs
            .readdirSync(DIR)
            .filter((f) => /^\d+_.*\.sql$/.test(f) && !/_down\.sql$/i.test(f))
            .filter((f) => f !== '81_readiness_scope_pushdown.sql')
            .map((f) => Number(f.split('_')[0]));
        expect(others).not.toContain(81);
    });

    test('never DROPs the view (dependants would go with it) and never materialises it', () => {
        expect(code).not.toMatch(/DROP\s+VIEW/i);
        expect(code).not.toMatch(/MATERIALIZED\s+VIEW/i);
        expect(code).not.toMatch(/REFRESH\s+MATERIALIZED/i);
    });

    test('the join carries the scope columns — that IS the migration', () => {
        for (const col of [
            'site_id',
            'department_id',
            'service_id',
            'role_id',
            'site_name',
            'department_name',
            'service_name',
            'role_name',
        ]) {
            expect(code).toMatch(new RegExp(`AND\\s+g\\.${col}\\s*=\\s*e\\.${col}`));
        }
    });

    test('an unmeasured readiness stays NULL and is never coalesced to 0', () => {
        expect(code).toMatch(/ELSE NULL END AS readiness/);
        expect(code).not.toMatch(/COALESCE\s*\(\s*readiness/i);
    });

    test('the department-designed requirement count is asserted, not assumed', () => {
        expect(code).toMatch(/total_required/);
        expect(code).toMatch(/role_skill_requirements r[\s\S]*required_level > 0/);
        expect(code).toMatch(/no longer equals the department-designed skill count/);
    });

    test('the rewrite proves itself output-identical before it is allowed to stand', () => {
        expect(code).toMatch(/CREATE TEMP TABLE _m81_before/);
        expect(code).toMatch(/FULL JOIN v_employee_readiness/);
        expect(code).toMatch(/RAISE EXCEPTION/);
        // every published column is compared, not just a couple of totals
        for (const col of [
            'total_required',
            'skills_met',
            'total_gap_points',
            'total_critical',
            'critical_met',
            'points_gained',
            'points_required',
            'readiness',
            'is_role_ready',
            'assessed_required',
            'never_assessed_required',
            'unassessed_gap_points',
        ]) {
            expect(code).toMatch(new RegExp(`a\\.${col}\\s+IS DISTINCT FROM b\\.${col}`));
        }
    });
});

// ===========================================================================
// 8. The load-generation script may not run where it could do harm
// ===========================================================================
describe('scripts/loadtest-readiness.js guards', () => {
    const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'loadtest-readiness.js');
    const src = fs.readFileSync(SCRIPT, 'utf8');

    const run = (env) => {
        try {
            execFileSync(process.execPath, [SCRIPT, '--check'], {
                env: { ...process.env, ...env },
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
                timeout: 30_000,
            });
            return { code: 0, out: '' };
        } catch (e) {
            return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
        }
    };

    test('refuses to run when NODE_ENV=production', () => {
        const r = run({
            NODE_ENV: 'production',
            DATABASE_URL: 'postgres://u:p@localhost:5432/idevelop',
        });
        expect(r.code).toBe(1);
        expect(r.out).toMatch(/REFUSING TO RUN/);
        expect(r.out).toMatch(/NODE_ENV=production/);
    });

    test('refuses to run against a non-dev database name', () => {
        const r = run({
            NODE_ENV: 'development',
            DATABASE_URL: 'postgres://u:p@localhost:5432/idevelop',
        });
        expect(r.code).toBe(1);
        expect(r.out).toMatch(/REFUSING TO RUN/);
        expect(r.out).toMatch(/idevelop\b/);
    });

    test('the production guard runs before anything can open a pool', () => {
        const guardAt = src.indexOf("=== 'production'");
        const requireAt = src.indexOf("require('../src/config/database')");
        expect(guardAt).toBeGreaterThan(-1);
        expect(requireAt).toBeGreaterThan(guardAt);
    });

    test('everything it writes lives in one marked synthetic namespace it can delete', () => {
        expect(src).toMatch(/const SYNTHETIC_PREFIX = 'LT-'/);
        // seeded rows are all reachable from the prefixed employees
        expect(src).toMatch(/\$\{SYNTHETIC_PREFIX\}' \|\| lpad/);
        expect(src).toMatch(/async function cleanupSynthetic/);
        expect(src).toMatch(/DELETE FROM employees WHERE employee_number LIKE \$1/);
        // and the measured run itself can only end in a rollback
        expect(src).toMatch(/throw new Error\('__ROLLBACK__'\)/);
        expect(src).toMatch(/SYNTHETIC ROWS SURVIVED/);
    });
});
