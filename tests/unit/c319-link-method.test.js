'use strict';
/**
 * 3.23.19 security committee N2 + S4 — the link_method an identity is recorded with.
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
    // 3.23.20 (C1b): the identity upsert is `INSERT … RETURNING id` (db.get) — a
    // row back means "written for this account", none means "held elsewhere".
    mockDb.get.mockImplementation(async (sql) =>
        /INSERT INTO user_identities/.test(String(sql)) ? { id: 1 } : null
    );
    mockDb.all.mockResolvedValue([]);
    mockDb.run.mockResolvedValue(undefined);
    mockDb.runTransaction.mockImplementation((fn) => fn());
    RBACService.canAccessEmployeeData.mockResolvedValue(true);
    RBACService.canAccessEmployee.mockResolvedValue(true);
});

const linkMethodWritten = () => {
    const ins = [...mockDb.get.mock.calls, ...mockDb.run.mock.calls].find((c) =>
        /INSERT INTO user_identities/.test(c[0])
    );
    return ins ? ins[1][7] : undefined;
};

describe('S4/N2 — link_method on a manual link and on an onboarding merge', () => {
    beforeEach(() => {
        EmployeeModel.findById.mockResolvedValue({ id: 2, username: 'jdoe', email: 'a@x.com' });
        OnboardingRequestModel.findById.mockResolvedValue({
            id: 1,
            status: 'pending',
            authProvider: 'entra',
            externalId: 'oid-9',
            email: 'a@x.com',
        });
    });

    test('a SuperAdmin link is superadmin_link; a delegate link is delegated_link', async () => {
        await ALS.linkSsoIdentity(
            { targetType: 'employee', targetId: 2, provider: 'entra', externalId: 'o1' },
            SUPER
        );
        expect(linkMethodWritten()).toBe('superadmin_link');
        mockDb.run.mockClear();
        mockDb.get.mockClear();
        await ALS.linkSsoIdentity(
            { targetType: 'employee', targetId: 2, provider: 'entra', externalId: 'o2' },
            ONBOARDER
        );
        expect(linkMethodWritten()).toBe('delegated_link');
    });

    test('N2 — an onboarding merge is trusted (onboarding_merge) ONLY when a SuperAdmin performs it', async () => {
        const r1 = await ALS.mergeOnboardingRequest(
            { requestId: 1, targetType: 'employee', targetId: 2 },
            SUPER
        );
        expect(r1.ok).toBe(true);
        expect(linkMethodWritten()).toBe('onboarding_merge');
        mockDb.run.mockClear();
        mockDb.get.mockClear();
        const r2 = await ALS.mergeOnboardingRequest(
            { requestId: 1, targetType: 'employee', targetId: 2 },
            ONBOARDER
        );
        expect(r2.ok).toBe(true);
        expect(linkMethodWritten()).toBe('delegated_link');
    });

    test('N2 — an inactive SuperAdmin actor is not trusted either', async () => {
        await ALS.linkSsoIdentity(
            { targetType: 'employee', targetId: 2, provider: 'entra', externalId: 'o3' },
            { ...SUPER, isActive: false }
        );
        expect(linkMethodWritten()).toBe('delegated_link');
    });
});
