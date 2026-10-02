'use strict';

/**
 * SSO reply URLs.
 *
 * 1. The base URL was set to the sign-in page ("https://host/login").
 *    Invitations linked to "/login/login" and the SAML reply URL suggested by
 *    the SSO page became "/login/auth/sso/saml/callback", a path no route
 *    answered, so every SSO sign-in bounced back to /login.
 * 2. A reply URL saved on the SSO page as ".../auth/saml/saml/callback" (a typo
 *    of the canonical ".../auth/sso/saml/callback") was registered in the IdP.
 *    No route answered it, so the IdP's POST hit the origin guard
 *    ({"error":"cross_origin_blocked"}), and the SSO page handed the wrong
 *    value back as the one to paste.
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';
jest.mock('../../src/config/database', () => ({ get: jest.fn(), all: jest.fn(), run: jest.fn() }));

const fs = require('fs');

const OLD = process.env.SAML_CALLBACK_URL;
afterEach(() => {
    if (OLD === undefined) delete process.env.SAML_CALLBACK_URL;
    else process.env.SAML_CALLBACK_URL = OLD;
});

const T = require('../../src/utils/emailTemplate');
const sso = require('../../src/config/sso');
const H = require('../../src/middleware/httpHardening');
const SamlMetadataService = require('../../src/services/SamlMetadataService');
const { callbackMismatch } = require('../../src/controllers/SsoSettingsController');
const ROUTES = fs.readFileSync(require.resolve('../../src/routes/index.js'), 'utf8');

describe('base URL is the application root', () => {
    test.each([
        ['https://app.example.com/login', 'https://app.example.com'],
        ['https://app.example.com/login/', 'https://app.example.com'],
        ['https://app.example.com/LOGIN', 'https://app.example.com'],
        ['https://app.example.com/dashboard', 'https://app.example.com'],
        ['https://app.example.com/logout', 'https://app.example.com'],
        ['https://app.example.com/auth/sso/saml/callback', 'https://app.example.com'],
        ['https://app.example.com/talent/login', 'https://app.example.com/talent'],
        ['https://app.example.com', 'https://app.example.com'],
        ['https://app.example.com/talent/', 'https://app.example.com/talent'],
        ['', ''],
    ])('%s -> %s', (raw, want) => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        expect(T.normalizeBase(raw)).toBe(want);
    });

    test('APP_BASE_URL ending in /login is normalised too', () => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const old = process.env.APP_BASE_URL;
        process.env.APP_BASE_URL = 'https://app.example.com/login';
        try {
            expect(T.baseUrl()).toBe('https://app.example.com');
        } finally {
            if (old === undefined) delete process.env.APP_BASE_URL;
            else process.env.APP_BASE_URL = old;
        }
    });
});

describe('the /login-prefixed callback is treated as an IdP callback', () => {
    test('CSRF skip covers both the canonical and the /login-prefixed callback', () => {
        for (const p of ['/auth/sso/saml/callback', '/login/auth/sso/oidc/callback']) {
            expect(H.csrfSkip({ path: p, method: 'POST', headers: {} })).toBe(true);
        }
        expect(
            H.csrfSkip({ path: '/foo/auth/sso/saml/callback', method: 'POST', headers: {} })
        ).not.toBe(true);
    });

    test('routes: the compatibility callback and /login/login exist, above requireAuth', () => {
        const auth = /^router\.use\(requireAuth\);/m.exec(ROUTES).index;
        for (const re of [
            /router\.post\(\s*'\/login\/auth\/sso\/:provider\/callback',\s*SsoController\.callback\s*\)/,
            /router\.get\(\s*'\/login\/auth\/sso\/:provider\/callback',\s*SsoController\.callback\s*\)/,
            /router\.get\(\s*'\/login\/login'/,
        ]) {
            const m = re.exec(ROUTES);
            expect(m).not.toBeNull();
            expect(m.index).toBeLessThan(auth);
        }
    });
});

describe('the configured SAML ACS is answered too', () => {
    test('a non-canonical configured ACS becomes an alias path', () => {
        process.env.SAML_CALLBACK_URL = 'https://app.example.com/auth/saml/saml/callback';
        expect(sso.samlCallbackAliasPath()).toBe('/auth/saml/saml/callback');
    });

    test('the canonical ACS, a page path or garbage never become an alias', () => {
        for (const v of [
            'https://app.example.com/auth/sso/saml/callback',
            'https://app.example.com/dashboard',
            'https://app.example.com/login/auth/sso/saml/callback',
            'not a url',
            '',
        ]) {
            process.env.SAML_CALLBACK_URL = v;
            expect(sso.samlCallbackAliasPath()).toBeNull();
        }
    });

    test('the IdP POST to the configured ACS skips CSRF and passes the origin guard', async () => {
        process.env.SAML_CALLBACK_URL = 'https://app.example.com/auth/saml/saml/callback';
        expect(H.csrfSkip({ path: '/auth/saml/saml/callback', method: 'POST', headers: {} })).toBe(
            true
        );
        const guard = H.originGuard({ trustProxy: false, validatedCredential: async () => false });
        const next = jest.fn();
        const res = { status: jest.fn(() => res), json: jest.fn() };
        await guard(
            {
                method: 'POST',
                path: '/auth/saml/saml/callback',
                headers: { origin: 'https://idp.example.net', host: 'app.example.com' },
            },
            res,
            next
        );
        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
    });

    test('without the setting, that path is an ordinary cross-site POST', async () => {
        delete process.env.SAML_CALLBACK_URL;
        expect(H.csrfSkip({ path: '/auth/saml/saml/callback', method: 'POST', headers: {} })).toBe(
            false
        );
    });

    test('any other cross-site POST is still blocked', async () => {
        process.env.SAML_CALLBACK_URL = 'https://app.example.com/auth/saml/saml/callback';
        const guard = H.originGuard({ trustProxy: false, validatedCredential: async () => false });
        const next = jest.fn();
        const res = { status: jest.fn(() => res), json: jest.fn() };
        await guard(
            {
                method: 'POST',
                path: '/admin/settings',
                headers: { origin: 'https://evil.example.net', host: 'app.example.com' },
            },
            res,
            next
        );
        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(403);
    });

    test('routes: the configured-ACS alias is mounted above requireAuth', () => {
        const auth = /^router\.use\(requireAuth\);/m.exec(ROUTES).index;
        const alias = ROUTES.indexOf("require('../config/sso').samlCallbackAliasPath()");
        expect(alias).toBeGreaterThan(-1);
        expect(alias).toBeLessThan(auth);
    });
});

describe('the SSO page', () => {
    test('always shows the canonical reply URL to paste into the IdP', () => {
        const v = SamlMetadataService.spValues('https://app.example.com', {
            callbackUrl: 'https://app.example.com/auth/saml/saml/callback',
        });
        expect(v.acsUrl).toBe('https://app.example.com/auth/sso/saml/callback');
        expect(SamlMetadataService.spValues('https://app.example.com/').acsUrl).toBe(
            'https://app.example.com/auth/sso/saml/callback'
        );
    });

    test('names a configured ACS that differs, with the address to register', () => {
        const base = 'https://app.example.com';
        expect(callbackMismatch(`${base}/auth/sso/saml/callback`, base)).toBeNull();
        expect(callbackMismatch(`${base}/auth/sso/saml/callback/`, base)).toBeNull();
        expect(callbackMismatch('', base)).toBeNull();
        expect(callbackMismatch(`${base}/login/auth/sso/saml/callback`, base)).toEqual({
            configured: `${base}/login/auth/sso/saml/callback`,
            expected: `${base}/auth/sso/saml/callback`,
        });
    });
});
