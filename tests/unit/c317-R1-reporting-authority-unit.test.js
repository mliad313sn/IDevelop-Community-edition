'use strict';
/**
 * 3.23.18 — lane R1 (reporting-line authority), behaviour with a mocked DB.
 *
 *  #1  rbacMiddleware: an admin account linked to a person carries that
 *      person's reporting line (GovernanceService.lineAuthorityEmployeeIds),
 *      and the line people's org units, so dashboards agree with the console.
 *      OrgChartController draws the same union.
 *  #2  IDP: the DIRECT line (supervisor / manager of either type) and in-scope
 *      admins ACT; the rest of the sub-tree only READS; subject and viewer never act.
 *  #3  reportingLineStats: cycle-safe, nobody dropped.
 */

const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(async (fn) => fn()),
    withActor: jest.fn(async (_w, fn) => fn()),
};
jest.mock('../../src/config/database', () => mockDb);

const mockEmployees = {
    findById: jest.fn(),
    governs: jest.fn(async () => false),
    findGovernedIds: jest.fn(async () => []),
    orgUnitsOf: jest.fn(async () => ({ siteIds: [], departmentIds: [], serviceIds: [] })),
};
jest.mock('../../src/models/EmployeeModel', () => mockEmployees);

const mockRbac = {
    isSuperAdmin: (u) => Boolean(u && u.userType === 'admin' && u.role === 'superadmin'),
    isViewer: (u) => Boolean(u && u.userType === 'admin' && u.role === 'viewer'),
    canAccessEmployeeData: jest.fn(async () => false),
    getFilteredEmployees: jest.fn(async () => []),
};
jest.mock('../../src/services/RBACService', () => mockRbac);

const mockGov = {
    actingPersonId: jest.fn(async (u) => (u && u.userType !== 'admin' ? Number(u.id) : null)),
    lineAuthorityEmployeeIds: jest.fn(async () => []),
};
jest.mock('../../src/services/GovernanceService', () => mockGov);

const mockScope = { resolveAdminScope: jest.fn() };
jest.mock('../../src/middleware/auth', () => {
    const pass = (req, res, next) => next();
    return {
        requireAuth: pass,
        requireEmployee: pass,
        requireManager: pass,
        requireManagerOrAdmin: pass,
    };
});
jest.mock('../../src/utils/adminScope', () => mockScope);

beforeEach(() => {
    jest.clearAllMocks();
    mockEmployees.governs.mockResolvedValue(false);
    mockRbac.canAccessEmployeeData.mockResolvedValue(false);
    mockGov.lineAuthorityEmployeeIds.mockResolvedValue([]);
    mockGov.actingPersonId.mockImplementation(async (u) =>
        u && u.userType !== 'admin' ? Number(u.id) : null
    );
});

// ---------------------------------------------------------------------------
describe('#1 — rbacMiddleware: the linked person’s line is part of the admin scope', () => {
    const { rbacMiddleware } = require('../../src/middleware/rbac');
    const run = async (user) => {
        const req = { user };
        await new Promise((resolve) => rbacMiddleware(req, {}, resolve));
        return req.scope;
    };
    const ADMIN = { id: 703, userType: 'admin', role: 'localadmin' };

    test('the line people are ADDED, with their org units, beside the clearance', async () => {
        mockScope.resolveAdminScope.mockResolvedValue({
            unrestricted: false,
            siteIds: [1],
            departmentIds: [10],
            serviceIds: [100],
            employeeIds: [5],
        });
        mockGov.lineAuthorityEmployeeIds.mockResolvedValue([7, 8, 5]);
        mockEmployees.orgUnitsOf.mockResolvedValue({
            siteIds: [2],
            departmentIds: [20],
            serviceIds: [200],
        });
        const s = await run(ADMIN);
        expect(s.employeeIds.sort()).toEqual([5, 7, 8]);
        expect(s.siteIds.sort()).toEqual([1, 2]);
        expect(s.departmentIds.sort()).toEqual([10, 20]);
        expect(s.serviceIds.sort()).toEqual([100, 200]);
        expect(mockEmployees.orgUnitsOf).toHaveBeenCalledWith([7, 8]);

        // …and the dashboard filter built from that scope keeps the line people:
        // employeeIds stays the EXACT set, the site list no longer excludes them.
        const DashboardModel = require('../../src/models/DashboardModel');
        const params = [];
        const clause = DashboardModel._buildFilterClause(
            {
                siteIds: s.siteIds,
                departmentIds: s.departmentIds,
                serviceIds: s.serviceIds,
                employeeIds: s.employeeIds,
            },
            params,
            'e'
        );
        expect(clause).toMatch(/siteId IN/);
        expect(params).toEqual(expect.arrayContaining([2, 20, 200, 7, 8]));
    });

    test('an account with NO clearance but a line sees exactly that line (not "nothing", not "all")', async () => {
        mockScope.resolveAdminScope.mockResolvedValue({
            unrestricted: false,
            siteIds: [],
            departmentIds: [],
            serviceIds: [],
            employeeIds: [],
        });
        mockGov.lineAuthorityEmployeeIds.mockResolvedValue([7]);
        mockEmployees.orgUnitsOf.mockResolvedValue({
            siteIds: [2],
            departmentIds: [20],
            serviceIds: [200],
        });
        const s = await run(ADMIN);
        expect(s.employeeIds).toEqual([7]);
        expect(s.siteIds).toEqual([2]);
    });

    test('a failing line lookup keeps the clearance as resolved — never wider', async () => {
        mockScope.resolveAdminScope.mockResolvedValue({
            unrestricted: false,
            siteIds: [1],
            departmentIds: [10],
            serviceIds: [100],
            employeeIds: [5],
        });
        mockGov.lineAuthorityEmployeeIds.mockRejectedValue(new Error('boom'));
        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const s = await run(ADMIN);
        spy.mockRestore();
        expect(s.employeeIds).toEqual([5]);
        expect(s.siteIds).toEqual([1]);
    });

    test('nothing resolved and no line: still the impossible-id sentinel', async () => {
        mockScope.resolveAdminScope.mockResolvedValue({
            unrestricted: false,
            siteIds: [],
            departmentIds: [],
            serviceIds: [],
            employeeIds: [],
        });
        const s = await run(ADMIN);
        expect(s.employeeIds).toEqual([-1]);
    });
});

describe('#1 — the org chart draws the clearance PLUS the linked person’s line', () => {
    test('admin branch: scoped ∪ line ∪ the person themselves', async () => {
        const ctrl = require('../../src/controllers/OrgChartController');
        mockRbac.getFilteredEmployees.mockResolvedValue([{ id: 5 }]);
        mockGov.lineAuthorityEmployeeIds.mockResolvedValue([7]);
        mockGov.actingPersonId.mockResolvedValue(6);
        mockDb.all.mockResolvedValue([]);
        let body = null;
        await ctrl.data(
            { user: { id: 703, userType: 'admin', role: 'localadmin' } },
            {
                json: (j) => {
                    body = j;
                },
                status() {
                    return this;
                },
            }
        );
        expect(body.scope).toBe('admin-scope');
        const [, ids] = mockDb.all.mock.calls[0];
        expect(ids.map(Number).sort()).toEqual([5, 6, 7]);
    });
});

// ---------------------------------------------------------------------------
describe('#2 — IDP: the direct line acts, the sub-tree reads', () => {
    const IDPService = require('../../src/services/IDPService');
    const plan = { id: 1, employeeId: 150 };
    const EMP = { id: 150, supervisorId: 140, managerId: 141, managerType: 'employee' };

    test('an INDIRECT manager (N+2) cannot act, even though they govern the sub-tree', async () => {
        mockEmployees.findById.mockResolvedValue(EMP);
        mockEmployees.governs.mockResolvedValue(true);
        const out = await IDPService.planAuthority({ id: 130, userType: 'manager' }, plan);
        expect(out).toEqual({ canAct: false, isSubject: false });
    });

    test('the direct supervisor and the direct employee manager act', async () => {
        mockEmployees.findById.mockResolvedValue(EMP);
        expect(
            (await IDPService.planAuthority({ id: 140, userType: 'manager' }, plan)).canAct
        ).toBe(true);
        expect(
            (await IDPService.planAuthority({ id: 141, userType: 'manager' }, plan)).canAct
        ).toBe(true);
    });

    test('the admin account NAMED manager acts; a linked admin acts only through a DIRECT link', async () => {
        mockEmployees.findById.mockResolvedValue({
            id: 150,
            supervisorId: 140,
            managerId: 9,
            managerType: 'admin',
        });
        expect(
            (await IDPService.planAuthority({ id: 9, userType: 'admin', role: 'localadmin' }, plan))
                .canAct
        ).toBe(true);
        // admin 703 linked to person 130, who governs 150 only INDIRECTLY
        mockGov.actingPersonId.mockResolvedValue(130);
        mockEmployees.governs.mockResolvedValue(true);
        expect(
            (
                await IDPService.planAuthority(
                    { id: 703, userType: 'admin', role: 'localadmin' },
                    plan
                )
            ).canAct
        ).toBe(false);
        // …and through a DIRECT link, it acts
        mockGov.actingPersonId.mockResolvedValue(140);
        expect(
            (
                await IDPService.planAuthority(
                    { id: 703, userType: 'admin', role: 'localadmin' },
                    plan
                )
            ).canAct
        ).toBe(true);
    });

    test('an in-scope admin acts; the subject and a viewer never do', async () => {
        mockEmployees.findById.mockResolvedValue(EMP);
        mockRbac.canAccessEmployeeData.mockResolvedValue(true);
        expect(
            (
                await IDPService.planAuthority(
                    { id: 800, userType: 'admin', role: 'localadmin' },
                    plan
                )
            ).canAct
        ).toBe(true);
        expect(
            (await IDPService.planAuthority({ id: 801, userType: 'admin', role: 'viewer' }, plan))
                .canAct
        ).toBe(false);
        expect(await IDPService.planAuthority({ id: 150, userType: 'manager' }, plan)).toEqual({
            canAct: false,
            isSubject: true,
        });
    });
});

describe('#2 — IDP routes: create / sign / close refuse the indirect line', () => {
    const express = require('express');
    const call = (router, user, method, url, body = {}) =>
        new Promise((resolve) => {
            const app = express.Router();
            app.use('/v2/idp', router);
            const headers = { 'content-type': 'application/json', accept: 'application/json' };
            const r = {
                method,
                url: '/v2/idp' + url,
                originalUrl: '/v2/idp' + url,
                headers,
                body,
                query: {},
                params: {},
                user,
                ip: '127.0.0.1',
                xhr: true,
                isAuthenticated: () => true,
                get: (h) => headers[String(h).toLowerCase()],
                flash: () => {},
                t: (k, o) => (o && o.defaultValue) || k,
            };
            const res = {
                _status: 200,
                status(s) {
                    this._status = s;
                    return this;
                },
                json(j) {
                    resolve({ status: this._status, json: j });
                },
                render(v) {
                    resolve({ status: this._status, render: v });
                },
                redirect(u) {
                    resolve({ status: 302, location: u });
                },
                set() {
                    return this;
                },
                setHeader() {},
                getHeader() {},
            };
            app.handle(r, res, (err) =>
                resolve({ status: 'next', err: err && (err.message || err) })
            );
        });

    const INDIRECT = { id: 130, userType: 'manager' };
    const DIRECT = { id: 140, userType: 'manager' };

    beforeEach(() => {
        mockEmployees.findById.mockResolvedValue({
            id: 150,
            supervisorId: 140,
            managerId: null,
            managerType: null,
        });
        mockEmployees.governs.mockResolvedValue(true); // 130 governs 150 through 140
        mockDb.get.mockImplementation(async (sql) => {
            if (/FROM idp_plans WHERE id = \?/.test(sql))
                return { id: 5, employeeId: 150, status: 'draft' };
            if (/FROM idp_actions a\s+JOIN idp_plans/.test(sql)) return { id: 5, employeeId: 150 };
            return undefined;
        });
        mockDb.run.mockResolvedValue({ changes: 1 });
    });

    test('POST /new by the indirect manager → 403; by the direct supervisor → not refused', async () => {
        const router = require('../../src/routes/v2-idp');
        const out = await call(router, INDIRECT, 'POST', '/new', { employeeId: 150 });
        expect(out.status).toBe(403);
        const ok = await call(router, DIRECT, 'POST', '/new', { employeeId: 150 });
        expect(ok.status).not.toBe(403);
    });

    test('signing the SUPERVISOR slot needs the direct line', async () => {
        const router = require('../../src/routes/v2-idp');
        const out = await call(router, INDIRECT, 'POST', '/5/sign', {});
        expect(out.status).toBe(403);
        expect(mockDb.run.mock.calls.some(([s]) => /idp_signoffs/.test(s))).toBe(false);
    });

    test('closing someone else’s action needs the direct line (the indirect line only reads)', async () => {
        const router = require('../../src/routes/v2-idp');
        const out = await call(router, INDIRECT, 'POST', '/actions/5/close', { postRating: 3 });
        expect(out.status).toBe(403);
        expect(mockDb.run.mock.calls.some(([s]) => /UPDATE idp_actions/.test(s))).toBe(false);
    });

    test('the indirect manager can still READ the plan (canAccessIdp)', async () => {
        const router = require('../../src/routes/v2-idp');
        mockDb.all.mockResolvedValue([]);
        const out = await call(router, INDIRECT, 'GET', '/5');
        expect(out.status).toBe(200);
        expect(out.render).toBe('pages/idp/detail');
    });
});

// ---------------------------------------------------------------------------
describe('#3 — reportingLineStats: cycle-safe, nobody dropped', () => {
    const { reportingLineStats } = require('../../src/models/DashboardModel');

    test('a manager’s own perimeter (every top person HAS a manager — the reader)', () => {
        expect(
            reportingLineStats([
                { id: 2, parentId: 1 },
                { id: 3, parentId: 2 },
            ])
        ).toEqual({ managers: 2, span: 1, layers: 2 });
    });

    test('an A→B→A loop with a person under it: every one is measured', () => {
        const out = reportingLineStats([
            { id: 1, parentId: 2 },
            { id: 2, parentId: 1 },
            { id: 3, parentId: 2 },
            { id: 4, parentId: 3 },
        ]);
        expect(out.managers).toBe(3);
        expect(out.layers).toBeGreaterThanOrEqual(3);
    });

    test('no line anywhere: 0 managers, no span measured, one layer', () => {
        expect(reportingLineStats([{ id: 1, parentId: null }, { id: 2 }])).toEqual({
            managers: 0,
            span: null,
            layers: 1,
        });
    });

    test('an empty perimeter measures nothing', () => {
        expect(reportingLineStats([])).toEqual({ managers: 0, span: null, layers: null });
    });
});
