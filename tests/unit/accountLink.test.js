'use strict';
/**
 * Unit tests for AccountLinkService — the security gating and validation of
 * account merge (SSO linking) and privilege promotion. DB/models are mocked so
 * the decision logic is exercised without a database.
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn((fn) => fn()),
};
jest.mock('../../src/config/database', () => mockDb);
jest.mock('../../src/models/AdminModel', () => ({ findById: jest.fn() }));
jest.mock('../../src/models/EmployeeModel', () => ({ findById: jest.fn() }));
jest.mock('../../src/models/OnboardingRequestModel', () => ({
    findById: jest.fn(),
    update: jest.fn(),
}));
jest.mock('../../src/models/AdminPermissionModel', () => ({
    setForAdmin: jest.fn(),
    deleteByAdminId: jest.fn(),
}));
jest.mock('../../src/models/AdminScopeModel', () => ({
    create: jest.fn(),
    deleteByAdminId: jest.fn(),
}));
jest.mock('../../src/services/LogService', () => ({ log: jest.fn().mockResolvedValue(undefined) }));
// Keep the REAL RBACService (its isSuperAdmin/hasPermission drive the permission
// gates) but stub only the two DB-backed scope resolvers. Default: in-scope (true).
// A non-super actor linking/unlinking an EMPLOYEE identity must pass a scope check
// (so a delegated admin can't graft an identity onto anyone org-wide).
jest.mock('../../src/services/RBACService', () => {
    const actual = jest.requireActual('../../src/services/RBACService');
    actual.canAccessEmployeeData = jest.fn().mockResolvedValue(true);
    actual.canAccessEmployee = jest.fn().mockResolvedValue(true);
    return actual;
});

const ALS = require('../../src/services/AccountLinkService');
const AdminModel = require('../../src/models/AdminModel');
const EmployeeModel = require('../../src/models/EmployeeModel');
const OnboardingRequestModel = require('../../src/models/OnboardingRequestModel');
const RBACService = require('../../src/services/RBACService');

const SUPER = { id: 1, role: 'superadmin', userType: 'admin', permissions: [] };
const LOCALADMIN = { id: 5, role: 'localadmin', userType: 'admin', permissions: ['manage_admins'] };
const ONBOARDER = {
    id: 6,
    role: 'localadmin',
    userType: 'admin',
    permissions: ['manage_onboarding'],
};
const NOBODY = { id: 7, role: 'viewer', userType: 'admin', permissions: [] };

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.get.mockResolvedValue(null);
    mockDb.all.mockResolvedValue([]);
    mockDb.run.mockResolvedValue(undefined);
    mockDb.runTransaction.mockImplementation((fn) => fn());
    RBACService.canAccessEmployeeData.mockResolvedValue(true);
    RBACService.canAccessEmployee.mockResolvedValue(true);
});

describe('linkSsoIdentity (merge local ↔ SSO)', () => {
    test('requires a provider and external id', async () => {
        const r = await ALS.linkSsoIdentity(
            { targetType: 'employee', targetId: 2, provider: '', externalId: '' },
            SUPER
        );
        expect(r.ok).toBe(false);
        expect(r.message).toMatch(/provider and an external/i);
    });

    test('linking an ADMIN account is SuperAdmin-only', async () => {
        const r = await ALS.linkSsoIdentity(
            { targetType: 'admin', targetId: 2, provider: 'entra', externalId: 'oid' },
            LOCALADMIN
        );
        expect(r.ok).toBe(false);
        expect(r.message).toMatch(/SuperAdmin/i);
    });

    test('linking an EMPLOYEE needs manage_onboarding or manage_admins', async () => {
        const r = await ALS.linkSsoIdentity(
            { targetType: 'employee', targetId: 2, provider: 'entra', externalId: 'oid' },
            NOBODY
        );
        expect(r.ok).toBe(false);
        expect(r.message).toMatch(/permission/i);
    });

    test('rejects an identity already held by a different account', async () => {
        EmployeeModel.findById.mockResolvedValue({ id: 2, username: 'jdoe' });
        // accountHoldingIdentity → an admin already owns entra:oid
        mockDb.get.mockImplementation((sql) =>
            /FROM admins/.test(sql)
                ? Promise.resolve({ id: 9, username: 'other' })
                : Promise.resolve(null)
        );
        const r = await ALS.linkSsoIdentity(
            { targetType: 'employee', targetId: 2, provider: 'entra', externalId: 'oid' },
            ONBOARDER
        );
        expect(r.ok).toBe(false);
        expect(r.message).toMatch(/already linked to another account/i);
        expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('happy path writes the identity and audits', async () => {
        EmployeeModel.findById.mockResolvedValue({ id: 2, username: 'jdoe' });
        // identity free; 3.23.20 (C1b): the upsert returns the row it wrote
        mockDb.get.mockImplementation(async (sql) =>
            /INSERT INTO user_identities/.test(sql) ? { id: 1 } : null
        );
        const r = await ALS.linkSsoIdentity(
            { targetType: 'employee', targetId: 2, provider: 'entra', externalId: 'oid-1' },
            ONBOARDER
        );
        expect(r.ok).toBe(true);
        expect(mockDb.run).toHaveBeenCalledWith(
            expect.stringMatching(/UPDATE employees SET auth_provider/),
            ['entra', 'oid-1', 2]
        );
    });

    test("rejects linking an EMPLOYEE outside the actor's RBAC scope", async () => {
        EmployeeModel.findById.mockResolvedValue({ id: 2, username: 'jdoe' });
        mockDb.get.mockResolvedValue(null);
        RBACService.canAccessEmployeeData.mockResolvedValue(false); // out of scope
        const r = await ALS.linkSsoIdentity(
            { targetType: 'employee', targetId: 2, provider: 'entra', externalId: 'oid-2' },
            ONBOARDER
        );
        expect(r.ok).toBe(false);
        expect(r.message).toMatch(/outside your administrative scope/i);
        expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('a SuperAdmin is not subject to the scope check', async () => {
        EmployeeModel.findById.mockResolvedValue({ id: 2, username: 'jdoe' });
        mockDb.get.mockImplementation(async (sql) =>
            /INSERT INTO user_identities/.test(sql) ? { id: 1 } : null
        );
        RBACService.canAccessEmployeeData.mockResolvedValue(false); // would block a delegate
        const r = await ALS.linkSsoIdentity(
            { targetType: 'employee', targetId: 2, provider: 'entra', externalId: 'oid-3' },
            SUPER
        );
        expect(r.ok).toBe(true); // super bypasses scope
    });

    test('3.23.20 (C1b) — an identity held by ANOTHER account is never moved by the upsert', async () => {
        EmployeeModel.findById.mockResolvedValue({ id: 2, username: 'jdoe' });
        // the holder check misses it (race) but the conditional upsert returns no row
        mockDb.get.mockResolvedValue(null);
        const r = await ALS.linkSsoIdentity(
            { targetType: 'employee', targetId: 2, provider: 'entra', externalId: 'oid-4' },
            SUPER
        );
        expect(r.ok).toBe(false);
        expect(r.code).toBe('alk_identity_taken');
        const upsert = mockDb.get.mock.calls.find((c) => /INSERT INTO user_identities/.test(c[0]));
        expect(upsert[0]).toMatch(/WHERE user_identities\.subject_type = EXCLUDED\.subject_type/);
        expect(upsert[0]).not.toMatch(/SET subject_type/);
        expect(mockDb.run).not.toHaveBeenCalledWith(
            expect.stringMatching(/UPDATE employees SET auth_provider/),
            expect.anything()
        );
    });
});

describe('grantAdminAccess (promote to admin)', () => {
    test('is SuperAdmin-only', async () => {
        const r = await ALS.grantAdminAccess({ employeeId: 2, role: 'localadmin' }, LOCALADMIN);
        expect(r.ok).toBe(false);
        expect(r.message).toMatch(/SuperAdmin/i);
    });

    test('blocks a second admin for the same employee', async () => {
        EmployeeModel.findById.mockResolvedValue({ id: 2, username: 'jdoe', email: 'j@x.com' });
        mockDb.get.mockImplementation((sql) =>
            /linked_employee_id/.test(sql)
                ? Promise.resolve({ id: 3, username: 'jdoe', is_active: true })
                : Promise.resolve(null)
        );
        const r = await ALS.grantAdminAccess({ employeeId: 2, role: 'localadmin' }, SUPER);
        expect(r.ok).toBe(false);
        expect(r.message).toMatch(/already has a linked admin/i);
    });
});

describe('revokeAdminAccess', () => {
    test('is SuperAdmin-only', async () => {
        const r = await ALS.revokeAdminAccess({ adminId: 3 }, LOCALADMIN);
        expect(r.ok).toBe(false);
        expect(r.message).toMatch(/SuperAdmin/i);
    });

    test('refuses to revoke the last active SuperAdmin', async () => {
        AdminModel.findById.mockResolvedValue({ id: 3, username: 'root', role: 'superadmin' });
        mockDb.get.mockResolvedValue({ cnt: 1 });
        const r = await ALS.revokeAdminAccess({ adminId: 3 }, { ...SUPER, id: 99 });
        expect(r.ok).toBe(false);
        expect(r.message).toMatch(/last active SuperAdmin/i);
    });

    test('refuses to revoke your own access', async () => {
        AdminModel.findById.mockResolvedValue({ id: 1, username: 'me', role: 'localadmin' });
        const r = await ALS.revokeAdminAccess({ adminId: 1 }, SUPER);
        expect(r.ok).toBe(false);
        expect(r.message).toMatch(/your own/i);
    });
});

describe('mergeOnboardingRequest', () => {
    test('requires manage_onboarding', async () => {
        const r = await ALS.mergeOnboardingRequest(
            { requestId: 1, targetType: 'employee', targetId: 2 },
            NOBODY
        );
        expect(r.ok).toBe(false);
        expect(r.message).toMatch(/permission/i);
    });

    test('rejects a local signup (no SSO identity to merge)', async () => {
        OnboardingRequestModel.findById.mockResolvedValue({
            id: 1,
            status: 'pending',
            authProvider: 'local',
            externalId: null,
            email: 'a@x.com',
        });
        const r = await ALS.mergeOnboardingRequest(
            { requestId: 1, targetType: 'employee', targetId: 2 },
            ONBOARDER
        );
        expect(r.ok).toBe(false);
        expect(r.message).toMatch(/no SSO identity/i);
    });

    test('aborts when the request email does not match the target', async () => {
        OnboardingRequestModel.findById.mockResolvedValue({
            id: 1,
            status: 'pending',
            authProvider: 'entra',
            externalId: 'oid',
            email: 'a@x.com',
        });
        EmployeeModel.findById.mockResolvedValue({
            id: 2,
            username: 'jdoe',
            email: 'DIFFERENT@x.com',
        });
        const r = await ALS.mergeOnboardingRequest(
            { requestId: 1, targetType: 'employee', targetId: 2 },
            ONBOARDER
        );
        expect(r.ok).toBe(false);
        expect(r.message).toMatch(/does not match/i);
    });
});
