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

const crypto = require('crypto');

function legacyEncrypt(plain, key) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]);
}

describe('verifyAndConfirm', () => {
    test('an ALREADY CONFIRMED secret is refused: no new confirmation, no backup codes', async () => {
        const M = fresh({ APP_KEY, NODE_ENV: 'test' });
        const secretEnc = M._crypto.encrypt('JBSWY3DPEHPK3PXP');
        mockDb.get.mockResolvedValue({ secretEnc, confirmedAt: new Date() });
        const code = require('otplib').authenticator.generate('JBSWY3DPEHPK3PXP');
        await expect(M.verifyAndConfirm({ userType: 'admin', userId: 1, code })).resolves.toBe(
            false
        );
        expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('an unconfirmed secret is confirmed once; the code is consumed (a replay is refused)', async () => {
        const M = fresh({ APP_KEY, NODE_ENV: 'test' });
        const secretEnc = M._crypto.encrypt('JBSWY3DPEHPK3PXP');
        const code = require('otplib').authenticator.generate('JBSWY3DPEHPK3PXP');
        mockDb.get.mockImplementation(async (sql) =>
            /FROM mfa_secrets/.test(sql) ? { secretEnc, confirmedAt: null } : { id: 1 }
        );
        await expect(M.verifyAndConfirm({ userType: 'admin', userId: 1, code })).resolves.toBe(
            true
        );
        const upd = mockDb.run.mock.calls.find(([s]) => /SET confirmed_at = now\(\)/.test(s));
        expect(upd[0]).toMatch(/confirmed_at IS NULL/);
        mockDb.get.mockImplementation(async (sql) =>
            /FROM mfa_secrets/.test(sql) ? { secretEnc, confirmedAt: null } : undefined
        );
        await expect(M.verifyAndConfirm({ userType: 'admin', userId: 1, code })).resolves.toBe(
            false
        );
    });
});

describe('secret encryption v2', () => {
    test('new secrets are v2 (MFA2 prefix) and do NOT open with the legacy 32-char key', () => {
        const M = fresh({ APP_KEY, NODE_ENV: 'test' });
        const blob = M._crypto.encrypt('SECRET');
        expect(blob.subarray(0, 4).toString('ascii')).toBe('MFA2');
        expect(M._crypto.decryptWithVersion(blob)).toEqual({ secret: 'SECRET', legacy: false });
        const legacyKey = Buffer.from(APP_KEY.slice(0, 32));
        const o = 4;
        const d = crypto.createDecipheriv('aes-256-gcm', legacyKey, blob.subarray(o, o + 12), {
            authTagLength: 16,
        });
        d.setAuthTag(blob.subarray(o + 12, o + 28));
        expect(() => Buffer.concat([d.update(blob.subarray(o + 28)), d.final()])).toThrow();
    });

    test('a legacy v1 blob still decrypts, and is re-encrypted after a successful sign-in', async () => {
        const M = fresh({ APP_KEY, NODE_ENV: 'test' });
        const legacy = legacyEncrypt('JBSWY3DPEHPK3PXP', Buffer.from(APP_KEY.slice(0, 32)));
        expect(M._crypto.decryptWithVersion(legacy)).toEqual({
            secret: 'JBSWY3DPEHPK3PXP',
            legacy: true,
        });
        mockDb.get.mockImplementation(async (sql) =>
            /FROM mfa_secrets/.test(sql)
                ? { secretEnc: legacy, confirmedAt: new Date() }
                : { id: 5 }
        );
        const code = require('otplib').authenticator.generate('JBSWY3DPEHPK3PXP');
        await expect(M.verifyAtLogin({ userType: 'admin', userId: 1, code })).resolves.toBe(true);
        const up = mockDb.run.mock.calls.find(([s]) => /UPDATE mfa_secrets SET secret_enc/.test(s));
        expect(up).toBeTruthy();
        expect(up[1][0].subarray(0, 4).toString('ascii')).toBe('MFA2');
        expect(up[1][3]).toBe(legacy); // optimistic: only replaces the blob it read
    });

    test('a legacy blob written under the SESSION_SECRET fallback still opens', () => {
        const M = fresh({ APP_KEY: 'short', SESSION_SECRET: 'sess-1', NODE_ENV: 'test' });
        const key = crypto.createHash('sha256').update('sess-1').digest();
        expect(M._crypto.decryptWithVersion(legacyEncrypt('ABC', key))).toEqual({
            secret: 'ABC',
            legacy: true,
        });
    });

    test('production refuses MFA crypto without APP_KEY (no SESSION_SECRET fallback)', () => {
        const M = fresh({ APP_KEY: undefined, NODE_ENV: 'production', SESSION_SECRET: 's3cr3t' });
        expect(() => M._crypto.encrypt('X')).toThrow(/APP_KEY is required/);
    });

    test('development keeps working without APP_KEY (SESSION_SECRET fallback)', () => {
        const M = fresh({ APP_KEY: undefined, NODE_ENV: 'development', SESSION_SECRET: 's3cr3t' });
        expect(M._crypto.decrypt(M._crypto.encrypt('X'))).toBe('X');
    });
});
