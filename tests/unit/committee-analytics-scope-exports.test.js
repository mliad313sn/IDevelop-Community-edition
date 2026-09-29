'use strict';
/**
 * Committee SECTION campaigns (analytics) — scope and export integrity.
 *
 *   F4  ContinuityService.listCoverage   incumbent identity/risk masked outside the caller's span, always for the caller
 *   F7  DashboardV2Controller            every widget scoped to the caller's employees; empty span ≠ org number
 *   F10 ReportBuilderService.exportToCSV  the RESOLVED column list, never the raw selectedFields
 *   F11 MovementController.exportCsv      csvCell (formula-injection neutralised) like every sibling exporter
 *   F13 report-scheduler                 a schedule replays under its creator's OWN identity type (migration 102)
 *
 * DB mocked throughout.
 */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(async (fn) => fn()),
    runInSavepoint: jest.fn(async (fn) => fn()),
};
jest.mock('../../src/config/database', () => mockDb);

const mockGoverned = { ids: [11, 12, 13] };
jest.mock('../../src/models/EmployeeModel', () => ({
    findGovernedIds: jest.fn(async () => mockGoverned.ids),
}));
const mockRbac = {
    isSuperAdmin: (u) => Boolean(u && u.userType === 'admin' && u.role === 'superadmin'),
    isLocalAdmin: (u) => Boolean(u && u.userType === 'admin' && u.role === 'localadmin'),
    isViewer: () => false,
    hasPermission: (u, slug) =>
        Boolean(
            u &&
            u.userType === 'admin' &&
            (u.role === 'superadmin' || (u.permissions || []).includes(slug))
        ),
    getFilteredEmployees: jest.fn(async () => [{ id: 21 }, { id: 22 }]),
};
jest.mock('../../src/services/RBACService', () => mockRbac);

const SUPER = { id: 1, userType: 'admin', role: 'superadmin' };
const MGR = { id: 137, userType: 'manager' };
const lastCall = (fn) => fn.mock.calls[fn.mock.calls.length - 1];
const mockRes = () => {
    const r = { code: 200, headers: {} };
    r.status = (c) => {
        r.code = c;
        return r;
    };
    r.json = (b) => {
        r.body = b;
        return r;
    };
    r.setHeader = (k, v) => {
        r.headers[k] = v;
    };
    r.send = (b) => {
        r.sent = b;
        return r;
    };
    return r;
};

beforeEach(() => {
    mockDb.get.mockReset();
    mockDb.all.mockReset().mockResolvedValue([]);
    mockDb.run.mockReset().mockResolvedValue({ changes: 1 });
    mockGoverned.ids = [11, 12, 13];
});

// ===========================================================================
// F4 — listCoverage incumbent privacy
// ===========================================================================
describe("F4 ContinuityService.listCoverage masks the incumbent outside the caller's span", () => {
    const ContinuityService = require('../../src/services/ContinuityService');
    const rows = () => [
        {
            roleId: 79,
            roleName: 'A',
            incumbentEmployeeId: 96,
            incumbentFlightRisk: 'low',
            incumbentImpactOfLoss: 'low',
            benchDepth: 0,
            hasCoverageGap: true,
        },
        {
            roleId: 85,
            roleName: 'B',
            incumbentEmployeeId: 137,
            incumbentFlightRisk: 'high',
            incumbentImpactOfLoss: 'high',
            benchDepth: 0,
            hasCoverageGap: true,
        },
        {
            roleId: 90,
            roleName: 'C',
            incumbentEmployeeId: 12,
            incumbentFlightRisk: 'medium',
            incumbentImpactOfLoss: 'high',
            benchDepth: 1,
            hasCoverageGap: false,
        },
        {
            roleId: 91,
            roleName: 'D',
            incumbentEmployeeId: null,
            incumbentFlightRisk: null,
            incumbentImpactOfLoss: null,
            benchDepth: 0,
            hasCoverageGap: true,
        },
    ];

    test('with the governed span: outside-span and self are nulled, in-span is kept, bench/gap untouched', async () => {
        mockDb.all.mockResolvedValue(rows());
        const out = await ContinuityService.listCoverage([79, 85, 90, 91], {
            governedIds: [11, 12, 13],
            callerEmployeeId: 137,
        });
        const byRole = Object.fromEntries(out.map((r) => [r.roleId, r]));
        expect(byRole[79]).toMatchObject({
            incumbentEmployeeId: null,
            incumbentFlightRisk: null,
            incumbentImpactOfLoss: null,
            benchDepth: 0,
            hasCoverageGap: true,
        });
        expect(byRole[85]).toMatchObject({
            incumbentEmployeeId: null,
            incumbentFlightRisk: null,
            incumbentImpactOfLoss: null,
        }); // the caller
        expect(byRole[90]).toMatchObject({
            incumbentEmployeeId: 12,
            incumbentFlightRisk: 'medium',
            incumbentImpactOfLoss: 'high',
        });
        expect(byRole[91].incumbentEmployeeId).toBeNull();
        expect(out).toHaveLength(4); // the roles themselves still list
    });

    test('a scoped call that supplies no span FAILS CLOSED: every incumbent field nulled', async () => {
        mockDb.all.mockResolvedValue(rows());
        const out = await ContinuityService.listCoverage([79, 85, 90, 91]);
        for (const r of out) {
            expect(r.incumbentEmployeeId).toBeNull();
            expect(r.incumbentFlightRisk).toBeNull();
            expect(r.incumbentImpactOfLoss).toBeNull();
        }
    });

    test('the caller is masked even when they sit inside their own governed set', async () => {
        mockDb.all.mockResolvedValue(rows());
        const out = await ContinuityService.listCoverage([85], {
            governedIds: [137, 12],
            callerEmployeeId: 137,
        });
        expect(out.find((r) => r.roleId === 85).incumbentFlightRisk).toBeNull();
    });

    test('the unscoped (superadmin) call is unchanged', async () => {
        mockDb.all.mockResolvedValue(rows());
        const out = await ContinuityService.listCoverage(null);
        expect(out.find((r) => r.roleId === 79).incumbentFlightRisk).toBe('low');
        expect(out.find((r) => r.roleId === 85).incumbentFlightRisk).toBe('high');
    });

    test('an empty role list still fails closed with no rows', async () => {
        expect(await ContinuityService.listCoverage([], { governedIds: [1] })).toEqual([]);
        expect(mockDb.all).not.toHaveBeenCalled();
    });
});

// ===========================================================================
// F7 — DashboardV2Controller scope
// ===========================================================================
describe("F7 DashboardV2Controller: every widget is scoped to the caller's employees", () => {
    const D2 = require('../../src/controllers/DashboardV2Controller');

    test('actionEffectiveness for manager 137 is restricted to EmployeeModel.findGovernedIds(137)', async () => {
        const res = mockRes();
        await D2.actionEffectiveness({ user: MGR }, res);
        const [sql, params] = lastCall(mockDb.all);
        expect(sql).toMatch(/JOIN idp_plans p ON p\.id = a\.idp_id/);
        expect(sql).toMatch(/WHERE 1 = 1 AND p\.employee_id IN \(\?,\?,\?\)/);
        expect(params).toEqual([11, 12, 13]);
        expect(res.body.scoped).toBe(true);
    });

    test("the manager's own UNMEASURED actions are reported separately (LEFT JOIN + unmeasured count), avg NULL when none", async () => {
        await D2.actionEffectiveness({ user: MGR }, mockRes());
        const [sql] = lastCall(mockDb.all);
        expect(sql).toMatch(/LEFT JOIN action_effectiveness e ON e\.action_id = a\.id/);
        // 3.23.17 (migration 148): a row whose uplift is NULL — the skill was never
        // assessed before the action — is unmeasured too, not a measured action.
        expect(sql).toMatch(/COUNT\(e\.uplift\)::int\s+AS actions/);
        expect(sql).toMatch(/COUNT\(\*\) FILTER \(WHERE e\.uplift IS NULL\)::int AS unmeasured/);
        expect(sql).toMatch(/ROUND\(AVG\(e\.uplift\)::numeric, 2\)\s+AS avg_uplift/);
    });

    test('an EMPTY span yields no rows — it never inherits the org-wide number', async () => {
        mockGoverned.ids = [];
        mockDb.all.mockResolvedValue([{ type: 'training', actions: 2 }]); // what an unscoped query would return
        const res = mockRes();
        await D2.actionEffectiveness({ user: MGR }, res);
        const [sql] = lastCall(mockDb.all);
        expect(sql).toMatch(/WHERE 1 = 1 AND 1 = 0/);
    });

    test('the superadmin query is unrestricted', async () => {
        const res = mockRes();
        await D2.actionEffectiveness({ user: SUPER }, res);
        const [sql, params] = lastCall(mockDb.all);
        expect(sql).not.toMatch(/employee_id IN/);
        expect(params).toEqual([]);
        expect(res.body.scoped).toBe(false);
    });

    test('pipOverview keeps its permission gate AND scopes by employee id', async () => {
        const res403 = mockRes();
        await D2.pipOverview({ user: MGR }, res403);
        expect(res403.code).toBe(403);
        const hr = {
            id: 3,
            userType: 'admin',
            role: 'localadmin',
            permissions: ['arbitrate_disputes'],
        };
        const res = mockRes();
        await D2.pipOverview({ user: hr }, res);
        const [sql, params] = lastCall(mockDb.all);
        expect(sql).toMatch(/FROM pips WHERE 1 = 1 AND employee_id IN \(\?,\?\) GROUP BY state/);
        expect(params).toEqual([21, 22]);
    });

    test('biasMonitor restricts a scoped caller to the site/department groups of their people', async () => {
        const res = mockRes();
        await D2.biasMonitor({ user: MGR }, res);
        const [sql, params] = lastCall(mockDb.all);
        // group_value holds the site / department ID (BiasDetectionService writes
        // String(siteId)); matching it against NAMES hid every alert (3.23.17).
        expect(sql).toMatch(
            /b\.group_dim = 'site' AND b\.group_value IN \(SELECT DISTINCT e\.site_id::text FROM employees e WHERE e\.id IN \(\?,\?,\?\)/
        );
        expect(sql).toMatch(
            /b\.group_dim = 'department' AND b\.group_value IN \(SELECT DISTINCT e\.department_id::text FROM employees e/
        );
        expect(sql).not.toMatch(/site_name|department_name/);
        expect(params).toEqual([11, 12, 13, 11, 12, 13]);
        mockGoverned.ids = [];
        const empty = mockRes();
        await D2.biasMonitor({ user: MGR }, empty);
        expect(empty.body).toEqual({ rows: [], scoped: true });
        const sup = mockRes();
        await D2.biasMonitor({ user: SUPER }, sup);
        expect(lastCall(mockDb.all)[0]).not.toMatch(/WHERE/);
    });
});

// ===========================================================================
// F10 — resolved CSV columns
// ===========================================================================
describe('F10 ReportBuilderService: the CSV iterates the RESOLVED columns', () => {
    const RBS = require('../../src/services/ReportBuilderService');

    test('executeReport returns the resolved column list — forced coverage columns in, rejected fields out', async () => {
        mockDb.all.mockResolvedValue([
            {
                employeeName: 'A',
                readinessPercent: 89.9,
                assessedSkills: 48,
                expectedSkills: 49,
                coveragePercent: 98,
                assessmentStatus: 'assessed',
            },
        ]);
        const rows = await RBS.executeReport(
            {
                dataSource: 'readiness',
                selectedFields: ['employeeName', 'readinessPercent', 'bogusField'],
                filters: {},
                sorting: [],
                groupBy: null,
            },
            SUPER
        );
        expect(rows.columns).toEqual([
            'employeeName',
            'readinessPercent',
            'assessedSkills',
            'expectedSkills',
            'coveragePercent',
            'assessmentStatus',
        ]);
        // JSON consumers see the plain array they always did
        expect(JSON.parse(JSON.stringify(rows))).toEqual([
            {
                employeeName: 'A',
                readinessPercent: 89.9,
                assessedSkills: 48,
                expectedSkills: 49,
                coveragePercent: 98,
                assessmentStatus: 'assessed',
            },
        ]);
        expect(Object.keys(rows)).not.toContain('columns');
    });

    test('exportToCSV writes the resolved header — no blank column for a rejected field, no dropped coverage column', async () => {
        mockDb.all.mockResolvedValue([
            {
                employeeName: 'A',
                readinessPercent: 89.9,
                assessedSkills: 48,
                expectedSkills: 49,
                coveragePercent: 98,
                assessmentStatus: 'assessed',
            },
        ]);
        const config = {
            dataSource: 'readiness',
            selectedFields: ['employeeName', 'readinessPercent', 'bogusField'],
            filters: {},
            sorting: [],
            groupBy: null,
        };
        const rows = await RBS.executeReport(config, SUPER);
        const csv = RBS.exportToCSV(rows, config.selectedFields);
        const [header, row] = csv.split('\n');
        expect(header).toBe(
            'employeeName,readinessPercent,assessedSkills,expectedSkills,coveragePercent,assessmentStatus'
        );
        expect(header).not.toMatch(/bogusField/);
        expect(row).toBe('"A","89.9","48","49","98","assessed"');
    });

    test('rows that did not come through executeReport still export by the given field list', () => {
        expect(RBS.exportToCSV([{ a: 1, b: 2 }], ['a', 'b'])).toBe('a,b\n"1","2"');
        expect(RBS.exportToCSV([], ['a'])).toBe('');
    });

    test('every builder reports its resolved columns to buildQuery', async () => {
        for (const [dataSource, fields] of [
            ['employees', ['firstName', 'nope']],
            ['assessments', ['skillName']],
            ['skills', ['skillName']],
            ['roles', ['roleName', 'zzz']],
            ['organization', ['siteName']],
        ]) {
            const built = await RBS.buildQuery(
                { dataSource, selectedFields: fields, filters: {}, sorting: [], groupBy: null },
                SUPER
            );
            expect(built.columns).toEqual(fields.filter((f) => !['nope', 'zzz'].includes(f)));
        }
    });

    test('the scheduled e-mail attachment uses the resolved columns too', () => {
        const src = read('src/jobs/report-scheduler.js');
        expect(src).toMatch(
            /ReportBuilderService\.exportToCSV\(rows, rows\.columns \|\| config\.selectedFields\)/
        );
    });
});

// ===========================================================================
// F11 — movements CSV
// ===========================================================================
describe('F11 MovementController.exportCsv neutralises formula injection like every sibling exporter', () => {
    let MovementController;
    const mockMovement = { feed: jest.fn(), summary: jest.fn() };
    beforeEach(() => {
        jest.resetModules();
        jest.doMock('../../src/services/MovementService', () => mockMovement);
        MovementController = require('../../src/controllers/MovementController');
    });

    test('a leading =, +, - or @ is prefixed with a quote; RFC-4180 quoting is kept', async () => {
        mockMovement.feed.mockResolvedValue([
            {
                occurredAt: '2026-09-01T00:00:00.000Z',
                stream: 'org',
                eventKind: 'role',
                employeeName: '=HYPERLINK("http://evil")',
                employeeNumber: '+123',
                siteName: 'Lakeside',
                departmentName: '-Ops',
                fromLabel: 'A',
                toLabel: 'B "quoted"',
                skillName: '@skill',
                actorName: null,
            },
        ]);
        const res = mockRes();
        await MovementController.exportCsv({ user: SUPER, query: {} }, res);
        const body = String(res.sent);
        expect(body).toContain('"\'=HYPERLINK(""http://evil"")"');
        expect(body).toContain('"\'+123"');
        expect(body).toContain('"\'-Ops"');
        expect(body).toContain('"\'@skill"');
        expect(body).toContain('"B ""quoted"""');
        expect(body).toContain('"system"');
        expect(body).not.toMatch(/;"=HYPERLINK/);
    });

    test('the controller imports csvCell from utils/csvSafe instead of a private escaper', () => {
        const src = read('src/controllers/MovementController.js');
        expect(src).toMatch(/const \{ csvCell \} = require\('\.\.\/utils\/csvSafe'\);/);
        expect(src).toMatch(/const esc = csvCell;/);
        expect(src).not.toMatch(/const esc = \(v\) => '"' \+ String/);
    });
});

// ===========================================================================
// F13 — scheduler identity
// ===========================================================================
describe("F13 report-scheduler replays a schedule under its creator's OWN identity type", () => {
    test('migration 102 adds creator_type with a stated backfill rule and the same CHECK as report_templates', () => {
        const sql = read('db/postgres/102_report_schedules_creator_type.sql');
        expect(sql).toMatch(
            /ALTER TABLE report_schedules ADD COLUMN IF NOT EXISTS creator_type text;/
        );
        expect(sql).toMatch(/BACKFILL RULE/);
        expect(sql).toMatch(
            /WHEN EXISTS \(SELECT 1 FROM admins a WHERE a\.id = s\.created_by\)\s+AND NOT EXISTS \(SELECT 1 FROM employees e WHERE e\.id = s\.created_by\) THEN 'admin'/
        );
        expect(sql).toMatch(/ELSE 'employee'/);
        expect(sql).toMatch(/CHECK \(creator_type IN \('admin', 'employee'\)\)/);
        expect(sql).toMatch(
            /INSERT INTO schema_meta\(key, value\) VALUES \('102_report_schedules_creator_type', 'applied'\)/
        );
    });

    test("creatorUserType: employee → manager, admin → admin, and the migration's rule as fallback", () => {
        const { creatorUserType } = require('../../src/jobs/report-scheduler');
        expect(creatorUserType({ creatorType: 'employee', creatorRole: 'localadmin' })).toBe(
            'manager'
        );
        expect(creatorUserType({ creatorType: 'admin', creatorRole: 'localadmin' })).toBe('admin');
        expect(creatorUserType({ creator_type: 'employee' })).toBe('manager');
        expect(creatorUserType({ creatorRole: 'superadmin' })).toBe('admin');
        expect(creatorUserType({ creatorRole: 'viewer' })).toBe('admin');
        expect(creatorUserType({ creatorRole: 'localadmin' })).toBe('manager'); // errs to the narrower clearance
    });

    test("tick() executes a manager's schedule as userType manager, never a hardcoded admin", async () => {
        jest.resetModules();
        jest.doMock('../../src/config/database', () => mockDb);
        const executeReport = jest.fn(async () => Object.assign([{ a: 1 }], {}));
        jest.doMock('../../src/services/ReportBuilderService', () => ({
            executeReport,
            exportToCSV: () => 'a\n"1"',
            excelCsv: (b) => b,
        }));
        const send = jest.fn(async () => ({ sent: true }));
        jest.doMock('../../src/services/EmailService', () => ({ send }));
        const { tick } = require('../../src/jobs/report-scheduler');
        mockDb.all.mockResolvedValue([
            {
                id: 1,
                createdBy: 137,
                creatorRole: 'localadmin',
                creatorType: 'employee',
                templateName: 'T',
                dataSource: 'readiness',
                selectedFields: '["employeeName"]',
                filters: null,
                sorting: null,
                groupBy: null,
                recipients: 'x@example.test',
                frequency: 'daily',
            },
            {
                id: 2,
                createdBy: 2,
                creatorRole: 'localadmin',
                creatorType: 'admin',
                templateName: 'T',
                dataSource: 'readiness',
                selectedFields: '["employeeName"]',
                filters: null,
                sorting: null,
                groupBy: null,
                recipients: 'x@example.test',
                frequency: 'daily',
            },
        ]);
        // 3.23.17 (B-4): the creator is re-resolved from their LIVE account at
        // every run — employee 137 is active; admin 2 is active and is now a
        // VIEWER (demoted since scheduling): the stored 'localadmin' snapshot
        // must NOT be replayed.
        mockDb.get.mockImplementation(async (sql, params) => {
            if (/FROM employees/.test(sql) && Number(params[0]) === 137)
                return { id: 137, isActive: true, cancelledAt: null };
            if (/FROM admins/.test(sql) && Number(params[0]) === 2)
                return { id: 2, role: 'viewer', isActive: true };
            return undefined;
        });
        const out = await tick();
        expect(out.ran).toBe(2);
        expect(executeReport.mock.calls[0][1]).toEqual({
            id: 137,
            role: null, // an employee creator never carries an admin role
            userType: 'manager',
        });
        expect(executeReport.mock.calls[1][1]).toEqual({
            id: 2,
            role: 'viewer', // CURRENT role, not the stored snapshot
            userType: 'admin',
        });
        const src = read('src/jobs/report-scheduler.js');
        expect(src).not.toMatch(/userType: 'admin' \}/);
    });

    test('createSchedule stores creator_type from the real session, and list/delete own by (created_by, creator_type)', async () => {
        jest.resetModules();
        jest.doMock('../../src/config/database', () => mockDb);
        jest.doMock('../../src/services/RBACService', () => mockRbac);
        jest.doMock('../../src/services/ReadinessService', () => ({}));
        jest.doMock('../../src/models/EmployeeModel', () => ({}));
        // createSchedule now asks whether the template's source can actually be
        // executed before accepting the schedule, so the double has to answer —
        // and the template row has to carry a dataSource, as a real one does.
        jest.doMock('../../src/services/ReportBuilderService', () => ({
            excelCsv: (b) => b,
            canExecute: (ds) =>
                [
                    'employees',
                    'assessments',
                    'readiness',
                    'skills',
                    'roles',
                    'organization',
                ].includes(ds),
        }));
        jest.doMock('../../src/services/ReportDataService', () => ({}));
        const ReportController = require('../../src/controllers/ReportController');
        mockDb.get.mockResolvedValue({ id: 5, dataSource: 'readiness' });
        const req = {
            body: { templateId: '5', frequency: 'daily', hour: '6', recipients: 'a@b.co' },
            user: { id: 137, userType: 'manager' },
            flash: jest.fn(),
        };
        const res = { redirect: jest.fn() };
        await ReportController.createSchedule(req, res);
        const [sql, params] = lastCall(mockDb.run);
        expect(sql).toMatch(
            /INSERT INTO report_schedules \(template_id, recipients, frequency, day_of_week, hour, created_by, creator_role, creator_type\)/
        );
        expect(params[5]).toBe(137);
        expect(params[7]).toBe('employee');

        mockDb.all.mockResolvedValue([]);
        await ReportController.listSchedules(
            { user: { id: 137, userType: 'manager', role: 'manager' }, t: null, flash: jest.fn() },
            { render: jest.fn(), redirect: jest.fn() }
        );
        const [listSql, listParams] = mockDb.all.mock.calls[0];
        expect(listSql).toMatch(/WHERE s\.created_by = \? AND s\.creator_type = \?/);
        expect(listParams).toEqual([137, 'employee']);

        await ReportController.deleteSchedule(
            {
                params: { id: '9' },
                user: { id: 137, userType: 'manager', role: 'manager' },
                flash: jest.fn(),
                t: null,
            },
            { redirect: jest.fn() }
        );
        const [delSql, delParams] = lastCall(mockDb.run);
        expect(delSql).toMatch(/AND created_by = \? AND creator_type = \?/);
        expect(delParams).toEqual([9, 137, 'employee']);
    });
});
