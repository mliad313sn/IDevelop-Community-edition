'use strict';
/**
 * Secret app settings (SMTP password, AI provider key…) are encrypted at rest
 * inside AppSettingsModel, transparent to callers (EmailService,
 * CopilotService), masked in listings; legacy clear values are re-encrypted
 * lazily; a mask never overwrites a secret; SSO secrets are left to
 * SsoSettingsService. The JSON export never carries a secret and the JSON
 * import never writes one.
 */
const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);

const APP_KEY = 'settings-test-app-key-0123456789abcdef0123';
const prev = { APP_KEY: process.env.APP_KEY };
process.env.APP_KEY = APP_KEY;

const secretBox = require('../../src/utils/secretBox');
const AppSettingsModel = require('../../src/models/AppSettingsModel');

afterAll(() => {
    if (prev.APP_KEY === undefined) delete process.env.APP_KEY;
    else process.env.APP_KEY = prev.APP_KEY;
});

/** A tiny in-memory app_settings table behind the mocked db. */
let table;
function wireTable(rows) {
    table = new Map(
        rows.map((r, i) => [
            r.settingKey,
            { id: i + 1, settingType: 'string', category: 'email', ...r },
        ])
    );
    mockDb.get.mockImplementation(async (sql, params) => {
        if (/WHERE settingKey = \?/.test(sql)) return table.get(params[0]);
        if (/WHERE id = \?/.test(sql)) return [...table.values()].find((r) => r.id === params[0]);
        return undefined;
    });
    mockDb.all.mockImplementation(async () => [...table.values()]);
    mockDb.run.mockImplementation(async (sql, params) => {
        if (
            /^UPDATE appSettings SET settingValue = \?, settingType/.test(sql) &&
            /WHERE settingKey/.test(sql)
        ) {
            const [v, t, , , , k] = params;
            Object.assign(table.get(k), { settingValue: v, settingType: t });
        } else if (
            /^UPDATE appSettings SET settingValue = \? WHERE settingKey = \? AND settingValue = \?/.test(
                sql
            )
        ) {
            const [v, k, old] = params;
            if (table.get(k) && table.get(k).settingValue === old) table.get(k).settingValue = v;
        } else if (/WHERE id = \?/.test(sql)) {
            const row = [...table.values()].find((r) => r.id === params[5]);
            row.settingValue = params[0];
        } else if (/^INSERT INTO appSettings/.test(sql)) {
            const [k, v, t] = params;
            table.set(k, { id: table.size + 1, settingKey: k, settingValue: v, settingType: t });
        }
        return { changes: 1 };
    });
}
beforeEach(async () => {
    jest.clearAllMocks();
    // The model caches rows for 60 s and every write busts that cache: one
    // throw-away write gives each test a cold cache.
    wireTable([]);
    await AppSettingsModel.setValue('zzCacheBust', '1');
});

describe('secrets encrypted at rest, transparent to callers', () => {
    test('isSecretKey: one definition, by the last dot-segment', () => {
        for (const k of ['smtpPassword', 'copilotApiSecret', 'x.apiKey', 'sso.entra.clientSecret'])
            expect([k, AppSettingsModel.isSecretKey(k)]).toEqual([k, true]);
        for (const k of ['smtpHost', 'passwordMinLength', 'tokenTtlDays', ''])
            expect([k, AppSettingsModel.isSecretKey(k)]).toEqual([k, false]);
        // A switch is never a credential, whatever its name ends with.
        expect(AppSettingsModel.isSecretKey('ssoDisablesLocalPassword')).toBe(false);
        expect(AppSettingsModel.isSecretKey('requireStrongPassword', 'boolean')).toBe(false);
    });

    test('setValue seals smtpPassword (v2) and getValue returns the plaintext', async () => {
        wireTable([{ settingKey: 'smtpPassword', settingValue: '' }]);
        await AppSettingsModel.setValue('smtpPassword', 'P@ss-w0rd', 'string', 'd', 'email');
        const stored = table.get('smtpPassword').settingValue;
        expect(stored).toMatch(/^enc:v2:app_settings:/);
        expect(stored).not.toContain('P@ss-w0rd');
        expect(await AppSettingsModel.getValue('smtpPassword', '')).toBe('P@ss-w0rd');
    });

    test('copilotApiSecret written through update() (the settings form path) is sealed too', async () => {
        wireTable([{ settingKey: 'copilotApiSecret', settingValue: '', category: 'copilot' }]);
        await AppSettingsModel.update({
            id: 1,
            settingValue: 'sk-live-123',
            settingType: 'string',
            category: 'copilot',
        });
        expect(table.get('copilotApiSecret').settingValue).toMatch(/^enc:v2:/);
        expect(await AppSettingsModel.getValue('copilotApiSecret', '')).toBe('sk-live-123');
    });

    test('a legacy CLEAR value still reads and is re-encrypted lazily on read', async () => {
        wireTable([{ settingKey: 'smtpPassword', settingValue: 'legacy-clear' }]);
        expect(await AppSettingsModel.getValue('smtpPassword', '')).toBe('legacy-clear');
        expect(table.get('smtpPassword').settingValue).toMatch(/^enc:v2:app_settings:/);
        expect(await AppSettingsModel.getValue('smtpPassword', '')).toBe('legacy-clear');
    });

    test('a v1 value is upgraded to v2 on read, plaintext unchanged', async () => {
        const crypto = require('crypto');
        const k = crypto.createHash('sha256').update(APP_KEY).digest();
        const iv = crypto.randomBytes(12);
        const c = crypto.createCipheriv('aes-256-gcm', k, iv);
        const ct = Buffer.concat([c.update('old-v1', 'utf8'), c.final()]);
        const legacy = `enc:v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
        wireTable([{ settingKey: 'copilotApiSecret', settingValue: legacy }]);
        expect(await AppSettingsModel.getValue('copilotApiSecret', '')).toBe('old-v1');
        expect(table.get('copilotApiSecret').settingValue).toMatch(/^enc:v2:/);
    });

    test('an undecryptable value reads as unset, never thrown at the caller', async () => {
        const foreign = secretBox.encryptWithKey('another-key-0123456789abcdef0123456', 'x');
        wireTable([{ settingKey: 'smtpPassword', settingValue: foreign }]);
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        expect(await AppSettingsModel.getValue('smtpPassword', 'fallback')).toBe('fallback');
        warn.mockRestore();
    });

    test('listings never carry the secret, only a mask, and echoing the mask back changes nothing', async () => {
        wireTable([
            { settingKey: 'smtpPassword', settingValue: 'x' },
            { settingKey: 'smtpHost', settingValue: 'mail.example.org' },
        ]);
        await AppSettingsModel.setValue('smtpPassword', 'real-secret', 'string', 'd', 'email');
        const sealed = table.get('smtpPassword').settingValue;
        const rows = await AppSettingsModel.findAll();
        const pw = rows.find((r) => r.settingKey === 'smtpPassword');
        expect(pw.settingValue).toBe(AppSettingsModel.SECRET_MASK);
        expect(pw.secretSet).toBe(true);
        expect(JSON.stringify(rows)).not.toContain('real-secret');
        expect(JSON.stringify(rows)).not.toContain(sealed);
        expect(rows.find((r) => r.settingKey === 'smtpHost').settingValue).toBe('mail.example.org');

        await AppSettingsModel.setValue(
            'smtpPassword',
            AppSettingsModel.SECRET_MASK,
            'string',
            'd',
            'email'
        );
        await AppSettingsModel.update({
            id: 1,
            settingValue: AppSettingsModel.SECRET_MASK,
            settingType: 'string',
        });
        expect(table.get('smtpPassword').settingValue).toBe(sealed);
    });

    test('SSO secrets are left to SsoSettingsService: never double-encrypted, returned as stored', async () => {
        const already = secretBox.encrypt('client-secret', 'sso');
        wireTable([{ settingKey: 'sso.entra.clientSecret', settingValue: '', category: 'sso' }]);
        await AppSettingsModel.setValue('sso.entra.clientSecret', already, 'string', 'd', 'sso');
        expect(table.get('sso.entra.clientSecret').settingValue).toBe(already);
        expect(await AppSettingsModel.getValue('sso.entra.clientSecret', null)).toBe(already);
    });

    test('EmailService reads the SMTP password in clear from the sealed row', async () => {
        wireTable([
            { settingKey: 'smtpHost', settingValue: 'smtp.example.org' },
            { settingKey: 'smtpPassword', settingValue: '' },
        ]);
        await AppSettingsModel.setValue('smtpPassword', 'mail-secret', 'string', 'd', 'email');
        const EmailService = require('../../src/services/EmailService');
        const cfg = await EmailService.getConfig();
        expect(cfg.pass).toBe('mail-secret');
    });
});

describe('JSON export / import', () => {
    const src = require('fs').readFileSync(
        require('path').join(__dirname, '../../src/services/UnifiedJsonService.js'),
        'utf8'
    );
    test('the export and the import use the model definition of a secret', () => {
        expect(src).toMatch(
            /const isSecret = \(k\) => require\('\.\.\/utils\/secretSettingKeys'\)\.isSecretKey/
        );
        expect(src).toMatch(/if \(isSecretKey\(s\.key, s\.type\)\) continue;/);
    });
});
