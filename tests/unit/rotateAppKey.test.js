'use strict';

/**
 * scripts/rotate-app-key.js re-encrypts EVERY secret store (v1 and v2) to v2
 * under the new APP_KEY: app settings (SSO and secret settings), LMS
 * auth_config and webhook_secret, webhook subscriptions, the safety gate,
 * HRIS connector credentials, and the MFA secrets (v1 and v2 blobs).
 */
jest.mock('../../src/config/database', () => ({
    all: jest.fn(),
    get: jest.fn(),
    run: jest.fn(),
}));

const crypto = require('crypto');
const secretBox = require('../../src/utils/secretBox');
const { rotateSecretBoxStores, rotateMfa } = require('../../scripts/rotate-app-key');
const MfaCrypto = require('../../src/services/MfaService')._crypto;

const OLD = 'old-app-key-0123456789-abcdefghijklmnop';
const NEW = 'new-app-key-9876543210-zyxwvutsrqponmlk';
const SESSION = 'session-secret-for-tests';

function v1(plain, keyMaterial) {
    const key = crypto.createHash('sha256').update(keyMaterial).digest();
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return (
        'enc:v1:' +
        [iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':')
    );
}
const v2 = (plain, purpose) => secretBox.encryptWithKey(OLD, plain, purpose);
const openNew = (v) => secretBox.decryptWithKeys(v, { appKey: NEW, production: true });

function fakeDb(tables) {
    const writes = [];
    return {
        writes,
        all: jest.fn(async (sql) => {
            if (/FROM appSettings/.test(sql))
                return (tables.appSettings || []).filter((r) =>
                    String(r.settingValue).startsWith('enc:')
                );
            if (/FROM lms_integrations/.test(sql)) return tables.lms || [];
            if (/FROM webhook_subscriptions/.test(sql)) return tables.subs || [];
            if (/FROM safety_gate_settings/.test(sql)) return tables.gate || [];
            if (/FROM hris_connectors/.test(sql)) return tables.hris || [];
            if (/FROM mfa_secrets/.test(sql)) return tables.mfa || [];
            return [];
        }),
        run: jest.fn(async (sql, params) => {
            writes.push({ sql, params });
            return { changes: 1 };
        }),
    };
}

const keys = { oldAppKey: OLD, sessionSecret: SESSION, newAppKey: NEW };
const quiet = { warn: () => {} };

describe('rotate-app-key: secretBox stores', () => {
    test('re-encrypts v1 and v2 values of every store to v2 under the NEW key', async () => {
        const db = fakeDb({
            appSettings: [
                { id: 1, settingKey: 'smtpPassword', settingValue: v2('smtp-pw', 'app_settings') },
                { id: 2, settingKey: 'sso.entra.clientSecret', settingValue: v1('entra-cs', OLD) },
                { id: 3, settingKey: 'appName', settingValue: 'clear value' },
            ],
            lms: [
                {
                    id: 7,
                    authConfig: { _enc: v1(JSON.stringify({ token: 't' }), OLD) },
                    webhookSecret: v2('lms-hook', 'lms'),
                },
            ],
            subs: [
                { id: 9, secret: v1('sub-secret', OLD) },
                { id: 10, secret: null },
            ],
            gate: [{ id: 1, webhookSecret: v2('gate-secret', 'safety_gate') }],
            hris: [
                { id: 4, credentials: v1(JSON.stringify({ apiKey: 'h' }), OLD) },
                { id: 5, credentials: v2(JSON.stringify({ apiKey: 'k' }), 'hris') },
                { id: 6, credentials: null },
            ],
        });

        const stats = await rotateSecretBoxStores(db, keys, quiet);

        const w = (re, id) =>
            db.writes.find((x) => re.test(x.sql) && x.params[x.params.length - 1] === id);
        const smtp = w(/UPDATE appSettings/, 1).params[0];
        expect(smtp.startsWith('enc:v2:app_settings:')).toBe(true);
        expect(openNew(smtp)).toBe('smtp-pw');
        const sso = w(/UPDATE appSettings/, 2).params[0];
        expect(sso.startsWith('enc:v2:sso:')).toBe(true);
        expect(openNew(sso)).toBe('entra-cs');
        expect(w(/UPDATE appSettings/, 3)).toBeUndefined();

        const ac = JSON.parse(w(/SET auth_config/, 7).params[0]);
        expect(JSON.parse(openNew(ac._enc))).toEqual({ token: 't' });
        expect(openNew(w(/SET webhook_secret/, 7).params[0])).toBe('lms-hook');
        expect(openNew(w(/webhook_subscriptions/, 9).params[0])).toBe('sub-secret');
        expect(w(/webhook_subscriptions/, 10)).toBeUndefined();
        expect(openNew(w(/safety_gate_settings/, 1).params[0])).toBe('gate-secret');

        const h4 = w(/hris_connectors/, 4).params[0];
        expect(h4.startsWith('enc:v2:hris:')).toBe(true);
        expect(JSON.parse(openNew(h4))).toEqual({ apiKey: 'h' });
        expect(JSON.parse(openNew(w(/hris_connectors/, 5).params[0]))).toEqual({ apiKey: 'k' });
        expect(w(/hris_connectors/, 6)).toBeUndefined();

        // The OLD key no longer opens anything written.
        expect(() => secretBox.decryptWithKeys(smtp, { appKey: OLD, production: true })).toThrow();
        expect(stats.appSettings.done).toBe(2);
        expect(stats.webhookSubscriptions.done).toBe(1);
        expect(stats.safetyGate.done).toBe(1);
        expect(stats.hrisConnectors.done).toBe(2);
    });

    test('a value encrypted under an unknown key is skipped, never overwritten', async () => {
        const db = fakeDb({
            appSettings: [
                {
                    id: 5,
                    settingKey: 'copilotApiSecret',
                    settingValue: secretBox.encryptWithKey(
                        'some-other-key-xxxxxxxxxxxxxxxxxxxx',
                        'x',
                        'app_settings'
                    ),
                },
            ],
        });
        const stats = await rotateSecretBoxStores(db, keys, quiet);
        expect(db.writes).toHaveLength(0);
        expect(stats.appSettings).toEqual({ done: 0, skipped: 1 });
    });

    test('a v2 value written with the SESSION_SECRET fallback (dev, no APP_KEY) still rotates', async () => {
        const val = secretBox.encryptWithKey(SESSION, 'dev-secret', 'app_settings');
        const db = fakeDb({
            appSettings: [{ id: 4, settingKey: 'smtpPassword', settingValue: val }],
        });
        await rotateSecretBoxStores(db, { ...keys, oldAppKey: '' }, quiet);
        expect(openNew(db.writes[0].params[0])).toBe('dev-secret');
    });
});

describe('rotate-app-key: MFA secrets', () => {
    function legacyMfa(plain, key) {
        const iv = crypto.randomBytes(12);
        const c = crypto.createCipheriv('aes-256-gcm', key, iv);
        const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
        return Buffer.concat([iv, c.getAuthTag(), ct]);
    }
    test('v1 and v2 blobs are both rewritten as v2 under the NEW key', async () => {
        const v1blob = legacyMfa('SECRETV1', Buffer.from(OLD.slice(0, 32)));
        const v2blob = MfaCrypto.encryptWithKey(MfaCrypto.v2KeyFrom(OLD), 'SECRETV2');
        const db = fakeDb({
            mfa: [
                { id: 1, secretEnc: v1blob },
                { id: 2, secretEnc: v2blob },
            ],
        });
        const stats = await rotateMfa(db, keys, quiet);
        expect(stats).toEqual({ done: 2, skipped: 0 });
        const toKey = MfaCrypto.v2KeyFrom(NEW);
        for (const [id, plain] of [
            [1, 'SECRETV1'],
            [2, 'SECRETV2'],
        ]) {
            const out = db.writes.find((x) => x.params[1] === id).params[0];
            expect(out.subarray(0, 4).toString('ascii')).toBe('MFA2');
            expect(MfaCrypto.decryptWithKeys(out, { v2Key: toKey, legacyKeys: [] }).secret).toBe(
                plain
            );
        }
    });

    test('an MFA blob under an unknown key is skipped, never overwritten', async () => {
        const foreign = MfaCrypto.encryptWithKey(
            MfaCrypto.v2KeyFrom('unrelated-key-0123456789abcdef0123'),
            'X'
        );
        const db = fakeDb({ mfa: [{ id: 3, secretEnc: foreign }] });
        const stats = await rotateMfa(db, keys, quiet);
        expect(stats).toEqual({ done: 0, skipped: 1 });
        expect(db.writes).toHaveLength(0);
    });
});
