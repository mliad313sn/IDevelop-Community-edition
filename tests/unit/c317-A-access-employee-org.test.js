'use strict';

/**
 * 3.23.17 — lane A-access, findings 3, 4, 5 and 6.
 *
 *  3. Account takeover through the e-mail field: a manager, or an admin holding
 *     only edit_employees, rewrote ANOTHER person's address and then asked for
 *     a password reset (the link goes to the new address). And /account let a
 *     hijacked session change its own address without the password (S-08).
 *  4. EmployeeController.update wrote the posted site/department/service and a
 *     new supervisor/manager unchecked (the placement check sat in show(), a GET).
 *  5. /api/employees/:id/cycle-progress: the guard parsed `137e1` as 137
 *     (parseInt) while the handler read 1370 (Number).
 *  6. Organization: sitesDelete had no perimeter check; departments/services
 *     re-parented to any body id; sites moved to any country.
 *
 * DB and collaborators mocked; the controllers under test run for real.
 */

const bcrypt = require('bcrypt');

const mockDb = {
    get: jest.fn(async () => null),
    all: jest.fn(async () => []),
    run: jest.fn(async () => ({ changes: 1 })),
    runTransaction: jest.fn(async (fn) => fn()),
    withActor: jest.fn(async (_w, fn) => fn()),
};
jest.mock('../../src/config/database', () => mockDb);
jest.mock('../../src/models/EmployeeModel', () => ({
    findById: jest.fn(),
    update: jest.fn(async () => ({})),
    findByEmployeeNumber: jest.fn(async () => null),
    findGovernedIds: jest.fn(async () => []),
    wouldCreateReportingCycle: jest.fn(async () => false),
    findByIdWithOrganization: jest.fn(),
}));
jest.mock('../../src/models/AdminModel', () => ({
    findById: jest.fn(),
    update: jest.fn(async () => ({})),
    findAll: jest.fn(async () => []),
    findByUsername: jest.fn(),
}));
jest.mock('../../src/models/SiteModel', () => ({
    findById: jest.fn(),
    update: jest.fn(async () => ({})),
}));
jest.mock('../../src/models/DepartmentModel', () => ({
    findById: jest.fn(),
    update: jest.fn(async () => ({})),
}));
jest.mock('../../src/models/ServiceModel', () => ({
    findById: jest.fn(),
    update: jest.fn(async () => ({})),
}));
jest.mock('../../src/services/LogService', () => ({ log: jest.fn(async () => {}) }));
jest.mock('../../src/services/EmailService', () => ({
    send: jest.fn(async () => ({ sent: true })),
}));
jest.mock('../../src/services/EmailAccountsService', () => ({
    advisory: jest.fn(async () => null),
}));
jest.mock('../../src/services/RBACService', () => {
    const isSuperAdmin = (u) => !!u && u.userType === 'admin' && u.role === 'superadmin';
    return {
        isSuperAdmin,
        isViewer: (u) => !!u && u.role === 'viewer',
        hasPermission: (u, s) =>
            isSuperAdmin(u) || (Array.isArray(u && u.permissions) && u.permissions.includes(s)),
        canAccessEmployeeData: jest.fn(async () => true),
        canAccessEmployee: jest.fn(async () => true),
        canAccessSite: jest.fn(async () => true),
        canAccessDepartment: jest.fn(async () => true),
        canAccessService: jest.fn(async () => true),
        canAccessCountry: jest.fn(async () => true),
    };
});

const EmployeeModel = require('../../src/models/EmployeeModel');
const AdminModel = require('../../src/models/AdminModel');
const SiteModel = require('../../src/models/SiteModel');
const DepartmentModel = require('../../src/models/DepartmentModel');
const ServiceModel = require('../../src/models/ServiceModel');
const EmailService = require('../../src/services/EmailService');
const RBAC = require('../../src/services/RBACService');
const adminScope = require('../../src/utils/adminScope');
const Lifecycle = require('../../src/services/LifecycleService');
const EmployeeController = require('../../src/controllers/EmployeeController');
const AuthController = require('../../src/controllers/AuthController');
const OrganizationController = require('../../src/controllers/OrganizationController');

function fakeReq(user, { params = {}, body = {} } = {}) {
    const flashes = [];
    return {
        user,
        params,
        body,
        query: {},
        ip: '127.0.0.1',
        session: {},
        get: () => 'jest',
        t: (k, o) => (o && o.defaultValue) || k,
        flash: (k, m) => flashes.push([k, m]),
        _flashes: flashes,
    };
}
function fakeRes() {
    const o = {};
    return {
        o,
        redirect: (u) => {
            o.redirect = u;
        },
        status(c) {
            o.status = c;
            return this;
        },
        json(j) {
            o.json = j;
            return this;
        },
        render() {},
    };
}
const errorsOf = (req) => req._flashes.filter((f) => f[0] === 'error').map((f) => f[1]);

const EMP = {
    id: 142,
    employeeNumber: 'E142',
    firstName: 'Awa',
    lastName: 'K',
    email: 'owner@corp.test',
    siteId: 11,
    departmentId: 21,
    serviceId: 31,
    roleId: 1,
    supervisorId: null,
    managerId: null,
    managerType: null,
};
const BODY = {
    employeeNumber: 'E142',
    firstName: 'Awa',
    lastName: 'K',
    email: 'owner@corp.test',
    siteId: '11',
    departmentId: '21',
    serviceId: '31',
    roleId: '1',
};
const MANAGER = { id: 50, userType: 'manager' };
const EDITOR = { id: 5, userType: 'admin', role: 'localadmin', permissions: ['edit_employees'] };
const CRED_ADMIN = {
    id: 6,
    userType: 'admin',
    role: 'localadmin',
    permissions: ['edit_employees', 'reset_employee_password'],
};

beforeEach(() => {
    jest.clearAllMocks();
    for (const k of [
        'canAccessEmployeeData',
        'canAccessEmployee',
        'canAccessSite',
        'canAccessDepartment',
        'canAccessService',
        'canAccessCountry',
    ]) {
        RBAC[k].mockReset().mockResolvedValue(true);
    }
    mockDb.get.mockReset().mockResolvedValue(null);
    EmployeeModel.findById.mockImplementation(async (id) => {
        if (Number(id) === 142) return { ...EMP };
        return { id: Number(id), isActive: true, cancelledAt: null, siteId: 12 };
    });
    jest.spyOn(Lifecycle, 'moverFromChanges').mockResolvedValue(null);
});
afterEach(() => jest.restoreAllMocks());

describe("A-3 — changing another person's e-mail takes CREDENTIAL authority", () => {
    const takeover = { ...BODY, email: 'attacker@evil.test' };

    test("PROBE: a manager cannot rewrite a report's address", async () => {
        const req = fakeReq(MANAGER, { params: { id: '142' }, body: takeover });
        await EmployeeController.update(req, fakeRes());
        expect(EmployeeModel.update).not.toHaveBeenCalled();
        expect(errorsOf(req)[0]).toMatch(/Réinitialiser les mots de passe/);
    });

    test('PROBE: an admin holding only edit_employees cannot either', async () => {
        const req = fakeReq(EDITOR, { params: { id: '142' }, body: takeover });
        await EmployeeController.update(req, fakeRes());
        expect(EmployeeModel.update).not.toHaveBeenCalled();
    });

    test('reset_employee_password may — and outstanding reset links die, the OLD address is told', async () => {
        const req = fakeReq(CRED_ADMIN, {
            params: { id: '142' },
            body: { ...BODY, email: 'new@corp.test' },
        });
        await EmployeeController.update(req, fakeRes());
        expect(EmployeeModel.update).toHaveBeenCalledTimes(1);
        expect(EmployeeModel.update.mock.calls[0][1].email).toBe('new@corp.test');
        const burn = mockDb.run.mock.calls.find(([sql]) =>
            /DELETE FROM password_reset_tokens/.test(sql)
        );
        expect(burn).toBeDefined();
        expect(burn[1]).toEqual(['employee', 142]);
        expect(EmailService.send).toHaveBeenCalledWith(
            expect.objectContaining({ to: 'owner@corp.test' })
        );
    });

    test('an unchanged address needs no credential authority (a manager edits the phone)', async () => {
        const req = fakeReq(MANAGER, { params: { id: '142' }, body: { ...BODY, phone: '0102' } });
        await EmployeeController.update(req, fakeRes());
        expect(EmployeeModel.update).toHaveBeenCalledTimes(1);
        expect(mockDb.run.mock.calls.some(([sql]) => /password_reset_tokens/.test(sql))).toBe(
            false
        );
    });
});

describe("A-3 / S-08 — /account: changing one's own address needs the current password", () => {
    let hash;
    beforeAll(async () => {
        hash = await bcrypt.hash('Secret#2026', 4);
    });
    const me = { id: 84, userType: 'employee', username: 'me' };
    const own = (extra = {}) => ({
        id: 84,
        email: 'me@corp.test',
        firstName: 'M',
        lastName: 'E',
        passwordHash: hash,
        ...extra,
    });

    test('PROBE: without the password the address is not changed', async () => {
        EmployeeModel.findById.mockResolvedValue(own());
        const req = fakeReq(me, { body: { email: 'thief@evil.test' } });
        await AuthController.updateProfile(req, fakeRes());
        expect(EmployeeModel.update).not.toHaveBeenCalled();
        expect(errorsOf(req)[0]).toMatch(/mot de passe actuel/);
    });

    test('a WRONG password is refused', async () => {
        EmployeeModel.findById.mockResolvedValue(own());
        const req = fakeReq(me, { body: { email: 'thief@evil.test', currentPassword: 'nope' } });
        await AuthController.updateProfile(req, fakeRes());
        expect(EmployeeModel.update).not.toHaveBeenCalled();
    });

    test('the right password changes it, burns reset links and tells the old address', async () => {
        EmployeeModel.findById.mockResolvedValue(own());
        const req = fakeReq(me, {
            body: { email: 'me2@corp.test', currentPassword: 'Secret#2026' },
        });
        await AuthController.updateProfile(req, fakeRes());
        expect(EmployeeModel.update).toHaveBeenCalledWith(84, {
            email: 'me2@corp.test',
            phone: null,
        });
        expect(
            mockDb.run.mock.calls.some(([sql]) => /DELETE FROM password_reset_tokens/.test(sql))
        ).toBe(true);
        expect(EmailService.send).toHaveBeenCalledWith(
            expect.objectContaining({ to: 'me@corp.test' })
        );
    });

    test('an SSO-only account (no local password) is refused with a clear message', async () => {
        EmployeeModel.findById.mockResolvedValue(own({ passwordDisabled: true }));
        const req = fakeReq(me, { body: { email: 'me2@corp.test', currentPassword: 'x' } });
        await AuthController.updateProfile(req, fakeRes());
        expect(EmployeeModel.update).not.toHaveBeenCalled();
        expect(errorsOf(req)[0]).toMatch(/SSO/);
    });

    test('a phone-only change needs no password', async () => {
        EmployeeModel.findById.mockResolvedValue(own());
        const req = fakeReq(me, { body: { email: 'me@corp.test', phone: '0707' } });
        await AuthController.updateProfile(req, fakeRes());
        expect(EmployeeModel.update).toHaveBeenCalledWith(84, {
            email: 'me@corp.test',
            phone: '0707',
        });
    });

    test('an ADMIN changing their own address needs their password too', async () => {
        AdminModel.findById.mockResolvedValue({
            id: 1,
            username: 'admin',
            email: 'a@corp.test',
            passwordHash: hash,
        });
        const req = fakeReq(
            { id: 1, userType: 'admin', role: 'localadmin' },
            { body: { email: 'b@evil.test' } }
        );
        await AuthController.updateProfile(req, fakeRes());
        expect(AdminModel.update).not.toHaveBeenCalled();
    });
});

describe('A-4 — update() checks where the form MOVES the person and whom it wires in', () => {
    test('PROBE: a scoped admin cannot move an in-scope employee into another site', async () => {
        jest.spyOn(adminScope, 'resolveAdminScope').mockResolvedValue({
            unrestricted: false,
            departmentIds: [21],
            serviceIds: [31],
        });
        DepartmentModel.findById.mockResolvedValue({ id: 22, siteId: 12 });
        ServiceModel.findById.mockResolvedValue({ id: 32, departmentId: 22 });
        const req = fakeReq(EDITOR, {
            params: { id: '142' },
            body: { ...BODY, siteId: '12', departmentId: '22', serviceId: '32' },
        });
        await EmployeeController.update(req, fakeRes());
        expect(EmployeeModel.update).not.toHaveBeenCalled();
    });

    test('PROBE: a scoped admin cannot name an out-of-scope NEW supervisor', async () => {
        RBAC.canAccessEmployeeData.mockImplementation(async (_u, e) => Number(e.id) === 142);
        const req = fakeReq(EDITOR, {
            params: { id: '142' },
            body: { ...BODY, supervisorId: '3' },
        });
        await EmployeeController.update(req, fakeRes());
        expect(EmployeeModel.update).not.toHaveBeenCalled();
        expect(errorsOf(req)[0]).toMatch(/superviseur est hors/);
    });

    test('PROBE: a scoped admin cannot name an out-of-scope NEW employee-manager', async () => {
        RBAC.canAccessEmployee.mockResolvedValue(false);
        const req = fakeReq(EDITOR, {
            params: { id: '142' },
            body: { ...BODY, manager: 'employee:3' },
        });
        await EmployeeController.update(req, fakeRes());
        expect(EmployeeModel.update).not.toHaveBeenCalled();
        expect(errorsOf(req)[0]).toMatch(/manager est hors/);
    });

    test('an in-scope edit with an unchanged placement still saves', async () => {
        const req = fakeReq(EDITOR, {
            params: { id: '142' },
            body: { ...BODY, supervisorId: '3' },
        });
        await EmployeeController.update(req, fakeRes());
        expect(EmployeeModel.update).toHaveBeenCalledTimes(1);
    });
});

describe('A-5 — one strict id for the guard and the handler', () => {
    const { parseStrictId, checkEmployeeAccess } = require('../../src/middleware/rbac');
    test('`137e1`, `0x89`, `12abc` are not ids', () => {
        for (const bad of ['137e1', '0x89', '12abc', '', '-3', '1.5'])
            expect(parseStrictId(bad)).toBeNaN();
        expect(parseStrictId('137')).toBe(137);
        expect(parseStrictId(137)).toBe(137);
    });
    test('PROBE: checkEmployeeAccess refuses `137e1` instead of authorising 137', async () => {
        const res = fakeRes();
        const next = jest.fn();
        await checkEmployeeAccess(fakeReq(EDITOR, { params: { id: '137e1' } }), res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.o.status).toBe(400);
        expect(RBAC.canAccessEmployee).not.toHaveBeenCalled();
    });
    test('the handler never reads a different id than the one authorised', async () => {
        const Ctrl = require('../../src/controllers/EmployeeProgressController');
        const res = fakeRes();
        await Ctrl.data(fakeReq(EDITOR, { params: { id: '137e1' } }), res);
        expect(res.o.status).toBe(400);
        expect(mockDb.get).not.toHaveBeenCalled();
        expect(mockDb.all).not.toHaveBeenCalled();
    });
});

describe('A-6 — organisation writes check the perimeter (SuperAdmin unrestricted)', () => {
    const ORG = {
        id: 7,
        userType: 'admin',
        role: 'localadmin',
        permissions: ['manage_organization'],
    };

    test("PROBE: sitesDelete refuses a site outside the delegate's scope", async () => {
        RBAC.canAccessSite.mockResolvedValue(false);
        mockDb.get.mockResolvedValue({ n: 0 });
        await OrganizationController.sitesDelete(fakeReq(ORG, { params: { id: '12' } }), fakeRes());
        expect(SiteModel.update).not.toHaveBeenCalled();
    });

    test('PROBE: departmentsUpdate cannot re-parent to a site the delegate does not govern', async () => {
        RBAC.canAccessDepartment.mockResolvedValue(true);
        RBAC.canAccessSite.mockImplementation(async (_u, id) => Number(id) === 11);
        DepartmentModel.findById.mockResolvedValue({ id: 21, siteId: 11 });
        const req = fakeReq(ORG, { params: { id: '21' }, body: { siteId: '12', name: 'Mine' } });
        await OrganizationController.departmentsUpdate(req, fakeRes());
        expect(DepartmentModel.update).not.toHaveBeenCalled();
    });

    test('a plain rename (same parent) still saves', async () => {
        DepartmentModel.findById.mockResolvedValue({ id: 21, siteId: 11 });
        const req = fakeReq(ORG, { params: { id: '21' }, body: { siteId: '11', name: 'Renamed' } });
        await OrganizationController.departmentsUpdate(req, fakeRes());
        expect(DepartmentModel.update).toHaveBeenCalledTimes(1);
    });

    test('PROBE: servicesUpdate cannot re-parent to a department outside scope', async () => {
        RBAC.canAccessService.mockResolvedValue(true);
        RBAC.canAccessDepartment.mockImplementation(async (_u, id) => Number(id) === 21);
        ServiceModel.findById.mockResolvedValue({ id: 31, departmentId: 21 });
        const req = fakeReq(ORG, { params: { id: '31' }, body: { departmentId: '22', name: 'S' } });
        await OrganizationController.servicesUpdate(req, fakeRes());
        expect(ServiceModel.update).not.toHaveBeenCalled();
    });

    test('PROBE: sitesUpdate cannot move the site into a country the delegate does not govern', async () => {
        RBAC.canAccessSite.mockResolvedValue(true);
        RBAC.canAccessCountry.mockImplementation(async (_u, id) => Number(id) === 9);
        mockDb.get.mockResolvedValue(null); // no region scope either
        SiteModel.findById.mockResolvedValue({ id: 11, countryId: 9 });
        const req = fakeReq(ORG, { params: { id: '11' }, body: { name: 'Site', countryId: '8' } });
        await OrganizationController.sitesUpdate(req, fakeRes());
        expect(SiteModel.update).not.toHaveBeenCalled();
    });

    test('a SuperAdmin moves it freely', async () => {
        SiteModel.findById.mockResolvedValue({ id: 11, countryId: 9 });
        const req = fakeReq(
            { id: 1, userType: 'admin', role: 'superadmin' },
            { params: { id: '11' }, body: { name: 'Site', countryId: '8' } }
        );
        await OrganizationController.sitesUpdate(req, fakeRes());
        expect(SiteModel.update).toHaveBeenCalledTimes(1);
    });
});
