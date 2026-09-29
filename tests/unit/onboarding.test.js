'use strict';
/** Unit tests for OnboardingService (gating, signup, placement). */
const mockSettings = new Map();
jest.mock('../../src/models/AppSettingsModel', () => ({
    getValue: jest.fn(async (k, d = null) => (mockSettings.has(k) ? mockSettings.get(k) : d)),
}));
// runTransaction is a pass-through in the mock (the real one wraps in BEGIN/COMMIT).
const mockDb = { get: jest.fn(async () => null), runTransaction: (fn) => fn() };
jest.mock('../../src/config/database', () => mockDb);
const mockReqModel = {
    create: jest.fn(async (r) => ({ id: 1, ...r })),
    findById: jest.fn(),
    update: jest.fn(async () => ({})),
    count: jest.fn(async () => 0),
    findPending: jest.fn(async () => []),
};
jest.mock('../../src/models/OnboardingRequestModel', () => mockReqModel);
const mockEmp = {
    findByEmployeeNumber: jest.fn(async () => null),
    findByEmail: jest.fn(async () => null),
    findByUsername: jest.fn(async () => null),
    // approve() now validates the placement: the supervisor/manager must be
    // ACTIVE, non-voided people (Lot S #8).
    findById: jest.fn(async (id) => ({ id: Number(id), isActive: true, cancelledAt: null })),
    create: jest.fn(async (d) => ({ id: 99, ...d })),
};
jest.mock('../../src/models/EmployeeModel', () => mockEmp);
jest.mock('../../src/services/LogService', () => ({ log: jest.fn(async () => {}) }));
// Placement validation (Lot S #8): service 3 → department 2 → site 1 must nest,
// and the approving admin (7) is resolved to a principal for the scope check.
jest.mock('../../src/models/DepartmentModel', () => ({
    findById: jest.fn(async (id) => ({ id: Number(id), siteId: 1 })),
}));
jest.mock('../../src/models/ServiceModel', () => ({
    findById: jest.fn(async (id) => ({ id: Number(id), departmentId: 2 })),
}));
jest.mock('../../src/models/AdminModel', () => ({
    findById: jest.fn(async (id) => ({ id: Number(id), role: 'superadmin', isActive: true })),
}));

const Svc = require('../../src/services/OnboardingService');

describe('OnboardingService', () => {
    beforeEach(() => {
        mockSettings.clear();
        mockDb.get.mockReset().mockResolvedValue(null);
        Object.values(mockReqModel).forEach((f) => f.mockClear && f.mockClear());
        Object.values(mockEmp).forEach((f) => f.mockClear && f.mockClear());
        mockReqModel.create.mockResolvedValue({ id: 1 });
        mockEmp.create.mockResolvedValue({ id: 99 });
        // default ON for signup tests
        mockSettings.set('onboarding.enabled', true);
        mockSettings.set('onboarding.allowSignup', true);
        mockSettings.set('onboarding.allowSso', true);
        mockSettings.set('onboarding.allowOpenSignup', true); // allow any-domain signup in these cases
    });

    test('signup is blocked when the feature is disabled', async () => {
        mockSettings.set('onboarding.enabled', false);
        const r = await Svc.createFromSignup({ email: 'a@x.io', password: 'Gx7#mPw2!qLz' });
        expect(r.ok).toBe(false);
        expect(r.reason).toBe('disabled');
    });

    test('signup is default-denied when no domains and open signup not opted in', async () => {
        mockSettings.set('onboarding.allowOpenSignup', false); // and allowedDomains unset
        const r = await Svc.createFromSignup({
            email: 'anyone@anywhere.com',
            password: 'Gx7#mPw2!qLz',
        });
        expect(r.ok).toBe(false);
        expect(r.reason).toBe('restricted');
    });

    test('signup respects the allowed-domains filter', async () => {
        mockSettings.set('onboarding.allowedDomains', 'acme.com');
        const r = await Svc.createFromSignup({ email: 'user@evil.com', password: 'Gx7#mPw2!qLz' });
        expect(r.ok).toBe(false);
        expect(r.reason).toBe('domain');
    });

    test('signup rejects a weak password', async () => {
        const r = await Svc.createFromSignup({ email: 'user@acme.com', password: 'weak' });
        expect(r.ok).toBe(false);
        expect(r.reason).toBe('password');
    });

    test('signup creates a pending request on the happy path', async () => {
        const r = await Svc.createFromSignup({
            email: 'New.User@Acme.com',
            firstName: 'New',
            lastName: 'User',
            password: 'Gx7#mPw2!qLz',
        });
        expect(r.ok).toBe(true);
        expect(mockReqModel.create).toHaveBeenCalledWith(
            expect.objectContaining({
                email: 'new.user@acme.com',
                source: 'signup',
                authProvider: 'local',
                status: 'pending',
            })
        );
        // password is hashed, not stored in clear
        const arg = mockReqModel.create.mock.calls[0][0];
        expect(arg.passwordHash).toBeTruthy();
        expect(arg.passwordHash).not.toBe('Abcdef1!xyz');
    });

    test('SSO onboarding parks an unknown identity when enabled', async () => {
        const r = await Svc.createFromSso({
            provider: 'entra',
            email: 'someone@acme.com',
            externalId: 'oid-1',
            name: 'Some One',
        });
        expect(r.created).toBe(true);
        expect(mockReqModel.create).toHaveBeenCalledWith(
            expect.objectContaining({
                email: 'someone@acme.com',
                source: 'sso',
                authProvider: 'entra',
                externalId: 'oid-1',
                firstName: 'Some',
                lastName: 'One',
            })
        );
    });

    test('approve requires the org placement fields', async () => {
        mockReqModel.findById.mockResolvedValue({
            id: 5,
            status: 'pending',
            email: 'p@acme.com',
            firstName: 'P',
            lastName: 'Q',
        });
        const r = await Svc.approve(
            5,
            { siteId: 1, departmentId: 2 /* missing service/role */ },
            7
        );
        expect(r.ok).toBe(false);
        expect(r.message).toMatch(/serviceId|roleId/);
        expect(mockEmp.create).not.toHaveBeenCalled();
    });

    test('approve creates the employee and marks the request approved', async () => {
        mockReqModel.findById.mockResolvedValue({
            id: 5,
            status: 'pending',
            email: 'p@acme.com',
            firstName: 'Pat',
            lastName: 'Lee',
            passwordHash: 'HASH',
            authProvider: 'local',
        });
        const r = await Svc.approve(
            5,
            { siteId: 1, departmentId: 2, serviceId: 3, roleId: 4, supervisorId: 8, managerId: 9 },
            7
        );
        expect(r.ok).toBe(true);
        expect(mockEmp.create).toHaveBeenCalledWith(
            expect.objectContaining({
                email: 'p@acme.com',
                firstName: 'Pat',
                lastName: 'Lee',
                siteId: 1,
                departmentId: 2,
                serviceId: 3,
                roleId: 4,
                supervisorId: 8,
                managerId: 9,
                managerType: 'employee',
                passwordHash: 'HASH',
                isAccountActive: true,
                isActive: true,
                forcePasswordChange: false,
            })
        );
        expect(mockReqModel.update).toHaveBeenCalledWith(
            5,
            expect.objectContaining({ status: 'approved', createdEmployeeId: 99, decidedBy: 7 })
        );
    });
});
