'use strict';
/**
 * SAML strict mode (setting samlStrict, SuperAdmin, security-class).
 *
 * The assertion signature is always required. Strict mode — ON by default —
 * ALSO requires the whole response envelope to be signed. A SuperAdmin may
 * switch it off on the SSO page for an identity provider that signs the
 * assertion only. Before the setting is stored, SAML_WANT_RESPONSE_SIGNED=0 in
 * the environment still relaxes it (an existing install keeps its choice).
 */
const fs = require('fs');
const path = require('path');

const mockStore = new Map();
jest.mock('../../src/models/AppSettingsModel', () => ({
    getValue: jest.fn(async (k, d = null) => (mockStore.has(k) ? mockStore.get(k) : d)),
    setValue: jest.fn(async (k, v) => {
        mockStore.set(k, v);
    }),
}));
jest.mock('../../src/config/sso', () => ({ getEnabledProviders: () => [] }));

const Svc = require('../../src/services/SsoSettingsService');

const strictField = async () =>
    (await Svc.getFormModel()).providers
        .find((p) => p.key === 'saml')
        .fields.find((f) => f.name === 'strict');

describe('samlStrict', () => {
    const saved = process.env.SAML_WANT_RESPONSE_SIGNED;
    beforeEach(() => {
        mockStore.clear();
        delete process.env.SAML_WANT_RESPONSE_SIGNED;
    });
    afterAll(() => {
        if (saved === undefined) delete process.env.SAML_WANT_RESPONSE_SIGNED;
        else process.env.SAML_WANT_RESPONSE_SIGNED = saved;
    });

    test('the SAML provider carries the switch, stored as samlStrict', () => {
        const f = Svc.PROVIDERS.find((p) => p.key === 'saml').fields.find(
            (x) => x.name === 'strict'
        );
        expect(f).toMatchObject({
            db: 'samlStrict',
            env: 'SAML_WANT_RESPONSE_SIGNED',
            bool: true,
            defaultOn: true,
        });
    });

    test('nothing stored, nothing in the environment → strict (ON)', async () => {
        expect((await strictField()).checked).toBe(true);
        expect((await Svc.getOverrides()).SAML_WANT_RESPONSE_SIGNED).toBeUndefined();
    });

    test('the environment relaxes it only with an explicit 0, until the setting is stored', async () => {
        process.env.SAML_WANT_RESPONSE_SIGNED = '0';
        expect((await strictField()).checked).toBe(false);
        process.env.SAML_WANT_RESPONSE_SIGNED = 'yes';
        expect((await strictField()).checked).toBe(true);
        mockStore.set('samlStrict', true);
        process.env.SAML_WANT_RESPONSE_SIGNED = '0';
        expect((await strictField()).checked).toBe(true);
    });

    test('the stored switch becomes the SAML option: on → 1, off → 0', async () => {
        mockStore.set('samlStrict', true);
        expect((await Svc.getOverrides()).SAML_WANT_RESPONSE_SIGNED).toBe('1');
        mockStore.set('samlStrict', 'false');
        expect((await Svc.getOverrides()).SAML_WANT_RESPONSE_SIGNED).toBe('0');
    });

    test('config/sso requires the signed response unless the option reads 0', () => {
        const src = fs.readFileSync(path.join(__dirname, '../../src/config/sso.js'), 'utf8');
        expect(src).toMatch(/wantAssertionsSigned: true,/);
        expect(src).toMatch(/wantAuthnResponseSigned: env\('SAML_WANT_RESPONSE_SIGNED'\) !== '0',/);
    });

    test('a SuperAdmin-only, security-class setting, seeded ON, written on the SSO page only', () => {
        const S = require('../../src/utils/securitySettings');
        expect(S.isSecurityClassSetting('samlStrict', 'sso')).toBe(true);
        expect(S.canEditSetting({ role: 'localadmin' }, 'samlStrict', 'sso')).toBe(false);
        expect(require('../../src/utils/ssoSettingKeys').isSsoSettingKey('samlStrict', 'sso')).toBe(
            true
        );
        const model = fs.readFileSync(
            path.join(__dirname, '../../src/models/AppSettingsModel.js'),
            'utf8'
        );
        const m = model.match(
            /key: 'samlStrict',\s*value:([\s\S]*?),\s*type: '(\w+)',[\s\S]*?category: '(\w+)'/
        );
        expect(m).not.toBeNull();
        expect(m[1]).toMatch(/=== '0'\s*\?\s*'false'\s*:\s*'true'/);
        expect(m[2]).toBe('boolean');
        expect(m[3]).toBe('sso');
    });
});
