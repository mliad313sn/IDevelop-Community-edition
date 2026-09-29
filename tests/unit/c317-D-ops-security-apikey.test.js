'use strict';
/**
 * 3.23.17 lane D — S-02: the at-rest encryption key (APP_KEY) must never double
 * as a superadmin-scope bearer credential.
 *
 * THE HOLE: src/config/app.js resolved `apiKey = API_KEY || APP_KEY`. The
 * installer writes ONLY APP_KEY into .env, so on every appliance the value that
 * encrypts MFA/SSO/LMS secrets was ALSO accepted by apiAuth (and /api/v1) as the
 * legacy shared key -> full-org SYSTEM principal (role superadmin).
 *
 * Behavioural: the real config module is loaded under env permutations and the
 * real middleware is driven with the resulting config.
 */

jest.mock('../../src/config/sso', () => ({
    looksLikeJwt: () => false,
    isEntraBearerEnabled: () => false,
    authenticateEntraBearer: async () => null,
}));
jest.mock('../../src/services/ApiKeyService', () => ({ validate: jest.fn(async () => null) }));
jest.mock('../../src/models/AdminModel', () => ({ findWithScopes: jest.fn() }));

const APP_KEY = 'a'.repeat(8) + '9f3c1e7b5d2a4c6e8f0b1d3a5c7e9f1b';
const OTHER = 'k7Qp2Xv9Lm4Rt8Wz1Ny6Bc3Hd5Fj0Gs';

const SAVED = {};
const KEYS = ['API_KEY', 'APP_KEY', 'NODE_ENV', 'SESSION_SECRET'];
beforeEach(() => {
    KEYS.forEach((k) => {
        SAVED[k] = process.env[k];
        delete process.env[k];
    });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    KEYS.forEach((k) => {
        if (SAVED[k] === undefined) delete process.env[k];
        else process.env[k] = SAVED[k];
    });
    jest.restoreAllMocks();
});

function loadConfig(env) {
    Object.assign(process.env, env);
    let cfg;
    jest.isolateModules(() => {
        cfg = require('../../src/config/app');
    });
    return cfg;
}
function loadAuth(env) {
    Object.assign(process.env, env);
    let mod;
    jest.isolateModules(() => {
        mod = require('../../src/middleware/apiAuth');
    });
    return mod;
}
function mkRes() {
    const res = { statusCode: null, body: null };
    res.status = (c) => {
        res.statusCode = c;
        return res;
    };
    res.json = (b) => {
        res.body = b;
        return res;
    };
    return res;
}
async function call(requireApiKey, key) {
    const req = { headers: { 'x-api-key': key }, query: {} };
    const res = mkRes();
    const next = jest.fn();
    await requireApiKey(req, res, next);
    return { req, res, next };
}

describe('config/app — apiKey resolution', () => {
    test('APP_KEY alone is NOT a legacy API key (was: apiKey === APP_KEY)', () => {
        const cfg = loadConfig({ APP_KEY, NODE_ENV: 'development' });
        expect(cfg.apiKey).toBeNull();
    });

    test('APP_KEY alone in production does not crash the boot and yields no API key', () => {
        const cfg = loadConfig({ APP_KEY, NODE_ENV: 'production', SESSION_SECRET: OTHER + OTHER });
        expect(cfg.apiKey).toBeNull();
    });

    test('an explicit API_KEY that differs from APP_KEY is the legacy key', () => {
        const cfg = loadConfig({ APP_KEY, API_KEY: OTHER, NODE_ENV: 'development' });
        expect(cfg.apiKey).toBe(OTHER);
    });

    test('API_KEY equal to APP_KEY is refused (null) with a boot warning', () => {
        const cfg = loadConfig({ APP_KEY, API_KEY: APP_KEY, NODE_ENV: 'development' });
        expect(cfg.apiKey).toBeNull();
        expect(cfg.apiKeyRefused).toMatch(/APP_KEY/);
        expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/API_KEY.*APP_KEY/));
    });

    test('no key at all: no generated ephemeral superadmin key either', () => {
        const cfg = loadConfig({ NODE_ENV: 'development' });
        expect(cfg.apiKey).toBeNull();
    });
});

describe('apiAuth — the encryption key never authenticates', () => {
    test('X-API-Key = APP_KEY is 403 when API_KEY is unset (installer default)', async () => {
        const { requireApiKey } = loadAuth({ APP_KEY, NODE_ENV: 'development' });
        const { req, res, next } = await call(requireApiKey, APP_KEY);
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
        expect(req.user).toBeUndefined();
    });

    test('X-API-Key = APP_KEY is 403 when API_KEY was set to the same value', async () => {
        const { requireApiKey } = loadAuth({ APP_KEY, API_KEY: APP_KEY, NODE_ENV: 'development' });
        const { res, next } = await call(requireApiKey, APP_KEY);
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
    });

    test('a distinct, explicit API_KEY still works as the legacy shared key', async () => {
        const { requireApiKey } = loadAuth({ APP_KEY, API_KEY: OTHER, NODE_ENV: 'development' });
        const ok = await call(requireApiKey, OTHER);
        expect(ok.next).toHaveBeenCalled();
        expect(ok.req._apiKey.scope).toBe('legacy.shared');
        // ...and APP_KEY is still refused next to it.
        const ko = await call(requireApiKey, APP_KEY);
        expect(ko.res.statusCode).toBe(403);
    });

    test('defence in depth: a config whose apiKey equals APP_KEY is still refused', async () => {
        process.env.APP_KEY = APP_KEY;
        let mod;
        jest.isolateModules(() => {
            jest.doMock('../../src/config/app', () => ({ apiKey: APP_KEY, env: 'test' }));
            mod = require('../../src/middleware/apiAuth');
        });
        const { res, next } = await call(mod.requireApiKey, APP_KEY);
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
        jest.dontMock('../../src/config/app');
    });
});
