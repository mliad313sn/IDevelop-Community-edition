'use strict';

/**
 * 3.23.17 — lane A-access, finding 1 (CRITICAL).
 *
 * `_canManageTargetAdmin` judged a target admin on its LIVE scope only, with
 * `every()` over the target's employee set. A DEACTIVATED admin has every scope
 * row revoked → an EMPTY set → `[].every(...)` is true: a one-service delegate
 * holding manage_admins could reset the password of a deactivated COUNTRY-wide
 * admin, reactivate it (restoreAllForAdmin puts every scope + grant back) and
 * sign in with country-wide reach. Permissions were never compared either.
 *
 * The world below is a small in-memory org; the db and the models are mocked,
 * the controller, utils/adminScope and RBACService run for real.
 */

const mockWorld = {
    countries: { 9: { id: 9, regionId: 1 } },
    sites: { 11: { id: 11, countryId: 9 }, 12: { id: 12, countryId: 9 } },
    departments: { 21: { id: 21, siteId: 11 }, 22: { id: 22, siteId: 12 } },
    services: { 31: { id: 31, departmentId: 21 }, 32: { id: 32, departmentId: 22 } },
    employees: [
        { id: 1, siteId: 11, departmentId: 21, serviceId: 31 },
        { id: 2, siteId: 11, departmentId: 21, serviceId: 31 },
        { id: 3, siteId: 12, departmentId: 22, serviceId: 32 },
        { id: 4, siteId: 12, departmentId: 22, serviceId: 32 },
    ],
    admins: {
        100: { id: 100, username: 'svc.delegate', role: 'localadmin', isActive: true },
        200: { id: 200, username: 'country.off', role: 'localadmin', isActive: false },
        300: { id: 300, username: 'svc.peer', role: 'localadmin', isActive: true },
        400: { id: 400, username: 'no.scope', role: 'localadmin', isActive: true },
        500: { id: 500, username: 'svc.stronger', role: 'localadmin', isActive: true },
        600: { id: 600, username: 'site.expired', role: 'localadmin', isActive: true },
    },
    scopes: [
        { id: 1, adminId: 100, scopeType: 'service', serviceId: 31 },
        // the deactivated country-wide admin: its only scope is REVOKED
        { id: 2, adminId: 200, scopeType: 'country', countryId: 9, revokedAt: '2026-09-01' },
        { id: 3, adminId: 300, scopeType: 'service', serviceId: 31 },
        { id: 5, adminId: 500, scopeType: 'service', serviceId: 31 },
        // live but EXPIRED site scope (Prolonger would put it back)
        { id: 6, adminId: 600, scopeType: 'site', siteId: 11, expiresAt: '2020-01-01' },
    ],
    perms: [
        { adminId: 100, permission: 'manage_admins' },
        { adminId: 100, permission: 'view_employees' },
        { adminId: 200, permission: 'manage_admins', revokedAt: '2026-09-01' },
        { adminId: 200, permission: 'edit_employees', revokedAt: '2026-09-01' },
        { adminId: 300, permission: 'view_employees' },
        { adminId: 500, permission: 'view_employees' },
        { adminId: 500, permission: 'edit_employees' },
    ],
};

const live = (s) => !s.revokedAt && !(s.expiresAt && new Date(s.expiresAt) <= new Date());
const has = (arr, v) => Array.isArray(arr) && arr.map(Number).includes(Number(v));

const mockDb = {
    all: jest.fn(async (sql, params = []) => {
        const W = mockWorld;
        if (/FROM admin_scopes\s+WHERE admin_id = \?/.test(sql)) {
            const onlyLive = /revoked_at IS NULL/.test(sql);
            return W.scopes.filter(
                (s) => s.adminId === Number(params[0]) && (!onlyLive || live(s))
            );
        }
        const [rg, ct, st, dp, sv] = params;
        const siteCountry = (sid) => (W.sites[sid] || {}).countryId;
        const countryRegion = (cid) => (W.countries[cid] || {}).regionId;
        if (/SELECT e\.id\s+FROM employees e/.test(sql)) {
            return W.employees
                .filter(
                    (e) =>
                        has(rg, countryRegion(siteCountry(e.siteId))) ||
                        has(ct, siteCountry(e.siteId)) ||
                        has(st, e.siteId) ||
                        has(dp, e.departmentId) ||
                        has(sv, e.serviceId)
                )
                .map((e) => ({ id: e.id }));
        }
        if (
            /SELECT DISTINCT s\.id/.test(sql) ||
            /SELECT DISTINCT d\.id/.test(sql) ||
            /SELECT DISTINCT v\.id/.test(sql)
        ) {
            return []; // navigable sets are not what this guard decides on
        }
        if (/SELECT permission FROM admin_permissions WHERE admin_id = \?/.test(sql)) {
            return W.perms.filter((p) => p.adminId === Number(params[0]));
        }
        return [];
    }),
    get: jest.fn(async () => null),
    run: jest.fn(async () => ({ changes: 0 })),
    runTransaction: jest.fn(async (fn) => fn()),
    _client: jest.fn(),
};
jest.mock('../../src/config/database', () => mockDb);

jest.mock('../../src/models/AdminModel', () => ({
    findById: jest.fn(async (id) =>
        mockWorld.admins[Number(id)] ? { ...mockWorld.admins[Number(id)] } : null
    ),
    findWithScopes: jest.fn(async (id) => {
        const a = mockWorld.admins[Number(id)];
        if (!a) return null;
        const live = (s) => !s.revokedAt && !(s.expiresAt && new Date(s.expiresAt) <= new Date());
        return {
            ...a,
            scopes: mockWorld.scopes.filter((s) => s.adminId === Number(id) && live(s)),
        };
    }),
    update: jest.fn(async () => ({ changes: 1 })),
    findAll: jest.fn(async () => []),
}));
jest.mock('../../src/models/AdminScopeModel', () => ({
    findAllByAdminId: jest.fn(async (id) =>
        mockWorld.scopes.filter((s) => s.adminId === Number(id))
    ),
    findByAdminId: jest.fn(async () => []),
    _scopeTargetId: (s) =>
        s.siteId || s.departmentId || s.serviceId || s.countryId || s.regionId || null,
    restoreAllForAdmin: jest.fn(async () => []),
    revokeAllForAdmin: jest.fn(async () => []),
}));
jest.mock('../../src/models/AdminPermissionModel', () => ({
    restoreAllForAdmin: jest.fn(async () => []),
    revokeAllForAdmin: jest.fn(async () => []),
    findSlugsByAdminId: jest.fn(async () => []),
}));
jest.mock('../../src/models/SiteModel', () => ({
    findById: jest.fn(async (id) => mockWorld.sites[Number(id)] || null),
}));
jest.mock('../../src/models/DepartmentModel', () => ({
    findById: jest.fn(async (id) => mockWorld.departments[Number(id)] || null),
}));
jest.mock('../../src/models/ServiceModel', () => ({
    findById: jest.fn(async (id) => mockWorld.services[Number(id)] || null),
}));

const AdminController = require('../../src/controllers/AdminController');
const AdminModel = require('../../src/models/AdminModel');
const AdminScopeModel = require('../../src/models/AdminScopeModel');
const AdminPermissionModel = require('../../src/models/AdminPermissionModel');
const { canManageTargetAdmin } = AdminController._internals;

const DELEGATE = {
    id: 100,
    userType: 'admin',
    role: 'localadmin',
    permissions: ['manage_admins', 'view_employees'],
};
const SUPER = { id: 1, userType: 'admin', role: 'superadmin' };

function fakeReq(user, params, body = {}) {
    const flashes = [];
    return {
        user,
        params,
        body,
        query: {},
        ip: '127.0.0.1',
        language: 'fr',
        get: () => 'jest',
        t: (k, o) => (o && o.defaultValue) || k,
        flash: (k, m) => flashes.push([k, m]),
        _flashes: flashes,
    };
}
function fakeRes() {
    const o = { redirects: [] };
    return {
        o,
        redirect: (u) => o.redirects.push(u),
        status() {
            return this;
        },
        json() {},
        render() {},
    };
}

beforeEach(() => {
    AdminModel.update.mockClear();
    AdminScopeModel.restoreAllForAdmin.mockClear();
    AdminPermissionModel.restoreAllForAdmin.mockClear();
});

describe('A-1 — a target admin is judged on its FULL restorable perimeter', () => {
    test('PROBE: a one-service delegate may NOT administer a DEACTIVATED country-wide admin', async () => {
        expect(await canManageTargetAdmin(DELEGATE, 200)).toBe(false);
    });

    test("a narrower, active peer inside the delegate's service stays manageable", async () => {
        expect(await canManageTargetAdmin(DELEGATE, 300)).toBe(true);
    });

    test('a target with NO scope row at all is SuperAdmin-only (not "governs nobody")', async () => {
        expect(await canManageTargetAdmin(DELEGATE, 400)).toBe(false);
        expect(await canManageTargetAdmin(SUPER, 400)).toBe(true);
    });

    test('a target holding a capability the delegate lacks is refused (permissions ⊆)', async () => {
        expect(await canManageTargetAdmin(DELEGATE, 500)).toBe(false);
    });

    test('an EXPIRED wider scope counts — "Prolonger" would put it back', async () => {
        expect(await canManageTargetAdmin(DELEGATE, 600)).toBe(false);
    });

    test('a SuperAdmin still administers the deactivated admin', async () => {
        expect(await canManageTargetAdmin(SUPER, 200)).toBe(true);
    });
});

describe('A-1 — the takeover chain is closed at each verb', () => {
    test('POST /admins/200/reset-password by the delegate changes nothing', async () => {
        const req = fakeReq(DELEGATE, { id: '200' }, { newPassword: 'Str0ng!Passw0rd#2026' });
        const res = fakeRes();
        await AdminController.resetPassword(req, res);
        expect(AdminModel.update).not.toHaveBeenCalled();
        expect(req._flashes.map((f) => f[0])).toContain('error');
        expect(res.o.redirects).toEqual(['/admins']);
    });

    test('POST /admins/200/reactivate by the delegate restores nothing', async () => {
        const req = fakeReq(DELEGATE, { id: '200' }, { reason: 'please' });
        const res = fakeRes();
        await AdminController.reactivate(req, res);
        expect(AdminScopeModel.restoreAllForAdmin).not.toHaveBeenCalled();
        expect(AdminPermissionModel.restoreAllForAdmin).not.toHaveBeenCalled();
        expect(AdminModel.update).not.toHaveBeenCalled();
    });
});
