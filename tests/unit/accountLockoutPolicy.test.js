'use strict';

/**
 * Account policy (checkAccountLockout / recordLoginAttempt):
 *   admin  → HARD lock after 10 failures + SuperAdmin alert on the crossing;
 *   staff / unknown → never refused: SOFT lock (slowed) + notice to the person;
 *   lookup failure → fail CLOSED; per-IP ceiling high enough for a NAT'd site.
 * Also: authenticated secret checks count toward the account lockout.
 */
const mockDb = { get: jest.fn(), all: jest.fn(async () => []), run: jest.fn(async () => ({})) };
jest.mock('../../src/config/database', () => mockDb);
jest.mock('../../src/services/LogService', () => ({ log: jest.fn(() => Promise.resolve()) }));
jest.mock('../../src/services/AdminSsoService', () => ({ isEnforced: () => false }));
jest.mock('../../src/models/AppSettingsModel', () => ({ getValue: async (k, d) => d }));
const mockAttempts = {
    byName: 0,
    byIp: 0,
    getFailedAttemptsCount: jest.fn(async () => mockAttempts.byName),
    getFailedAttemptsByIP: jest.fn(async () => mockAttempts.byIp),
    recordFailedAttempt: jest.fn(async () => {}),
    recordSuccessfulLogin: jest.fn(async () => {}),
    clearFailedAttempts: jest.fn(async () => {}),
};
jest.mock('../../src/models/LoginAttemptModel', () => mockAttempts);
const mockAlert = jest.fn(async () => 1);
jest.mock('../../src/services/SuperadminAlertService', () => ({
    alert: (...a) => mockAlert(...a),
}));
const mockNotify = jest.fn(async () => ({ inapp: 'ok' }));
jest.mock('../../src/services/NotificationService', () => ({ notify: (...a) => mockNotify(...a) }));

const rl = require('../../src/middleware/rateLimiter');

function kind(k) {
    mockDb.get.mockImplementation(async (sql) => {
        if (k === 'error') throw new Error('db down');
        if (k === 'admin' && /FROM admins WHERE lower\(username\)/.test(sql))
            return { id: 3, username: 'ops.admin' };
        if (k === 'employee' && /FROM employees WHERE lower\(username\)/.test(sql))
            return { id: 77, username: 'j.doe' };
        return undefined;
    });
}

function run(username) {
    return new Promise((resolve) => {
        const delays = [];
        const spy = jest.spyOn(global, 'setTimeout').mockImplementation((fn, ms) => {
            delays.push(ms);
            fn();
            return 0;
        });
        const flashes = [];
        const done = (r) => {
            spy.mockRestore();
            resolve({ ...r, flashes, delay: delays[0] || 0 });
        };
        rl.checkAccountLockout(
            {
                method: 'POST',
                body: { username },
                ip: '10.1.1.1',
                get: () => '',
                flash: (t, m) => flashes.push([t, m]),
            },
            { redirect: (to) => done({ to }) },
            () => done({ next: true })
        );
    });
}

beforeEach(() => {
    mockAttempts.byName = 0;
    mockAttempts.byIp = 0;
    mockAlert.mockClear();
    mockNotify.mockClear();
    mockAttempts.recordFailedAttempt.mockClear();
});

describe('admins: hard lock after 10', () => {
    test('9 failures → allowed; 10 → refused', async () => {
        kind('admin');
        mockAttempts.byName = 9;
        expect((await run('ops.admin')).next).toBe(true);
        mockAttempts.byName = 10;
        const r = await run('ops.admin');
        expect(r.to).toBe('/login');
        expect(r.flashes[0][0]).toBe('error');
    });

    test('the 10th failure alerts every SuperAdmin (once, on the crossing)', async () => {
        kind('admin');
        mockAttempts.byName = 10;
        await rl.recordLoginAttempt('ops.admin', '10.1.1.1', false);
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        expect(mockAlert).toHaveBeenCalledWith(
            'security.admin_account_locked',
            expect.objectContaining({ targetAdminId: 3, hourly: true })
        );
        mockAlert.mockClear();
        mockAttempts.byName = 11;
        await rl.recordLoginAttempt('ops.admin', '10.1.1.1', false);
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        expect(mockAlert).not.toHaveBeenCalled();
    });
});

describe('staff and unknown names: never a username lock', () => {
    test.each(['employee', 'unknown'])(
        '%s with 99 failures is slowed, never refused',
        async (k) => {
            kind(k);
            mockAttempts.byName = 99;
            const r = await run(k === 'employee' ? 'j.doe' : 'nobody.here');
            expect(r.next).toBe(true);
            expect(r.delay).toBe(60000); // soft lock: capped slowdown
        }
    );

    test('below the threshold: no delay at all', async () => {
        kind('employee');
        mockAttempts.byName = 4;
        const r = await run('j.doe');
        expect(r.next).toBe(true);
        expect(r.delay).toBe(0);
    });

    test('the person is notified when the soft lock starts', async () => {
        kind('employee');
        mockAttempts.byName = 5; // default maxLoginAttempts
        await rl.recordLoginAttempt('j.doe', '10.1.1.1', false);
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        expect(mockNotify).toHaveBeenCalledWith(
            expect.objectContaining({
                userType: 'employee',
                userId: 77,
                kind: 'security.account_soft_locked',
            })
        );
    });
});

describe('per-IP ceiling is NAT-friendly', () => {
    test('99 failures from one address → still allowed; 100 → refused', async () => {
        kind('employee');
        mockAttempts.byIp = 99;
        expect((await run('j.doe')).next).toBe(true);
        mockAttempts.byIp = 100;
        expect((await run('j.doe')).to).toBe('/login');
    });
});

describe('fail closed', () => {
    test('an identifier we cannot resolve (DB error) is refused, not waved through', async () => {
        kind('error');
        const r = await run('whoever');
        expect(r.to).toBe('/login');
        expect(r.next).toBeUndefined();
    });

    test('a known staff account whose counter read fails still proceeds (password check applies)', async () => {
        kind('employee');
        mockAttempts.getFailedAttemptsCount.mockRejectedValueOnce(new Error('boom'));
        expect((await run('j.doe')).next).toBe(true);
    });

    test('an admin whose counter read fails is refused', async () => {
        kind('admin');
        mockAttempts.getFailedAttemptsCount.mockRejectedValueOnce(new Error('boom'));
        expect((await run('ops.admin')).to).toBe('/login');
    });
});

describe('authenticated secret checks count toward the account lockout', () => {
    test('noteAuthenticatedFailure records a failed attempt under the account name', async () => {
        mockDb.get.mockImplementation(async (sql) =>
            /SELECT username FROM employees WHERE id = \?/.test(sql) ||
            /FROM employees WHERE lower\(username\)/.test(sql)
                ? { id: 77, username: 'j.doe' }
                : undefined
        );
        await rl.noteAuthenticatedFailure(
            { id: 77, userType: 'manager', username: 'j.doe' },
            '10.2.2.2'
        );
        expect(mockAttempts.recordFailedAttempt).toHaveBeenCalledWith('j.doe', '10.2.2.2');
    });

    // CodeQL js/user-controlled-bypass: the username carried on the object
    // (session mfaPending) never picks the bucket, nor skips the record.
    test('a username carried on the session is ignored: the id decides the bucket', async () => {
        mockAttempts.recordFailedAttempt.mockClear();
        mockDb.get.mockImplementation(async (sql) =>
            /SELECT username FROM admins WHERE id = \?/.test(sql) ||
            /FROM admins WHERE lower\(username\)/.test(sql)
                ? { id: 3, username: 'ops.admin' }
                : undefined
        );
        await rl.noteAuthenticatedFailure(
            { id: 3, userType: 'admin', username: 'someone-else' },
            '10.2.2.4'
        );
        expect(mockAttempts.recordFailedAttempt).toHaveBeenCalledWith('ops.admin', '10.2.2.4');
        expect(mockAttempts.recordFailedAttempt).not.toHaveBeenCalledWith(
            'someone-else',
            expect.anything()
        );
    });

    test('an object with a username but no id records nothing', async () => {
        mockAttempts.recordFailedAttempt.mockClear();
        await rl.noteAuthenticatedFailure({ userType: 'admin', username: 'ops.admin' }, '10.2.2.5');
        expect(mockAttempts.recordFailedAttempt).not.toHaveBeenCalled();
    });

    test('without a username on the session, the name is looked up by id', async () => {
        mockDb.get.mockImplementation(async (sql) =>
            /SELECT username FROM admins WHERE id = \?/.test(sql)
                ? { username: 'ops.admin' }
                : /FROM admins WHERE lower\(username\)/.test(sql)
                  ? { id: 3, username: 'ops.admin' }
                  : undefined
        );
        await rl.noteAuthenticatedFailure({ id: 3, userType: 'admin' }, '10.2.2.3');
        expect(mockAttempts.recordFailedAttempt).toHaveBeenCalledWith('ops.admin', '10.2.2.3');
    });
});
