'use strict';

/**
 * MfaService hardening.
 *   - issueBackupCodes: a new set invalidates the unused older codes, in the
 *     same transaction (it used to be additive).
 */
const mockDb = {
    get: jest.fn(),
    all: jest.fn(async () => []),
    run: jest.fn(async () => ({ changes: 1 })),
    runTransaction: jest.fn(async (fn) => fn()),
};
jest.mock('../../src/config/database', () => mockDb);
jest.mock('bcrypt', () => ({
    hash: jest.fn(async (p) => 'h:' + p),
    compare: jest.fn(async () => false),
}));

const ENV = { ...process.env };
const APP_KEY = 'a'.repeat(16) + 'b'.repeat(16) + 'c'.repeat(16);

function fresh(env) {
    process.env = { ...ENV, ...env };
    for (const k of Object.keys(env)) if (env[k] === undefined) delete process.env[k];
    let M;
    jest.isolateModules(() => {
        M = require('../../src/services/MfaService');
    });
    return M;
}
afterAll(() => {
    process.env = ENV;
});
beforeEach(() => {
    mockDb.get.mockReset();
    mockDb.run.mockReset().mockResolvedValue({ changes: 1 });
    mockDb.runTransaction.mockClear();
});

describe('issueBackupCodes', () => {
    test('invalidates every UNUSED old code in the same transaction as the new set', async () => {
        const M = fresh({ APP_KEY, NODE_ENV: 'test' });
        const codes = await M.issueBackupCodes({ userType: 'employee', userId: 9, count: 3 });
        expect(codes).toHaveLength(3);
        expect(new Set(codes).size).toBe(3);
        expect(mockDb.runTransaction).toHaveBeenCalledTimes(1);
        const sqls = mockDb.run.mock.calls.map(([s]) => s);
        expect(sqls[0]).toMatch(/DELETE FROM mfa_backup_codes[\s\S]*used_at IS NULL/);
        expect(sqls.filter((s) => /INSERT INTO mfa_backup_codes/.test(s))).toHaveLength(3);
        // used codes are kept (the DELETE is limited to unused ones)
        expect(sqls[0]).not.toMatch(/used_at IS NOT NULL/);
    });
});
