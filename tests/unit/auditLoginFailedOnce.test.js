'use strict';

/**
 * The password strategy tries the ADMIN table first, then the EMPLOYEE table
 * (middleware/auth.js). AuthService used to write a "LOGIN_FAILED … unknown
 * identifier" row as soon as the ADMIN lookup missed, so every ordinary
 * employee sign-in, even a SUCCESSFUL one, left a spurious failure in the
 * security trail. A failure is now written only when the attempt really fails:
 * unknown to BOTH tables → one row (employee side, fingerprint only); a real
 * admin refused → one admin row.
 *
 * Anti-enumeration timing is unchanged: the unknown-to-admin branch still burns
 * one bcrypt comparison. Mocked database, the strategy's call order reproduced.
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
const mockLog = jest.fn(async () => {});
jest.mock('../../src/services/LogService', () => ({ log: (...a) => mockLog(...a) }));
jest.mock('../../src/models/PasswordHistoryModel', () => ({
    addPassword: jest.fn(),
    getRecentPasswords: jest.fn(async () => []),
}));
jest.mock('../../src/utils/dummyBcrypt', () => ({
    dummyCompare: (pw) => mockCompare(pw, '$2b$10$dummy'),
}));

const AuthService = require('../../src/services/AuthService');
const EmployeeAuthService = require('../../src/services/EmployeeAuthService');
const req = { ip: '192.0.2.4', get: () => 'jest' };

/** The LocalStrategy's order (non-enforced path): admin first, then employee. */
async function strategy(user, pw) {
    const a = await AuthService.login(user, pw, req);
    if (a.success) return { as: 'admin' };
    const e = await EmployeeAuthService.login(user, pw, req);
    return e.success ? { as: 'employee' } : { as: null };
}
const failures = () =>
    mockLog.mock.calls.map((c) => c[0]).filter((r) => /LOGIN_FAILED$/.test(r.action));

const EMP = { id: 84, username: 'nfenwick', isAccountActive: true, passwordHash: 'h' };
const ADM = { id: 3, username: 'okeller', isActive: true, passwordHash: 'h' };

beforeEach(() => {
    mockCompare.mockReset();
    mockCompare.mockResolvedValue(false);
    mockLog.mockClear();
    mockAdmin.findByUsername.mockReset();
    mockEmp.findByUsername.mockReset();
    mockAdmin.findByUsername.mockImplementation(async (u) => (u === ADM.username ? ADM : null));
    mockEmp.findByUsername.mockImplementation(async (u) => (u === EMP.username ? EMP : null));
});

describe('one failure row only when the attempt really fails', () => {
    test('an employee who signs in successfully leaves NO failure row', async () => {
        mockCompare.mockImplementation(async (pw, hash) => hash === 'h' && pw === 'good');
        expect(await strategy('nfenwick', 'good')).toEqual({ as: 'employee' });
        expect(failures()).toEqual([]);
    });

    test('an employee with a wrong password → exactly one row, about the employee', async () => {
        expect(await strategy('nfenwick', 'bad')).toEqual({ as: null });
        const f = failures();
        expect(f).toHaveLength(1);
        expect(f[0]).toMatchObject({ action: 'EMPLOYEE_LOGIN_FAILED', entityId: 84 });
        expect(f[0].details).not.toMatch(/nfenwick/);
    });

    test('an identifier unknown to BOTH tables → exactly one row, fingerprint only', async () => {
        await strategy('sam.typo', 'pw');
        const f = failures();
        expect(f).toHaveLength(1);
        expect(f[0].details).toMatch(/unknown/);
        expect(f[0].details).toMatch(/fp:[0-9a-f]{10}/);
        expect(f[0].details).not.toMatch(/sam\.typo/);
    });

    test('a real admin with a wrong password → one admin row', async () => {
        await strategy('okeller', 'bad');
        const f = failures();
        expect(f).toHaveLength(1);
        expect(f[0]).toMatchObject({ action: 'LOGIN_FAILED', entityType: 'admin', entityId: 3 });
        expect(f[0].details).not.toMatch(/okeller/);
    });

    test('an inactive admin is still recorded by the admin side', async () => {
        mockAdmin.findByUsername.mockResolvedValue({ ...ADM, isActive: false });
        const out = await AuthService.login('okeller', 'pw', req);
        expect(out.success).toBe(false);
        expect(failures()).toEqual([
            expect.objectContaining({ action: 'LOGIN_FAILED', entityType: 'admin', entityId: 3 }),
        ]);
    });
});

describe('anti-enumeration timing is kept', () => {
    test('unknown to the admin table still costs one bcrypt and answers the same', async () => {
        const out = await AuthService.login('nfenwick', 'pw', req);
        expect(mockCompare).toHaveBeenCalledTimes(1);
        expect(out).toEqual({ success: false, message: 'Invalid credentials' });
    });

    test('every failing path of the strategy costs the same two comparisons', async () => {
        for (const who of ['nfenwick', 'sam.typo', 'okeller']) {
            mockCompare.mockClear();
            await strategy(who, 'bad');
            expect([who, mockCompare.mock.calls.length]).toEqual([who, 2]);
        }
    });
});
