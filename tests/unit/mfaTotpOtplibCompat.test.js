'use strict';

/**
 * otplib 12 -> 13 compatibility guard for TOTP verification.
 *
 * v13 dropped `authenticator.check(code, secret)` + `{ window: 1 }` for
 * `verifySync({ secret, token, epochTolerance })`, and throws on a malformed
 * token where v12 returned false. These tests pin the behaviour enrolled users
 * depend on, against an independent RFC 6238 reference (Node crypto, no otplib):
 *   - a secret produced by beginSetup (20 random bytes, unpadded base32, as
 *     stored since v12) still verifies;
 *   - the previous, current and next 30s step are accepted, two steps away is not;
 *   - a malformed code is a plain `false`, never an exception.
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const crypto = require('crypto');

// otplib 13's crypto/base32 plugins are ES modules: load them through Node's own
// loader, as production does (see tests/helpers/nativeEsmEnvironment.js).
jest.mock('otplib', () => globalThis.__nativeRequire('otplib'));

const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);

const MfaService = require('../../src/services/MfaService');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(s) {
    let bits = '';
    for (const ch of s) bits += B32.indexOf(ch).toString(2).padStart(5, '0');
    const out = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
    return Buffer.from(out);
}

/** RFC 6238 TOTP, SHA1, 6 digits, 30s step. */
function referenceTotp(secret, unixSeconds) {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(unixSeconds / 30)));
    const h = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
    const o = h[h.length - 1] & 0xf;
    const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
    return String(bin % 1e6).padStart(6, '0');
}

async function enrol() {
    let enc = null;
    mockDb.run.mockImplementation(async (sql, params) => {
        if (/INSERT INTO mfa_secrets/i.test(sql)) enc = params[2];
        return { changes: 1 };
    });
    const { secret } = await MfaService.beginSetup({
        userType: 'admin',
        userId: 42,
        accountLabel: 'compat@example.test',
    });
    mockDb.get.mockResolvedValue({ secretEnc: enc });
    return secret;
}

const confirm = (code) => MfaService.verifyAndConfirm({ userType: 'admin', userId: 42, code });

beforeEach(() => {
    jest.clearAllMocks();
});

describe('TOTP verification after the otplib 13 upgrade', () => {
    test('the stored secret format is unchanged (32 base32 chars, 20 bytes)', async () => {
        const secret = await enrol();
        expect(secret).toMatch(/^[A-Z2-7]{32}$/);
        expect(base32Decode(secret)).toHaveLength(20);
    });

    test('accepts the previous, current and next step; rejects two steps away', async () => {
        // otplib runs in Node's own realm (see the jest.mock above), so Jest's fake
        // timers cannot pin its clock. Use the real clock, away from a step edge
        // so the step cannot roll over between generating and verifying.
        if (Date.now() % 30000 > 27000) await new Promise((r) => setTimeout(r, 3500));
        const now = Math.floor(Date.now() / 1000);
        const secret = await enrol();

        for (const dt of [-30, 0, 30]) {
            expect(await confirm(referenceTotp(secret, now + dt))).toBe(true);
        }
        for (const dt of [-60, 60]) {
            expect(await confirm(referenceTotp(secret, now + dt))).toBe(false);
        }
    });

    test('the reference matches RFC 6238 Appendix B and otplib agrees with it', () => {
        const { verifySync } = require('otplib');
        const seed = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // "12345678901234567890", base32
        expect(referenceTotp(seed, 59)).toBe('287082'); // 94287082, 6 digits
        expect(verifySync({ secret: seed, token: '287082', epoch: 59 }).valid).toBe(true);
    });

    test('malformed codes are rejected without throwing', async () => {
        await enrol();
        for (const bad of ['', '12345', '1234567', 'abcdef', ' 12345', null, undefined]) {
            await expect(confirm(bad)).resolves.toBe(false);
        }
        expect(mockDb.run).toHaveBeenCalledTimes(1); // only the enrolment insert
    });
});
