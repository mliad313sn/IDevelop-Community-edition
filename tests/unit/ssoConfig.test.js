'use strict';
/**
 * Unit tests for the multi-provider SSO registry (config/sso.js).
 * Strategy packages and the DB/models are mocked so the test exercises the
 * gating/registration logic without constructing real OIDC/SAML/Google clients
 * or touching a database.
 */
jest.mock('../../src/config/database', () => ({ get: jest.fn(), run: jest.fn() }));
jest.mock('../../src/models/AdminModel', () => ({}));
jest.mock('../../src/models/EmployeeModel', () => ({}));
// Entra (openid-client / jose) strategies are built in config/sso.js itself and
// load their libraries lazily — registration needs no mock. The full protocol
// is driven against a mock IdP in c317-S-entra-lib-oidc.test.js.
jest.mock('passport-openidconnect', () => ({
    Strategy: function (opts, verify) {
        this.opts = opts;
        this.verify = verify;
    },
}));
jest.mock('@node-saml/passport-saml', () => ({
    Strategy: function (opts, verify, logout) {
        this.opts = opts;
        this.verify = verify;
        this.logout = logout;
    },
}));
jest.mock('passport-google-oauth20', () => ({
    Strategy: function (opts, verify) {
        this.opts = opts;
        this.verify = verify;
    },
}));

const sso = require('../../src/config/sso');

function fakePassport() {
    return { use: jest.fn() };
}

const ENV_KEYS = [
    'SSO_ENABLED',
    'AZURE_TENANT_ID',
    'AZURE_CLIENT_ID',
    'AZURE_CLIENT_SECRET',
    'SSO_ENTRA_REDIRECT_URL',
    'SSO_REDIRECT_URL',
    'SSO_ENTRA_LABEL',
    'SSO_BUTTON_LABEL',
    'AZURE_API_CLIENT_ID',
    'AZURE_API_AUDIENCE',
    'AZURE_API_ISSUER',
    'SSO_LOG_LEVEL',
    'OIDC_ISSUER',
    'OIDC_AUTH_URL',
    'OIDC_TOKEN_URL',
    'OIDC_USERINFO_URL',
    'OIDC_CLIENT_ID',
    'OIDC_CLIENT_SECRET',
    'OIDC_REDIRECT_URL',
    'SAML_ENTRY_POINT',
    'SAML_ISSUER',
    'SAML_CALLBACK_URL',
    'SAML_IDP_CERT',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GOOGLE_REDIRECT_URL',
    'GOOGLE_HD',
];

describe('configureSso (multi-provider registry)', () => {
    const saved = {};
    beforeEach(() => {
        ENV_KEYS.forEach((k) => {
            saved[k] = process.env[k];
            delete process.env[k];
        });
    });
    afterEach(() => {
        ENV_KEYS.forEach((k) => {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        });
    });

    test('no-ops when SSO is disabled', () => {
        const p = fakePassport();
        expect(sso.configureSso(p)).toEqual([]);
        expect(sso.isConfigured()).toBe(false);
        expect(p.use).not.toHaveBeenCalled();
    });

    test('enabled but no provider fully configured → no providers', () => {
        process.env.SSO_ENABLED = '1';
        const p = fakePassport();
        expect(sso.configureSso(p)).toEqual([]);
        expect(sso.isConfigured()).toBe(false);
        expect(p.use).not.toHaveBeenCalled();
    });

    test('registers only fully-configured providers; skips partial config', () => {
        process.env.SSO_ENABLED = '1';
        // Entra — complete.
        process.env.AZURE_TENANT_ID = 't';
        process.env.AZURE_CLIENT_ID = 'c';
        process.env.AZURE_CLIENT_SECRET = 's';
        process.env.SSO_ENTRA_REDIRECT_URL = 'https://h/auth/sso/entra/callback';
        // Google — complete.
        process.env.GOOGLE_CLIENT_ID = 'g';
        process.env.GOOGLE_CLIENT_SECRET = 'gs';
        process.env.GOOGLE_REDIRECT_URL = 'https://h/auth/sso/google/callback';
        // OIDC — PARTIAL (missing OIDC_USERINFO_URL) → must be skipped.
        process.env.OIDC_ISSUER = 'i';
        process.env.OIDC_AUTH_URL = 'a';
        process.env.OIDC_TOKEN_URL = 'tk';
        process.env.OIDC_CLIENT_ID = 'ci';
        process.env.OIDC_CLIENT_SECRET = 'cs';
        process.env.OIDC_REDIRECT_URL = 'https://h/auth/sso/oidc/callback';

        const p = fakePassport();
        const keys = sso.configureSso(p).sort();
        expect(keys).toEqual(['entra', 'google']);
        expect(p.use).toHaveBeenCalledTimes(2);
        expect(sso.isConfigured()).toBe(true);

        const ui = sso.getEnabledProviders();
        expect(ui.map((x) => x.key).sort()).toEqual(['entra', 'google']);
        expect(ui.find((x) => x.key === 'google').icon).toBe('fab fa-google');

        expect(sso.getProvider('entra').strategyName).toBe('sso-entra');
        expect(sso.getProvider('google').authOptions).toEqual(
            expect.objectContaining({ scope: ['profile', 'email'], prompt: 'select_account' })
        );
        expect(sso.getProvider('unknown')).toBeNull();
    });

    test('entra accepts the legacy SSO_REDIRECT_URL fallback and custom label', () => {
        process.env.SSO_ENABLED = '1';
        process.env.AZURE_TENANT_ID = 't';
        process.env.AZURE_CLIENT_ID = 'c';
        process.env.AZURE_CLIENT_SECRET = 's';
        process.env.SSO_REDIRECT_URL = 'https://h/auth/sso/entra/callback';
        process.env.SSO_ENTRA_LABEL = 'Company SSO';

        const keys = sso.configureSso(fakePassport());
        expect(keys).toEqual(['entra']);
        expect(sso.getEnabledProviders()[0].label).toBe('Company SSO');
    });

    test('google enforces hosted-domain in the verify callback', async () => {
        process.env.SSO_ENABLED = '1';
        process.env.GOOGLE_CLIENT_ID = 'g';
        process.env.GOOGLE_CLIENT_SECRET = 'gs';
        process.env.GOOGLE_REDIRECT_URL = 'https://h/auth/sso/google/callback';
        process.env.GOOGLE_HD = 'allowed.com';

        const p = fakePassport();
        sso.configureSso(p);
        // The mocked Strategy stored (opts, verify); pull the verify fn back out.
        const verify = p.use.mock.calls[0][1].verify;
        const denied = await new Promise((resolve) =>
            verify(
                'at',
                'rt',
                { id: '1', _json: { hd: 'evil.com', email: 'x@evil.com' } },
                (err, user, info) => resolve({ user, info })
            )
        );
        expect(denied.user).toBe(false);
        expect(denied.info.message).toMatch(/permitted organization/i);
    });
});

describe('Entra API bearer auth (jose)', () => {
    const saved = {};
    beforeEach(() => {
        ENV_KEYS.forEach((k) => {
            saved[k] = process.env[k];
            delete process.env[k];
        });
    });
    afterEach(() => {
        ENV_KEYS.forEach((k) => {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        });
    });

    test('looksLikeJwt only matches three-segment base64url tokens', () => {
        expect(sso.looksLikeJwt('aaa.bbb.ccc')).toBe(true);
        expect(sso.looksLikeJwt('eyJhbGc.eyJzdWI.sig-part_09-AZ')).toBe(true);
        expect(sso.looksLikeJwt('sk_live_opaqueapikey')).toBe(false); // opaque API key
        expect(sso.looksLikeJwt('a.b')).toBe(false); // too few segments
        expect(sso.looksLikeJwt('a.b.c.d')).toBe(false); // too many
        expect(sso.looksLikeJwt('has spaces.b.c')).toBe(false);
        expect(sso.looksLikeJwt('')).toBe(false);
        expect(sso.looksLikeJwt(null)).toBe(false);
    });

    test('disabled by default — no strategy, no-op authenticate', async () => {
        // SSO off entirely.
        sso.configureSso(fakePassport());
        expect(sso.isEntraBearerEnabled()).toBe(false);
        await expect(
            sso.authenticateEntraBearer({ headers: { authorization: 'Bearer aaa.bbb.ccc' } })
        ).resolves.toBeNull();
    });

    test('interactive Entra login alone does NOT enable API bearer (explicit opt-in)', () => {
        // A full interactive Entra config, but no AZURE_API_CLIENT_ID.
        process.env.SSO_ENABLED = '1';
        process.env.AZURE_TENANT_ID = 't';
        process.env.AZURE_CLIENT_ID = 'c';
        process.env.AZURE_CLIENT_SECRET = 's';
        process.env.SSO_ENTRA_REDIRECT_URL = 'https://h/auth/sso/entra/callback';
        const p = fakePassport();
        sso.configureSso(p);
        expect(sso.isEntraBearerEnabled()).toBe(false);
        // Only the interactive OIDCStrategy was registered — no bearer strategy.
        expect(p.use).toHaveBeenCalledWith('sso-entra', expect.any(Object));
        expect(p.use.mock.calls.some((c) => c[0] === 'sso-entra-bearer')).toBe(false);
    });

    test('not registered when Azure creds are absent even with SSO on', () => {
        process.env.SSO_ENABLED = '1';
        const p = fakePassport();
        sso.configureSso(p);
        expect(sso.isEntraBearerEnabled()).toBe(false);
        // No BearerStrategy registered.
        expect(p.use).not.toHaveBeenCalled();
    });

    test('registers when tenant+AZURE_API_CLIENT_ID present; stays OUT of the login UI', () => {
        process.env.SSO_ENABLED = '1';
        process.env.AZURE_TENANT_ID = 't';
        process.env.AZURE_API_CLIENT_ID = 'c';
        const p = fakePassport();
        sso.configureSso(p);
        expect(sso.isEntraBearerEnabled()).toBe(true);
        // BearerStrategy registered under the bearer strategy name…
        expect(p.use).toHaveBeenCalledWith('sso-entra-bearer', expect.any(Object));
        // …but the bearer is NOT an interactive login button.
        expect(sso.getEnabledProviders().map((x) => x.key)).not.toContain('entra-bearer');
    });

    test('uses AZURE_API_CLIENT_ID as audience and validates issuer', () => {
        process.env.SSO_ENABLED = '1';
        process.env.AZURE_TENANT_ID = 'tenant-123';
        process.env.AZURE_API_CLIENT_ID = 'client-abc';
        const p = fakePassport();
        sso.configureSso(p);
        const opts = p.use.mock.calls.find((c) => c[0] === 'sso-entra-bearer')[1]._opts;
        expect(opts.clientID).toBe('client-abc');
        expect(opts.audiences).toEqual(expect.arrayContaining(['client-abc', 'api://client-abc']));
        expect(opts.issuers).toEqual(['https://login.microsoftonline.com/tenant-123/v2.0']);
        expect(opts.jwksUri).toBe(
            'https://login.microsoftonline.com/tenant-123/discovery/v2.0/keys'
        );
    });

    test('bearer claim mapping normalizes Entra token claims', () => {
        const m = sso.mapEntraBearerClaims({
            oid: 'oid-1',
            sub: 's-1',
            email: 'a@corp.com',
            email_verified: true,
            name: 'Ada L',
            given_name: 'Ada',
            family_name: 'L',
        });
        // upn / employeeId / tid are the SSO-migration claim keys (migration 144).
        expect(m).toEqual({
            oid: 'oid-1',
            sub: 's-1',
            email: 'a@corp.com',
            emailVerified: true,
            name: 'Ada L',
            firstName: 'Ada',
            lastName: 'L',
            upn: null,
            employeeId: null,
            tid: null,
        });
    });

    test('a non-JWT Authorization header is ignored even when bearer auth is on', async () => {
        process.env.SSO_ENABLED = '1';
        process.env.AZURE_TENANT_ID = 't';
        process.env.AZURE_API_CLIENT_ID = 'c';
        sso.configureSso(fakePassport());
        expect(sso.isEntraBearerEnabled()).toBe(true);
        // An opaque API key sent as a bearer must NOT be routed to Entra validation.
        await expect(
            sso.authenticateEntraBearer({
                headers: { authorization: 'Bearer sk_live_opaqueapikey' },
            })
        ).resolves.toBeNull();
    });
});
