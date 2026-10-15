'use strict';
/**
 * Reports module — the four defects that made it answer wrongly or emptily.
 *
 *  1. A manager got ZERO rows from every data source: scope was resolved from
 *     the ADMIN id-space (adminScopes.adminId) using the manager's EMPLOYEE id.
 *  2. "Never assessed" was rendered as an earned zero — the provenance views
 *     from migration 71 were never consumed.
 *  3. Text filters were case- AND accent-sensitive, so Lambért / Lindqvïst /
 *     Costé never matched anything typed without the accent.
 *  4. Two prebuilt templates pointed at a data source the server does not
 *     implement, so they could only ever render an error box.
 *
 * DB-free: the driver, the employee model and RBACService are mocked.
 */

const fs = require('fs');
const path = require('path');

jest.mock('../../src/config/database', () => ({
    all: jest.fn(async () => []),
    get: jest.fn(async () => null),
    run: jest.fn(async () => ({ changes: 0 })),
}));
jest.mock('../../src/models/EmployeeModel', () => ({ findGovernedIds: jest.fn() }));
jest.mock('../../src/services/RBACService', () => ({ getFilteredEmployees: jest.fn() }));
// The builder KPI strip reads the KPI module (its own suites prove the figures).
const mockKpi = {
    resolvePopulation: jest.fn(),
    k1RoleReady: jest.fn(),
    k2AvgReadiness: jest.fn(),
    k3Coverage: jest.fn(),
    k4CriticalCompliance: jest.fn(),
};
jest.mock('../../src/services/KpiService', () => mockKpi);

const db = require('../../src/config/database');
const EmployeeModel = require('../../src/models/EmployeeModel');
const RBACService = require('../../src/services/RBACService');
const ReportBuilderService = require('../../src/services/ReportBuilderService');
const ReportDataService = require('../../src/services/ReportDataService');

const MANAGER = { id: 137, userType: 'manager', role: 'manager' };
const LOCAL_ADMIN = { id: 4, userType: 'admin', role: 'localadmin' };
const SUPERADMIN = { id: 1, userType: 'admin', role: 'superadmin' };

describe('1. scope resolution uses the right id-space', () => {
    test('a manager is scoped by their governed employees — not by adminScopes', async () => {
        EmployeeModel.findGovernedIds.mockResolvedValue([11, 12, 13]);
        const f = await ReportBuilderService.getRBACFilter(MANAGER, 'e');

        expect(EmployeeModel.findGovernedIds).toHaveBeenCalledWith(137);
        expect(f.condition).toBe('e.id = ANY(?)');
        expect(f.params).toEqual([[11, 12, 13]]);
        // The regression: adminScopes must never be consulted for a manager.
        const adminScopeQueries = db.all.mock.calls.filter((c) =>
            /adminScopes/i.test(String(c[0]))
        );
        expect(adminScopeQueries).toHaveLength(0);
    });

    test('the readiness view is scoped on employee_id, not on e.id', async () => {
        EmployeeModel.findGovernedIds.mockResolvedValue([11]);
        const f = await ReportBuilderService.getRBACFilter(MANAGER, 'v', 'employee_id');
        expect(f.condition).toBe('v.employee_id = ANY(?)');
    });

    test('a local admin resolves through RBACService.getFilteredEmployees', async () => {
        RBACService.getFilteredEmployees.mockResolvedValue([{ id: 7 }, { id: 9 }]);
        const f = await ReportBuilderService.getRBACFilter(LOCAL_ADMIN, 'e');
        expect(RBACService.getFilteredEmployees).toHaveBeenCalledWith(LOCAL_ADMIN);
        expect(f.params).toEqual([[7, 9]]);
    });

    test('a super admin is unrestricted; an empty scope fails CLOSED', async () => {
        expect(await ReportBuilderService.getRBACFilter(SUPERADMIN, 'e')).toEqual({
            condition: '',
            params: [],
        });
        EmployeeModel.findGovernedIds.mockResolvedValue([]);
        expect(await ReportBuilderService.getRBACFilter(MANAGER, 'e')).toEqual({
            condition: '1=0',
            params: [],
        });
    });

    test('the section/chart query scopes a manager by employee_id too', async () => {
        EmployeeModel.findGovernedIds.mockResolvedValue([11, 12]);
        db.all.mockResolvedValue([]);
        await ReportDataService.getSectionData(
            {
                source: 'v_employee_details',
                dimension: 'site',
                metric: 'employeeCount',
                chartType: 'bar',
            },
            MANAGER
        );
        const sql = String(db.all.mock.calls[db.all.mock.calls.length - 1][0]);
        expect(sql).toMatch(/employee_id = ANY\(\?\)/);
        expect(sql).not.toMatch(/adminScopes/i);
    });
});

describe('2. never-assessed is not an earned zero', () => {
    test('the readiness export reads the provenance coverage view', async () => {
        EmployeeModel.findGovernedIds.mockResolvedValue([11]);
        const { query } = await ReportBuilderService.buildReadinessQuery(
            [
                'employeeName',
                'readinessPercent',
                'assessmentStatus',
                'assessedSkills',
                'expectedSkills',
            ],
            null,
            null,
            null,
            MANAGER
        );
        expect(query).toMatch(/v_employee_assessment_coverage/);
        // Wave 2 — ONE readiness number. readinessPercent IS
        // readiness_assessed_only, the same figure the dashboard, the API and
        // the digest publish. It is NULL (never 0) when nobody was ever
        // assessed, because the view returns NULL for an empty denominator.
        expect(query).toMatch(/c\.readiness_assessed_only AS readinessPercent/);
        // The all-requirements figure must NOT be exported under the plain
        // "Readiness %" name any more — that is the number that diverged from
        // the dashboard by up to 17 points for a partially assessed employee.
        expect(query).not.toMatch(/v\.readiness AS readinessPercent/);
        expect(query).toMatch(/never_assessed/);
    });

    test('the all-requirements figure survives under a DISTINCT label', async () => {
        EmployeeModel.findGovernedIds.mockResolvedValue([11]);
        const { query } = await ReportBuilderService.buildReadinessQuery(
            ['employeeName', 'readinessAllRequirements'],
            null,
            null,
            null,
            MANAGER
        );
        expect(query).toMatch(
            /CASE WHEN COALESCE\(c\.assessed_skills, 0\) = 0 THEN NULL ELSE v\.readiness END AS readinessAllRequirements/
        );
    });

    test('coverage ALWAYS travels with a readiness column, even unselected', async () => {
        EmployeeModel.findGovernedIds.mockResolvedValue([11]);
        const { query } = await ReportBuilderService.buildReadinessQuery(
            ['employeeName', 'readinessPercent'],
            null,
            null,
            null,
            MANAGER
        );
        // "62 %" must never leave this service without its denominator.
        expect(query).toMatch(/AS assessedSkills/);
        expect(query).toMatch(/AS expectedSkills/);
        expect(query).toMatch(/AS coveragePercent/);
        expect(query).toMatch(/AS assessmentStatus/);
    });

    test('coverage is NOT auto-added to a GROUPED report (PG strict GROUP BY)', async () => {
        EmployeeModel.findGovernedIds.mockResolvedValue([11]);
        const { query } = await ReportBuilderService.buildReadinessQuery(
            ['siteName', 'readinessPercent'],
            null,
            null,
            ['siteName'],
            MANAGER
        );
        expect(query).toMatch(/GROUP BY v\.site_name/);
        expect(query).not.toMatch(/AS assessedSkills/);
    });

    test('a report with no readiness column is left alone', async () => {
        EmployeeModel.findGovernedIds.mockResolvedValue([11]);
        const { query } = await ReportBuilderService.buildReadinessQuery(
            ['employeeName', 'siteName'],
            null,
            null,
            null,
            MANAGER
        );
        expect(query).not.toMatch(/AS coveragePercent/);
    });

    test('unknown readiness fields are dropped instead of emitting "undefined AS x"', async () => {
        EmployeeModel.findGovernedIds.mockResolvedValue([11]);
        const { query } = await ReportBuilderService.buildReadinessQuery(
            ['employeeName', 'notAField'],
            null,
            null,
            null,
            MANAGER
        );
        expect(query).not.toMatch(/undefined/);
    });

    test('the section query never coalesces an unmeasured aggregate to 0', async () => {
        EmployeeModel.findGovernedIds.mockResolvedValue([11]);
        db.all.mockResolvedValue([
            { label: 'Stonebridge', value: null },
            { label: 'Lakeside', value: 62.5 },
        ]);
        const out = await ReportDataService.getSectionData(
            {
                source: 'v_employee_readiness',
                dimension: 'site',
                metric: 'readinessPct',
                chartType: 'bar',
            },
            MANAGER
        );
        expect(out.data).toEqual([null, 62.5]);
    });

    test('a section where nothing was ever assessed is flagged, not drawn as zeros', async () => {
        EmployeeModel.findGovernedIds.mockResolvedValue([11]);
        db.all.mockResolvedValue([
            { label: 'Stonebridge', value: null },
            { label: 'Lakeside', value: null },
        ]);
        const out = await ReportDataService.getSectionData(
            {
                source: 'v_employee_readiness',
                dimension: 'site',
                metric: 'readinessPct',
                chartType: 'bar',
            },
            MANAGER
        );
        expect(out.unmeasured).toBe(true);
        expect(out.data).toEqual([null, null]);
    });

    test('a table carries the coverage denominator (assessed / expected)', async () => {
        EmployeeModel.findGovernedIds.mockResolvedValue([11]);
        db.all.mockResolvedValue([
            { label: 'Yann K.', value: 12, neverCt: 0, totalCt: 40 },
            { label: 'Ange A.', value: null, neverCt: 49, totalCt: 49 },
        ]);
        const out = await ReportDataService.getSectionData(
            {
                source: 'v_employee_skill_gaps',
                dimension: 'employee',
                metric: 'gap',
                aggregation: 'sum',
                chartType: 'table',
            },
            MANAGER,
            (k) => k
        );
        const covCol = out.columns[2];
        expect(out.columns).toHaveLength(3);
        expect(out.rows[0][covCol]).toBe('40 / 40');
        // The unmeasured person reads "never assessed", and their gap is NULL.
        expect(out.rows[1].gap).toBeNull();
        expect(String(out.rows[1][covCol])).toMatch(/never|assess/i);
    });

    test('the KPI strip reads the KPI module and publishes the coverage denominator', async () => {
        const ids = Array.from({ length: 16 }, (_, i) => i + 1);
        mockKpi.resolvePopulation.mockResolvedValue({ ids, rows: [], system: false });
        const unmeasured = { value: null, rawValue: null, status: 'not_measured' };
        mockKpi.k1RoleReady.mockResolvedValue({
            ...unmeasured,
            numerator: 0,
            denominator: 0,
            coverage: 0,
            breakdown: { ready: 0, notReady: 0, partial: 0, notAssessed: 16 },
        });
        mockKpi.k2AvgReadiness.mockResolvedValue({ ...unmeasured, denominator: 0 });
        mockKpi.k3Coverage.mockResolvedValue({
            value: 0,
            rawValue: 0,
            status: 'watch',
            numerator: 0,
            denominator: 195,
            breakdown: { assessedRequirements: 0, expectedRequirements: 195 },
        });
        mockKpi.k4CriticalCompliance.mockResolvedValue({ ...unmeasured, status: 'not_configured' });
        const out = await ReportDataService.getSectionData(
            {
                source: 'v_employee_readiness',
                dimension: 'site',
                metric: 'readinessPct',
                chartType: 'kpi',
                _lang: 'en',
            },
            MANAGER
        );
        expect(out.coverage).toEqual({
            assessed: 0,
            expected: 195,
            pct: 0,
            neverAssessedEmployees: 16,
            employees: 16,
        });
        // Nothing measured → "Not measured", never "0 %".
        expect(out.items.map((i) => i.key)).toEqual([
            'K1',
            'K2',
            'K3',
            'K4',
            'population',
            'partial',
            'notAssessed',
        ]);
        expect(out.items[0].display).toBe('Not measured');
        expect(out.items[3].display).toBe('Not configured');
        expect(out.items[2].display).toBe('0.0%'); // a measured 0 stays a 0
        expect(out.items.find((i) => i.key === 'notAssessed').display).toBe('16');
    });
});

describe('3. text filters are case- and accent-insensitive', () => {
    const F = (field, operator, value, type) =>
        ReportBuilderService.buildSingleFilter(field, { operator, value }, type);

    test.each(['equals', 'contains', 'starts_with', 'ends_with'])(
        'text operator %s matches case-insensitively (ILIKE, not LIKE/=)',
        (op) => {
            const { condition } = F('e.lastName', op, 'lambert', 'text');
            expect(condition).toMatch(/ILIKE/);
            expect(condition).not.toMatch(/(^|[^I])LIKE \?/);
        }
    );

    test('negations wrap the accent-insensitive comparison', () => {
        expect(F('e.lastName', 'not_equals', 'lambert', 'text').condition).toMatch(/^NOT \(/);
        expect(F('e.lastName', 'not_contains', 'lambert', 'text').condition).toMatch(/^NOT \(/);
    });

    test('numeric and date fields keep exact comparison — no text coercion', () => {
        expect(F('v.readiness', 'equals', 50, 'number').condition).toBe('v.readiness = ?');
        expect(F('v.readiness', 'greater_than', 50, 'number').condition).toBe('v.readiness > ?');
        expect(F('sa.assessedAt', 'before', '2026-01-01', 'date').condition).toBe(
            'sa.assessedAt < ?'
        );
    });

    test('every builder knows its own field types (so "text" is recognised)', () => {
        for (const src of [
            'employees',
            'assessments',
            'readiness',
            'skills',
            'roles',
            'organization',
        ]) {
            const types = ReportBuilderService.fieldTypesFor(src);
            expect(Object.keys(types).length).toBeGreaterThan(0);
        }
        expect(ReportBuilderService.fieldTypesFor('employees').lastName).toBe('text');
        expect(ReportBuilderService.fieldTypesFor('readiness').readinessPercent).toBe('number');
    });
});

describe('4. no prebuilt template can reference an unimplemented data source', () => {
    const implemented = Object.keys(ReportDataService.listSources());

    test('the 9-box source the templates use really exists server-side', () => {
        expect(implemented).toContain('nineBoxAssessments');
        const nb = ReportDataService.listSources().nineBoxAssessments;
        expect(nb.metrics).toEqual(expect.arrayContaining(['performanceScore', 'potentialScore']));
        expect(nb.dims).toEqual(expect.arrayContaining(['employee']));
    });

    test('every source named in public/js/report-builder.js is implemented', () => {
        const js = fs.readFileSync(
            path.join(__dirname, '..', '..', 'public', 'js', 'report-builder.js'),
            'utf8'
        );
        const named = [...js.matchAll(/source:\s*'([A-Za-z0-9_]+)'/g)].map((m) => m[1]);
        expect(named.length).toBeGreaterThan(10); // guard against a vacuous test
        const orphans = [...new Set(named)].filter((s) => !implemented.includes(s));
        expect(orphans).toEqual([]);
    });

    test('the provenance views from migration 71 are reportable sources', () => {
        expect(implemented).toContain('v_employee_assessment_coverage');
        expect(implemented).toContain('v_requirement_provenance');
        expect(ReportDataService.listSources().v_requirement_provenance.metrics).toEqual(
            expect.arrayContaining(['neverAssessedCount', 'selfOnlyCount', 'assessedCount'])
        );
    });
});

describe('5. filter dropdowns are clearance-scoped', () => {
    // No data ever leaked (a name filter is AND-ed with the RBAC predicate), but
    // a manager was offered sites/departments/services/roles outside their span;
    // ticking one silently produced an empty section, which reads as a broken
    // report. The lists now offer only values that can return rows.
    const sqlOf = () => String(db.all.mock.calls[db.all.mock.calls.length - 1][0]);
    const paramsOf = () => db.all.mock.calls[db.all.mock.calls.length - 1][1];

    beforeEach(() => {
        db.all.mockClear();
        db.all.mockResolvedValue([]);
    });

    test.each(['sites', 'departments', 'services', 'roles'])(
        'a manager only sees %s reachable from their governed employees',
        async (source) => {
            EmployeeModel.findGovernedIds.mockResolvedValue([11, 12, 13]);
            await ReportBuilderService.getReferenceData(source, MANAGER);
            expect(sqlOf()).toMatch(/emp\.id = ANY\(\?\)/);
            expect(paramsOf()).toEqual([[11, 12, 13]]);
        }
    );

    test('a local admin is scoped through RBACService, not adminScopes', async () => {
        RBACService.getFilteredEmployees.mockResolvedValue([{ id: 7 }, { id: 9 }]);
        await ReportBuilderService.getReferenceData('sites', LOCAL_ADMIN);
        expect(RBACService.getFilteredEmployees).toHaveBeenCalledWith(LOCAL_ADMIN);
        expect(paramsOf()).toEqual([[7, 9]]);
        expect(sqlOf()).not.toMatch(/adminScopes/i);
    });

    test('a super admin stays unrestricted — no scope predicate at all', async () => {
        await ReportBuilderService.getReferenceData('departments', SUPERADMIN);
        expect(sqlOf()).not.toMatch(/ANY\(\?\)/);
        expect(paramsOf()).toEqual([]);
    });

    test('an empty scope fails CLOSED — no options, never the whole org', async () => {
        EmployeeModel.findGovernedIds.mockResolvedValue([]);
        db.all.mockClear();
        expect(await ReportBuilderService.getReferenceData('sites', MANAGER)).toEqual([]);
        expect(db.all).not.toHaveBeenCalled();
    });

    test('a missing identity fails CLOSED too — there is no unscoped path', async () => {
        db.all.mockClear();
        expect(await ReportBuilderService.getReferenceData('sites', undefined)).toEqual([]);
        expect(await ReportBuilderService.getReferenceData('roles', null)).toEqual([]);
        expect(db.all).not.toHaveBeenCalled();
    });

    test('the FRAMEWORK catalogue is never narrowed by who sits in a span', async () => {
        // HARD CONSTRAINT: skills/domains are department-designed. Scoping them
        // would hide skills from the ask.
        EmployeeModel.findGovernedIds.mockResolvedValue([11]);
        for (const source of ['skills', 'domains']) {
            db.all.mockClear();
            await ReportBuilderService.getReferenceData(source, MANAGER);
            expect(sqlOf()).not.toMatch(/ANY\(\?\)/);
            expect(paramsOf()).toEqual([]);
        }
    });

    test('the response shape is unchanged: [{ id, name }]', async () => {
        db.all.mockResolvedValue([{ id: 3, name: 'Riverside' }]);
        await expect(ReportBuilderService.getReferenceData('sites', SUPERADMIN)).resolves.toEqual([
            { id: 3, name: 'Riverside' },
        ]);
        await expect(ReportBuilderService.getReferenceData('bogus', SUPERADMIN)).resolves.toEqual(
            []
        );
    });
});

describe('6. a partial assessment cannot fabricate a deficit (migration 79)', () => {
    const fs79 = fs.readFileSync(
        path.join(__dirname, '..', '..', 'db', 'postgres', '79_readiness_partial.sql'),
        'utf8'
    );

    test('total_gap_points sums ASSESSED requirements only', () => {
        expect(fs79).toMatch(
            /SUM\(CASE WHEN g\.is_assessed = 1 AND g\.gap > 0 THEN g\.gap ELSE 0 END\)::int AS total_gap_points/
        );
        // The old, inflating formula must be gone.
        expect(fs79).not.toMatch(
            /SUM\(CASE WHEN g\.gap > 0 THEN g\.gap ELSE 0 END\)::int AS total_gap_points/
        );
    });

    test('the department-designed requirement count stays WHOLE', () => {
        // total_required is still the unfiltered COUNT — no subsetting.
        expect(fs79).toMatch(/COUNT\(g\.skill_id\) AS total_required/);
        // …and the excluded gap volume stays visible instead of vanishing.
        expect(fs79).toMatch(/AS unassessed_gap_points/);
        expect(fs79).toMatch(/AS never_assessed_required/);
    });

    test('it is idempotent and cannot cascade dependent views away', () => {
        expect(fs79).toMatch(/CREATE OR REPLACE VIEW v_employee_readiness/);
        expect(fs79).not.toMatch(/DROP VIEW/i);
        expect(fs79).toMatch(/ON CONFLICT \(key\) DO UPDATE/);
    });

    test('"skills not met" is a measured shortfall, not every unrated skill', async () => {
        EmployeeModel.findGovernedIds.mockResolvedValue([11]);
        const { query } = await ReportBuilderService.buildReadinessQuery(
            ['employeeName', 'skillsNotMet', 'totalRequired', 'neverAssessedSkills'],
            null,
            null,
            null,
            MANAGER
        );
        expect(query).toMatch(/COALESCE\(c\.assessed_skills, 0\) - v\.skills_met/);
        expect(query).not.toMatch(/v\.total_required - v\.skills_met/);
        // The full requirement count is still exported next to it.
        expect(query).toMatch(/v\.total_required AS totalRequired/);
    });

    test('a strip filter narrows by name through parameters; a domain filter never trims the requirement set', async () => {
        db.all.mockResolvedValue([{ id: 4 }, { id: 5 }]);
        const scoped = await ReportDataService._kpiScope(
            { sites: ["North'; DROP TABLE x; --"], domains: ['Safety'] },
            MANAGER
        );
        expect(scoped).toEqual({ viewer: MANAGER, employeeIds: [4, 5] });
        const [sql, params] = db.all.mock.calls[db.all.mock.calls.length - 1];
        expect(sql).toMatch(/st\.name = ANY\(\?\)/);
        expect(sql).not.toMatch(/North|DROP|domain/i);
        expect(params).toEqual([["North'; DROP TABLE x; --"]]);
        // a domain filter alone leaves the population whole (no requirement trimmed)
        expect(await ReportDataService._kpiScope({ domains: ['Safety'] }, MANAGER)).toEqual({
            viewer: MANAGER,
        });
    });
});

describe('7. a scheduled CSV opens in French Excel like the downloaded one', () => {
    test('excelCsv prepends the UTF-8 BOM and the sep=, hint', () => {
        const out = ReportBuilderService.excelCsv('nom\nKaboré');
        expect(out.charCodeAt(0)).toBe(0xfeff);
        expect(out.slice(1)).toBe('sep=,\r\nnom\nKaboré');
        expect(Buffer.from(out, 'utf8').slice(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
        expect(ReportBuilderService.excelCsv(null).slice(1)).toBe('sep=,\r\n');
    });

    test('the scheduler stores the wrapped body as the in-app copy, never an attachment', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '..', '..', 'src', 'jobs', 'report-scheduler.js'),
            'utf8'
        );
        expect(src).toMatch(/ReportBuilderService\.excelCsv\(/);
        // SA-38: the copy is kept in the app and served with the same charset.
        expect(src).toMatch(/INSERT INTO report_schedule_runs/);
        expect(src).not.toMatch(/attachments:/);
        const ctl = fs.readFileSync(
            path.join(__dirname, '..', '..', 'src', 'controllers', 'ReportController.js'),
            'utf8'
        );
        expect(ctl).toMatch(/'Content-Type', 'text\/csv; charset=utf-8'/);
    });

    test('the interactive download goes through the SAME helper', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '..', '..', 'src', 'controllers', 'ReportController.js'),
            'utf8'
        );
        expect(src).toMatch(/return res\.send\(ReportBuilderService\.excelCsv\(body\)\)/);
    });
});
