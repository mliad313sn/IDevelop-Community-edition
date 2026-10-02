'use strict';

/**
 * Timing on the ordinary (non-SSO-enforced) sign-in path: an unknown, inactive
 * or not-yet-activated identifier costs the same bcrypt comparison as a real
 * account with a wrong password, in BOTH services. Without it the answer for a
 * non-existent name came about one bcrypt sooner, an enumeration oracle.
 * The dummy hash is shared with the SSO-enforced path (src/utils/dummyBcrypt.js).
 */
const mockCompare = jest.fn(async () => false);
jest.mock('bcrypt', () => ({
    compare: (...a) => mockCompare(...a),
    hash: jest.fn(async () => '$2b$10$dummy'),
}));
const mockAdmin = { findByUsername: jest.fn(), findById: jest.fn(), update: jest.fn() };
const mockEmp = { findByUsername: jest.fn(), findById: jest.fn(), update: jest.fn() };
jest.mock('../../src/models/AdminModel', () => mockAdmin);
jest.mock('../../src/models/EmployeeModel', () => mockEmp);
jest.mock('../../src/config/database', () => ({
    get: jest.fn(),
    all: jest.fn(async () => []),
    run: jest.fn(),
}));
jest.mock('../../src/services/LogService', () => ({ log: jest.fn(async () => {}) }));
jest.mock('../../src/models/PasswordHistoryModel', () => ({
    addPassword: jest.fn(),
    getRecentPasswords: jest.fn(async () => []),
}));

const AuthService = require('../../src/services/AuthService');
const EmployeeAuthService = require('../../src/services/EmployeeAuthService');
const req = { ip: '192.0.2.4', get: () => 'jest' };

beforeEach(() => {
    mockCompare.mockClear();
    mockAdmin.findByUsername.mockReset();
    mockEmp.findByUsername.mockReset();
});

describe('one bcrypt per refused identifier', () => {
    test('AuthService: unknown name costs one comparison, as a real admin does', async () => {
        mockAdmin.findByUsername.mockResolvedValue(null);
        await AuthService.login('nobody', 'pw', req);
        expect(mockCompare).toHaveBeenCalledTimes(1);
        mockCompare.mockClear();
        mockAdmin.findByUsername.mockResolvedValue({
            id: 1,
            username: 'a',
            isActive: true,
            passwordHash: 'x',
        });
        await AuthService.login('a', 'pw', req);
        expect(mockCompare).toHaveBeenCalledTimes(1);
    });

    test('AuthService: inactive admin costs one comparison', async () => {
        mockAdmin.findByUsername.mockResolvedValue({
            id: 1,
            username: 'a',
            isActive: false,
            passwordHash: 'x',
        });
        await AuthService.login('a', 'pw', req);
        expect(mockCompare).toHaveBeenCalledTimes(1);
    });

    test('AuthService: locked admin costs one comparison', async () => {
        mockAdmin.findByUsername.mockResolvedValue({
            id: 1,
            username: 'a',
            isActive: true,
            passwordHash: 'x',
            lockedUntil: new Date(Date.now() + 600000).toISOString(),
        });
        await AuthService.login('a', 'pw', req);
        expect(mockCompare).toHaveBeenCalledTimes(1);
    });

    test('EmployeeAuthService: unknown, inactive, not activated each cost one comparison', async () => {
        mockEmp.findByUsername.mockResolvedValue(null);
        mockAdmin.findByUsername.mockResolvedValue(null);
        await EmployeeAuthService.login('nobody', 'pw', req);
        expect(mockCompare).toHaveBeenCalledTimes(1);
        mockCompare.mockClear();
        mockEmp.findByUsername.mockResolvedValue({ id: 2, username: 'e', isAccountActive: false });
        await EmployeeAuthService.login('e', 'pw', req);
        expect(mockCompare).toHaveBeenCalledTimes(1);
        mockCompare.mockClear();
        mockEmp.findByUsername.mockResolvedValue({
            id: 2,
            username: 'e',
            isAccountActive: true,
            passwordHash: null,
        });
        await EmployeeAuthService.login('e', 'pw', req);
        expect(mockCompare).toHaveBeenCalledTimes(1);
    });
});
