'use strict';
/** Auth login accepts username OR email (admins and employees). */
jest.mock('bcrypt', () => ({ compare: jest.fn(async () => true), hash: jest.fn(async () => 'h') }));
const mockAdmin = {
    findByUsername: jest.fn(),
    findByEmail: jest.fn(),
    findById: jest.fn(),
    update: jest.fn(async () => {}),
};
const mockEmp = {
    findByUsername: jest.fn(),
    findByEmail: jest.fn(),
    findById: jest.fn(),
    update: jest.fn(async () => {}),
};
jest.mock('../../src/models/AdminModel', () => mockAdmin);
jest.mock('../../src/models/EmployeeModel', () => mockEmp);
// Login by e-mail resolves through EmailAccountsService (one address may belong
// to several accounts since migration 107): the lookup is a db.all, then findById.
const mockDb = { get: jest.fn(), all: jest.fn(async () => []), run: jest.fn(async () => ({})) };
jest.mock('../../src/config/database', () => mockDb);
jest.mock('../../src/services/LogService', () => ({ log: jest.fn(async () => {}) }));
jest.mock('../../src/models/PasswordHistoryModel', () => ({
    addPassword: jest.fn(),
    getRecentPasswords: jest.fn(async () => []),
}));

const AuthService = require('../../src/services/AuthService');
const EmployeeAuthService = require('../../src/services/EmployeeAuthService');
const req = { ip: '1.2.3.4', get: () => 'jest' };

beforeEach(() => {
    [mockAdmin, mockEmp].forEach((m) =>
        Object.values(m).forEach((f) => f.mockReset && f.mockReset())
    );
    mockAdmin.update.mockResolvedValue({});
    mockEmp.update.mockResolvedValue({});
    mockDb.all.mockReset().mockResolvedValue([]);
});

describe('admin login', () => {
    test('logs in by email when not found by username', async () => {
        mockAdmin.findByUsername.mockResolvedValue(null);
        mockDb.all.mockResolvedValue([{ id: 1, username: 'boss', email: 'boss@x.io' }]);
        mockAdmin.findById.mockResolvedValue({
            id: 1,
            username: 'boss',
            email: 'boss@x.io',
            isActive: true,
            passwordHash: 'h',
        });
        const r = await AuthService.login('boss@x.io', 'pw', req);
        expect(r.success).toBe(true);
        expect(mockDb.all.mock.calls[0][1]).toEqual(['boss@x.io']);
        expect(mockAdmin.findById).toHaveBeenCalledWith(1);
    });
    test('an address shared by two admins is refused as a policy (no guess, no lockout tally)', async () => {
        mockAdmin.findByUsername.mockResolvedValue(null);
        mockDb.all.mockResolvedValue([
            { id: 1, username: 'boss' },
            { id: 2, username: 'boss2' },
        ]);
        const r = await AuthService.login('boss@x.io', 'pw', req);
        expect(r).toMatchObject({ success: false, policyRefusal: true, code: 'EMAIL_AMBIGUOUS' });
        expect(mockAdmin.findById).not.toHaveBeenCalled();
    });
    test('does not attempt email lookup for a plain username', async () => {
        mockAdmin.findByUsername.mockResolvedValue(null);
        const r = await AuthService.login('boss', 'pw', req);
        expect(r.success).toBe(false);
        expect(mockDb.all).not.toHaveBeenCalled();
    });
});

describe('employee login', () => {
    test('logs in by email (self-onboarded users) when username lookup misses', async () => {
        mockEmp.findByUsername.mockResolvedValue(null);
        mockDb.all.mockResolvedValue([{ id: 9, username: 'new.user', email: 'new.user@x.io' }]);
        mockEmp.findById.mockResolvedValue({
            id: 9,
            username: 'new.user',
            email: 'new.user@x.io',
            isAccountActive: true,
            passwordHash: 'h',
            firstName: 'New',
            lastName: 'User',
        });
        const r = await EmployeeAuthService.login('new.user@x.io', 'pw', req);
        expect(r.success).toBe(true);
        expect(r.employee.id).toBe(9);
        expect(mockDb.all.mock.calls[0][1]).toEqual(['new.user@x.io']);
        expect(mockEmp.findById).toHaveBeenCalledWith(9);
    });
    test('an address shared by two employees is refused as a policy (username required)', async () => {
        mockEmp.findByUsername.mockResolvedValue(null);
        mockDb.all.mockResolvedValue([
            { id: 9, username: 'a' },
            { id: 10, username: 'b' },
        ]);
        const r = await EmployeeAuthService.login('shared@x.io', 'pw', req);
        expect(r).toMatchObject({ success: false, policyRefusal: true, code: 'EMAIL_AMBIGUOUS' });
        expect(mockEmp.findById).not.toHaveBeenCalled();
    });
    test('still logs in by username', async () => {
        mockEmp.findByUsername.mockResolvedValue({
            id: 9,
            username: 'jdoe',
            isAccountActive: true,
            passwordHash: 'h',
            firstName: 'J',
            lastName: 'D',
        });
        const r = await EmployeeAuthService.login('jdoe', 'pw', req);
        expect(r.success).toBe(true);
        expect(mockDb.all).not.toHaveBeenCalled();
    });
});
