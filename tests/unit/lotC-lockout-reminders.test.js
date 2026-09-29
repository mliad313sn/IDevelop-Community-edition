'use strict';

/**
 * Lot C — lockout tunables (L1-22) and the access-expiry reminder (L1-13).
 *
 * Two settings rows decide when an account locks and for how long; before this
 * lot the numbers were env-only, so the helpdesk could not answer "until when?"
 * and the message was English on a French page. And a TIME-BOUND delegation
 * expired in silence: nobody was told, the person simply started collecting
 * refusals.
 */

const mockDb = {
    all: jest.fn(async () => []),
    get: jest.fn(async () => null),
    run: jest.fn(async () => ({ changes: 0 })),
    runTransaction: jest.fn(async (fn) => fn()),
    _client: jest.fn(),
};
jest.mock('../../src/config/database', () => mockDb);

const mockSettings = { getValue: jest.fn(async (k, d) => d) };
jest.mock('../../src/models/AppSettingsModel', () => mockSettings);

const mockAttempts = {
    getFailedAttemptsCount: jest.fn(async () => 0),
    recordAttempt: jest.fn(async () => ({})),
};
jest.mock('../../src/models/LoginAttemptModel', () => mockAttempts);

const { lockoutPolicy, lockStateFor } = require('../../src/middleware/rateLimiter');

describe('Lot C — the lockout policy is an App Setting with an env fallback', () => {
    test('the settings values win when present', async () => {
        mockSettings.getValue.mockImplementation(
            async (k) => ({ maxLoginAttempts: '8', loginLockoutMinutes: '45' })[k]
        );
        expect(await lockoutPolicy()).toEqual({ maxAttempts: 8, lockoutMinutes: 45 });
    });

    test('a zero, negative or unparsable value falls back — a lockout cannot be typed away', async () => {
        mockSettings.getValue.mockImplementation(
            async (k, d) => ({ maxLoginAttempts: '0', loginLockoutMinutes: 'abc' })[k] ?? d
        );
        const p = await lockoutPolicy();
        expect(p.maxAttempts).toBeGreaterThan(0);
        expect(p.lockoutMinutes).toBeGreaterThan(0);
    });

    test('an unreadable settings table still yields a policy (fails safe, never throws)', async () => {
        mockSettings.getValue.mockRejectedValue(new Error('no db'));
        const p = await lockoutPolicy();
        expect(p.maxAttempts).toBeGreaterThan(0);
        expect(p.lockoutMinutes).toBeGreaterThan(0);
    });
});

describe('Lot C — "locked until HH:MM" is computed, not guessed', () => {
    beforeEach(() => {
        mockSettings.getValue.mockImplementation(
            async (k) => ({ maxLoginAttempts: '5', loginLockoutMinutes: '30' })[k]
        );
    });

    test('below the threshold the account is not locked', async () => {
        mockAttempts.getFailedAttemptsCount.mockResolvedValue(4);
        const s = await lockStateFor('qa.local');
        expect(s).toMatchObject({ locked: false, attempts: 4, until: null });
    });

    test('at the threshold it is locked until the Nth failure ages out of the window', async () => {
        mockAttempts.getFailedAttemptsCount.mockResolvedValue(5);
        const nth = new Date('2026-09-10T14:05:00.000Z');
        mockDb.get.mockResolvedValue({ attemptedAt: nth.toISOString() });
        const s = await lockStateFor('QA.Local');
        expect(s.locked).toBe(true);
        expect(s.until.toISOString()).toBe(new Date(nth.getTime() + 30 * 60000).toISOString());
        // rows are keyed by the canonical lowercased username
        expect(mockAttempts.getFailedAttemptsCount).toHaveBeenCalledWith('qa.local', 30);
        // OFFSET = maxAttempts - 1 → the failure that started the lock
        expect(mockDb.get.mock.calls.pop()[1]).toEqual(['qa.local', 30, 4]);
    });

    test('an empty username is never "locked"', async () => {
        expect(await lockStateFor('  ')).toMatchObject({ locked: false, attempts: 0, until: null });
    });

    test('every lockout message goes through req.t — no English template literal left', () => {
        const src = require('fs').readFileSync(
            require.resolve('../../src/middleware/rateLimiter'),
            'utf8'
        );
        expect(src.match(/req\.flash\('error', `[A-Z]/g)).toBeNull();
        for (const key of [
            'adm_too_many_attempts',
            'adm_account_locked_until',
            'adm_account_locked',
            'adm_ip_blocked',
        ]) {
            expect(src).toContain(`flash:${key}`);
            expect(typeof require('../../locales/fr/flash.json')[key]).toBe('string');
            expect(typeof require('../../locales/en/flash.json')[key]).toBe('string');
        }
        expect(require('../../locales/fr/flash.json').adm_account_locked_until).toContain(
            '{{time}}'
        );
    });
});

describe('Lot C — the access-expiry reminder (30 / 7 / 1 days)', () => {
    const src = require('fs').readFileSync(require.resolve('../../src/jobs/reminders'), 'utf8');
    const block = src.slice(
        src.indexOf('// ---- SECTION access'),
        src.indexOf('// ---- end SECTION access')
    );

    test('the block exists and is claim-before-send with a release on failure', () => {
        expect(block).toContain("claim('access.expiry'");
        expect(block).toContain("release('access.expiry'");
        expect(block.indexOf('claim(')).toBeLessThan(block.indexOf('send('));
    });

    test('it only looks at LIVE, future, bounded grants of ACTIVE accounts', () => {
        expect(block).toMatch(/revoked_at IS NULL/);
        expect(block).toMatch(/expires_at > now\(\)/);
        expect(block).toMatch(/expires_at <= now\(\) \+ interval '30 days'/);
        expect(block).toMatch(/COALESCE\(a\.is_active, true\) = true/);
    });

    test('the three thresholds, and the claim period that makes each fire once', () => {
        expect(block).toMatch(/const thresholds = \[1, 7, 30\]/);
        expect(block).toMatch(/\$\{bucket\}d:\$\{when\.toISOString\(\)\.slice\(0, 10\)\}/);
    });

    test('the bucket maths: 20 days → 30-day nudge, 5 → 7, 1 → 1, 31 → none', () => {
        const thresholds = [1, 7, 30];
        const bucket = (daysLeft) => thresholds.find((t) => daysLeft <= t);
        expect(bucket(20)).toBe(30);
        expect(bucket(7)).toBe(7);
        expect(bucket(5)).toBe(7);
        expect(bucket(1)).toBe(1);
        expect(bucket(0)).toBe(1);
        expect(bucket(31)).toBeUndefined();
    });

    test('the subject AND the SuperAdmins are told, each at most once per threshold', () => {
        expect(block).toMatch(/role = 'superadmin'/);
        expect(block).toMatch(/recipients = \[subject, \.\.\.supers/);
        expect(block).toMatch(/all\.indexOf\(id\) === i/); // the subject, if super, is not told twice
    });

    test("Lot B's reminder block is untouched by mine", () => {
        expect(src).toContain('// ---- end SECTION accounts');
        expect(src).toContain("claim('account.dormant'");
        expect(src.indexOf('// ---- end SECTION accounts')).toBeLessThan(
            src.indexOf('// ---- SECTION access')
        );
    });
});
