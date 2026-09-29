'use strict';
/** Unit tests for the SSO settings bridge (DB<->env merge, secret masking, save). */
const mockStore = new Map();
jest.mock('../../src/models/AppSettingsModel', () => ({
    getValue: jest.fn(async (k, d = null) => (mockStore.has(k) ? mockStore.get(k) : d)),
    setValue: jest.fn(async (k, v) => {
        mockStore.set(k, v);
    }),
}));
// config/sso is required lazily inside getFormModel; stub its provider list.
jest.mock('../../src/config/sso', () => ({ getEnabledProviders: () => [{ key: 'entra' }] }));

const Svc = require('../../src/services/SsoSettingsService');
const AppSettings = require('../../src/models/AppSettingsModel');

describe('SsoSettingsService', () => {
    const savedEnv = {};
    const envKeys = ['SSO_ENABLED', 'AZURE_TENANT_ID', 'OIDC_ISSUER', 'AZURE_CLIENT_SECRET'];
    beforeEach(() => {
        mockStore.clear();
        AppSettings.setValue.mockClear();
        envKeys.forEach((k) => {
            savedEnv[k] = process.env[k];
            delete process.env[k];
        });
    });
    afterEach(() => {
        envKeys.forEach((k) => {
            if (savedEnv[k] === undefined) delete process.env[k];
            else process.env[k] = savedEnv[k];
        });
    });

    test('getOverrides maps DB keys to env-var names and reflects the master toggle', async () => {
        mockStore.set('sso.enabled', true);
        mockStore.set('sso.entra.tenantId', 'tenant-123');
        mockStore.set('sso.entra.clientSecret', 'shh');
        const ov = await Svc.getOverrides();
        expect(ov.SSO_ENABLED).toBe('1');
        expect(ov.AZURE_TENANT_ID).toBe('tenant-123');
        expect(ov.AZURE_CLIENT_SECRET).toBe('shh');
        expect(ov.OIDC_ISSUER).toBeUndefined(); // not set -> falls back to env in config/sso
    });

    test('save: blank secret is left unchanged; non-secret mockStored; enabled coerced', async () => {
        mockStore.set('sso.entra.clientSecret', 'existing-secret');
        await Svc.save(
            { enabled: '1', confirmEnforce: '1', 'entra.tenantId': 'T1', 'entra.clientSecret': '' },
            7
        );
        // secret untouched
        expect(mockStore.get('sso.entra.clientSecret')).toBe('existing-secret');
        // non-secret written
        expect(mockStore.get('sso.entra.tenantId')).toBe('T1');
        // master toggle mockStored as boolean true
        expect(mockStore.get('sso.enabled')).toBe(true);
    });

    test('save: a provided secret overwrites the mockStored one', async () => {
        mockStore.set('sso.google.clientSecret', 'old');
        await Svc.save(
            { enabled: '1', confirmEnforce: '1', 'google.clientSecret': 'new-secret' },
            7
        );
        expect(mockStore.get('sso.google.clientSecret')).toBe('new-secret');
    });

    test('getFormModel masks secrets and flags env-sourced values', async () => {
        process.env.AZURE_TENANT_ID = 'from-env'; // not in DB -> fromEnv
        mockStore.set('sso.entra.clientSecret', 'mockStored');
        const m = await Svc.getFormModel();
        const entra = m.providers.find((p) => p.key === 'entra');
        const tenant = entra.fields.find((f) => f.name === 'tenantId');
        const secret = entra.fields.find((f) => f.name === 'clientSecret');
        expect(tenant.value).toBe('from-env');
        expect(tenant.fromEnv).toBe(true);
        expect(secret.secret).toBe(true);
        expect(secret.isSet).toBe(true);
        expect(secret).not.toHaveProperty('value'); // never echo a secret back
        expect(entra.active).toBe(true); // from the stubbed getEnabledProviders
    });
});
