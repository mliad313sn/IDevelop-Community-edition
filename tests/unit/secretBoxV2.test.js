'use strict';
/**
 * secretBox key versioning (audit SA-18).
 *
 *  - v2 = HKDF-SHA256(APP_KEY, per-purpose info), purpose authenticated (AAD),
 *    with a product-neutral, frozen salt;
 *  - v1 values written by the previous code still open (the ciphertexts below
 *    were produced by the v1 secretBox, one under APP_KEY, one under the
 *    SESSION_SECRET fallback);
 *  - production never derives from SESSION_SECRET and refuses to boot without
 *    a strong APP_KEY; development is unchanged (keyless = clear passthrough);
 *  - every existing consumer (LMS, SSO, HRIS) still opens a v1 value.
 */
const fs = require('fs');
const path = require('path');

const APP_KEY_V1 = 'test-app-key-0123456789abcdef0123456789';
// Produced by the v1 secretBox with APP_KEY=APP_KEY_V1:
const V1_UNDER_APP_KEY =
    'enc:v1:UWhHqtYP0MnOz6BJ:mDsfexLYEAfGGgpt6CUUNA==:fua0r2sZ+WOlC+5yIbS0jA==';
const V1_PLAIN_1 = 'smtp-pa$$word:v1';
// Produced by the v1 secretBox with APP_KEY unset, SESSION_SECRET below:
const SESSION_SECRET_V1 = 'legacy-session-secret-for-v1-test';
const V1_UNDER_SESSION =
    'enc:v1:e6oBos/PMiCYRz9A:eb9tSTlVtGTS6e+OYmgO+g==:oBUb0egDzEmW1ld15urTvg8=';
const V1_PLAIN_2 = 'sso-client-secret';

const saved = {};
function setEnv(env) {
    for (const k of ['APP_KEY', 'SESSION_SECRET', 'NODE_ENV']) {
        if (!(k in saved)) saved[k] = process.env[k];
        if (env[k] === undefined) delete process.env[k];
        else process.env[k] = env[k];
    }
}
afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});
const box = () => require('../../src/utils/secretBox');

describe('secretBox v1 -> v2', () => {
    test('the v2 salt is product-neutral and frozen', () => {
        expect(box().V2_SALT).toBe('idevelop.secretbox.v2');
    });

    test('a REAL v1 ciphertext (APP_KEY) still decrypts', () => {
        setEnv({ APP_KEY: APP_KEY_V1, SESSION_SECRET: 'other', NODE_ENV: 'production' });
        expect(box().decrypt(V1_UNDER_APP_KEY)).toBe(V1_PLAIN_1);
    });

    test('a REAL v1 ciphertext written under the SESSION_SECRET fallback still decrypts after APP_KEY was added', () => {
        setEnv({
            APP_KEY: 'a-new-app-key-added-later-0123456789abcd',
            SESSION_SECRET: SESSION_SECRET_V1,
            NODE_ENV: 'production',
        });
        expect(box().decrypt(V1_UNDER_SESSION)).toBe(V1_PLAIN_2);
    });

    test('new values are v2, carry their purpose and round-trip', () => {
        setEnv({ APP_KEY: APP_KEY_V1, SESSION_SECRET: 'x', NODE_ENV: 'production' });
        const c = box().encrypt('hello', 'app_settings');
        expect(c).toMatch(/^enc:v2:app_settings:/);
        expect(box().decrypt(c)).toBe('hello');
        expect(box().needsUpgrade(c)).toBe(false);
        expect(box().needsUpgrade(V1_UNDER_APP_KEY)).toBe(true);
        expect(box().needsUpgrade('clear')).toBe(true);
    });

    test('the purpose is authenticated: relabelling a ciphertext breaks it', () => {
        setEnv({ APP_KEY: APP_KEY_V1, NODE_ENV: 'production' });
        const c = box().encrypt('hello', 'webhook');
        const relabelled = c.replace('enc:v2:webhook:', 'enc:v2:generic:');
        expect(() => box().decrypt(relabelled)).toThrow();
        expect(() => box().decrypt(c, { purpose: 'app_settings' })).toThrow(/purpose/);
    });

    test('v2 keys are per purpose (same plaintext, different keys)', () => {
        setEnv({ APP_KEY: APP_KEY_V1, NODE_ENV: 'production' });
        const a = box().encryptWithKey(APP_KEY_V1, 'x', 'p1');
        const forged = 'enc:v2:p2:' + a.slice('enc:v2:p1:'.length);
        expect(() => box().decrypt(forged)).toThrow();
    });

    test('production NEVER derives from SESSION_SECRET: rotating it keeps v2 secrets readable', () => {
        setEnv({ APP_KEY: APP_KEY_V1, SESSION_SECRET: 's1', NODE_ENV: 'production' });
        const c = box().encrypt('keep-me');
        setEnv({ APP_KEY: APP_KEY_V1, SESSION_SECRET: 's2-rotated', NODE_ENV: 'production' });
        expect(box().decrypt(c)).toBe('keep-me');
    });

    test('production without APP_KEY fails loudly, at boot and at first use, instead of storing clear text', () => {
        setEnv({ APP_KEY: undefined, SESSION_SECRET: 'only-session', NODE_ENV: 'production' });
        expect(() => box().assertConfigured()).toThrow(/APP_KEY is required/);
        expect(() => box().encrypt('x')).toThrow(/APP_KEY is required/);
        expect(box().isEnabled()).toBe(false);
        // Legacy v1 values stay readable (read-only fallback), nothing is lost.
        setEnv({ APP_KEY: undefined, SESSION_SECRET: SESSION_SECRET_V1, NODE_ENV: 'production' });
        expect(box().decrypt(V1_UNDER_SESSION)).toBe(V1_PLAIN_2);
    });

    test.each([
        'short-key',
        'CHANGE_THIS_TO_A_LONG_RANDOM_KEY',
        'please-set-a-placeholder-key-here-000',
    ])('production refuses a weak APP_KEY (%s)', (k) => {
        setEnv({ APP_KEY: k, NODE_ENV: 'production' });
        expect(() => box().assertConfigured()).toThrow(/too weak/);
    });

    test('a random 32-byte key passes in production', () => {
        setEnv({
            APP_KEY: require('crypto').randomBytes(32).toString('hex'),
            NODE_ENV: 'production',
        });
        expect(box().assertConfigured()).toBe(true);
        setEnv({
            APP_KEY: require('crypto').randomBytes(32).toString('base64'),
            NODE_ENV: 'production',
        });
        expect(box().assertConfigured()).toBe(true);
    });

    test('development unchanged: SESSION_SECRET-only encrypts; no key at all passes clear text through', () => {
        setEnv({ APP_KEY: undefined, SESSION_SECRET: 'dev-secret', NODE_ENV: 'development' });
        const c = box().encrypt('dev');
        expect(c).toMatch(/^enc:v2:/);
        expect(box().decrypt(c)).toBe('dev');
        expect(() => box().assertConfigured()).not.toThrow();
        setEnv({ APP_KEY: undefined, SESSION_SECRET: undefined, NODE_ENV: 'development' });
        expect(box().encrypt('clear')).toBe('clear');
        expect(box().decrypt('clear')).toBe('clear');
    });

    test('rotateValue re-seals v1 and v2 values under a new APP_KEY', () => {
        setEnv({ APP_KEY: APP_KEY_V1, NODE_ENV: 'production' });
        const NEW = 'fresh-app-key-0123456789abcdef0123456789';
        const r1 = box().rotateValue(V1_UNDER_APP_KEY, {
            from: { appKey: APP_KEY_V1 },
            toAppKey: NEW,
        });
        const v2 = box().encrypt('two', 'app_settings');
        const r2 = box().rotateValue(v2, { from: { appKey: APP_KEY_V1 }, toAppKey: NEW });
        expect(r2).toMatch(/^enc:v2:app_settings:/);
        setEnv({ APP_KEY: NEW, NODE_ENV: 'production' });
        expect(box().decrypt(r1)).toBe(V1_PLAIN_1);
        expect(box().decrypt(r2)).toBe('two');
    });

    test('server.js refuses the boot through assertConfigured before touching the database', () => {
        const src = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');
        const a = src.indexOf("require('./src/utils/secretBox').assertConfigured()");
        expect(a).toBeGreaterThan(-1);
        expect(a).toBeLessThan(src.indexOf('await db.connect()'));
    });
});

describe('existing secretBox consumers still open a v1 value', () => {
    const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn() };
    beforeAll(() => {
        jest.resetModules();
        jest.doMock('../../src/config/database', () => mockDb);
        setEnv({ APP_KEY: APP_KEY_V1, NODE_ENV: 'production' });
    });
    afterAll(() => jest.dontMock('../../src/config/database'));

    test('LMS webhook secret stored as v1 verifies', async () => {
        const LmsService = require('../../src/services/LmsService');
        mockDb.get.mockResolvedValue({ enabled: true, webhookSecret: V1_UNDER_APP_KEY });
        await expect(LmsService.verifyWebhookSecret('moodle', V1_PLAIN_1)).resolves.toBe(true);
        await expect(LmsService.verifyWebhookSecret('moodle', 'wrong')).resolves.toBe(false);
    });

    test('an SSO client secret stored as v1 still reaches the SSO configuration in clear', async () => {
        mockDb.get.mockImplementation(async (sql, params) =>
            params && params[0] === 'sso.entra.clientSecret'
                ? {
                      settingKey: 'sso.entra.clientSecret',
                      settingValue: V1_UNDER_APP_KEY,
                      settingType: 'string',
                      category: 'sso',
                  }
                : undefined
        );
        const Sso = require('../../src/services/SsoSettingsService');
        const ov = await Sso.getOverrides();
        expect(ov.AZURE_CLIENT_SECRET).toBe(V1_PLAIN_1);
    });
});
