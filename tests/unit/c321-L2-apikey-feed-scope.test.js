'use strict';
/**
 * 3.23.21 — lane L2, SEC-2: an API key opens ONLY the feed its scope names.
 *
 * `requireApiKey` authenticated the key and stopped there. Measured before the
 * fix (this file, reverted source): a `safety.read` key read the Power BI HR
 * feeds (200), a `powerbi.read` key listed SCIM Users, and a key minted through
 * POST /api/v1/admin/api-keys with the free-text scope 'full' opened everything
 * — and wrote. The API-key × feed matrix below is the regression net.
 *
 * DB-free: ApiKeyService / AdminModel / sso are mocked; the middleware and the
 * v1 router are the real ones.
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';
jest.mock('../../src/config/sso', () => ({
    looksLikeJwt: (t) => /^ey/.test(String(t || '')),
    isEntraBearerEnabled: () => true,
    authenticateEntraBearer: jest.fn(async () => ({
        id: 12,
        userType: 'admin',
        role: 'localadmin',
        apiScope: 'entra.bearer',
    })),
}));
jest.mock('../../src/services/ApiKeyService', () => ({
    validate: jest.fn(),
    generate: jest.fn(async (o) => ({ id: 1, ...o, key: 'idv_new' })),
    list: jest.fn(async () => []),
    revoke: jest.fn(),
}));
jest.mock('../../src/models/AdminModel', () => ({
    findWithScopes: jest.fn(async (id) => ({ id, role: 'localadmin', isActive: true, scopes: [] })),
}));
jest.mock('../../src/config/app', () => ({ apiKey: 'legacy-env-key-0123456789', env: 'test' }));
jest.mock('../../src/api/v1/repository', () => {
    const empty = {
        list: jest.fn(async () => [{ id: 1, name: 'x' }]),
        count: jest.fn(async () => 1),
    };
    return {
        SkillsRepository: empty,
        ReadinessRepository: empty,
        EmployeesRepository: empty,
        TalentRepository: empty,
        DevelopmentRepository: empty,
        GoalsRepository: empty,
        CheckInsRepository: empty,
    };
});

const ApiKeyService = require('../../src/services/ApiKeyService');
const apiAuth = require('../../src/middleware/apiAuth');
const { requireApiKey, feedScopeAllowed, issuableScope, ISSUABLE_API_KEY_SCOPES } = apiAuth;

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

/** Drive requireApiKey for a key of `scope` against `url`; true = let through. */
async function passes(scope, url, { key = 'idv_k', headers = {} } = {}) {
    if (scope === undefined) ApiKeyService.validate.mockResolvedValue(null);
    else
        ApiKeyService.validate.mockResolvedValue({
            id: 3,
            label: 'k',
            scope,
            ownerAdminId: null,
        });
    const req = { headers: { 'x-api-key': key, ...headers }, query: {}, originalUrl: url };
    const res = mkRes();
    const next = jest.fn();
    await requireApiKey(req, res, next);
    if (!next.mock.calls.length) expect(res.statusCode).toBe(403);
    return next.mock.calls.length === 1;
}

const FEEDS = {
    powerbi: '/api/powerbi/employees',
    powerbiCert: '/api/powerbi/certifications?x=1',
    scim: '/scim/v2/Users',
    safety: '/v2/safety-gate/status/E001',
};

describe('SEC-2 — API key × feed matrix (requireApiKey)', () => {
    beforeEach(() => ApiKeyService.validate.mockReset());

    // scope → the feeds it must open; every other feed must be refused.
    const MATRIX = {
        'powerbi.read': ['powerbi', 'powerbiCert'],
        read: ['powerbi', 'powerbiCert'],
        'safety.read': ['safety'],
        'scim.write': ['scim'],
        'scim.read': ['scim'],
        full: [],
        admin: [],
        'goals.write': [],
        '': [],
        'safety.write': [],
    };
    for (const [scope, open] of Object.entries(MATRIX)) {
        for (const [feed, url] of Object.entries(FEEDS)) {
            const expected = open.includes(feed);
            test(`scope '${scope}' on ${feed} → ${expected ? 'allowed' : '403'}`, async () => {
                expect(await passes(scope, url)).toBe(expected);
            });
        }
    }

    test('a URL that belongs to no known feed is refused, whatever the scope', async () => {
        expect(await passes('powerbi.read', '/employees/list')).toBe(false);
        expect(await passes('scim.write', '/admin/api-keys')).toBe(false);
    });

    test('the SCIM refusal is SCIM-shaped (an IdP parses it)', async () => {
        ApiKeyService.validate.mockResolvedValue({
            id: 3,
            label: 'k',
            scope: 'powerbi.read',
            ownerAdminId: null,
        });
        const req = { headers: { 'x-api-key': 'k' }, query: {}, originalUrl: '/scim/v2/Users' };
        const res = mkRes();
        await requireApiKey(req, res, jest.fn());
        expect(res.statusCode).toBe(403);
        expect(res.body.scimType).toBe('noPermission');
        expect(req.user).toBeUndefined(); // never became a principal
    });

    test('the legacy env key keeps Power BI, and reaches neither SCIM nor the safety gate', async () => {
        const opts = { key: 'legacy-env-key-0123456789' };
        expect(await passes(undefined, FEEDS.powerbi, opts)).toBe(true);
        expect(await passes(undefined, FEEDS.scim, opts)).toBe(false);
        expect(await passes(undefined, FEEDS.safety, opts)).toBe(false);
    });

    test('an Entra bearer principal keeps Power BI, not SCIM', async () => {
        const run = async (url) => {
            const req = {
                headers: { authorization: 'Bearer eyJhbGciOi.x.y' },
                query: {},
                originalUrl: url,
            };
            const next = jest.fn();
            await requireApiKey(req, mkRes(), next);
            return next.mock.calls.length === 1;
        };
        expect(await run(FEEDS.powerbi)).toBe(true);
        expect(await run(FEEDS.scim)).toBe(false);
    });

    test('feedScopeAllowed: v1 refuses safety.* and scim.* keys, accepts the read scopes', () => {
        expect(feedScopeAllowed('v1', 'safety.read')).toBe(false);
        expect(feedScopeAllowed('v1', 'scim.write')).toBe(false);
        expect(feedScopeAllowed('v1', 'full')).toBe(false);
        expect(feedScopeAllowed('v1', 'powerbi.read')).toBe(true);
        expect(feedScopeAllowed('v1', 'legacy.shared')).toBe(true);
        expect(feedScopeAllowed('nope', 'powerbi.read')).toBe(false);
    });
});

describe('SEC-2 — issuable scopes: ONE list for the admin page and /api/v1', () => {
    test('the list, and the refusal of anything else', () => {
        expect([...ISSUABLE_API_KEY_SCOPES].sort()).toEqual(
            ['powerbi.read', 'read', 'safety.read', 'scim.write'].sort()
        );
        expect(issuableScope('SAFETY.READ ')).toBe('safety.read');
        for (const s of ['full', 'admin', 'rw', 'goals.write', 'powerbi.readwrite', 'safety.*'])
            expect(issuableScope(s)).toBeNull();
    });

    const express = require('express');
    const request = require('supertest');
    function v1App() {
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = { id: 1, userType: 'admin', role: 'superadmin' };
            req.isAuthenticated = () => true;
            next();
        });
        app.use('/api/v1', require('../../src/api/v1'));
        return app;
    }

    test.each(['full', 'admin', 'goals.write', 'anything'])(
        "POST /api/v1/admin/api-keys refuses scope '%s' (400) and mints nothing",
        async (scope) => {
            ApiKeyService.generate.mockClear();
            const r = await request(v1App())
                .post('/api/v1/admin/api-keys')
                .send({ label: 'x', scope });
            expect(r.status).toBe(400);
            expect(r.body.error).toBe('bad_scope');
            expect(ApiKeyService.generate).not.toHaveBeenCalled();
        }
    );

    /**
     * PINNED — needs a coordinator edit in src/api/v1/index.js `apiAuth` (outside
     * this lane's ownership, which is the key-CREATION scope only): after
     * `ApiKeyService.validate` returns a principal, refuse it unless
     * `feedScopeAllowed('v1', principal.scope)`, and refuse the legacy key unless
     * `feedScopeAllowed('v1', 'legacy.shared')` (true). When that lands this
     * test.failing FAILS — then turn it into a plain test.
     */
    test('GET /api/v1/employees with a safety.read key is refused 403 (SEC-2, v1 half)', async () => {
        ApiKeyService.validate.mockResolvedValue({
            id: 4,
            label: 's',
            scope: 'safety.read',
            ownerAdminId: null,
        });
        const app = express();
        app.use((req, _res, next) => {
            req.isAuthenticated = () => false;
            next();
        });
        app.use('/api/v1', require('../../src/api/v1'));
        const r = await request(app).get('/api/v1/employees').set('X-API-Key', 'idv_safety');
        expect(r.status).toBe(403);
    });

    test('POST /api/v1/admin/api-keys: an issuable scope is minted; none → powerbi.read', async () => {
        ApiKeyService.generate.mockClear();
        let r = await request(v1App())
            .post('/api/v1/admin/api-keys')
            .send({ label: 'x', scope: 'scim.write' });
        expect(r.status).toBe(201);
        expect(ApiKeyService.generate.mock.calls[0][0].scope).toBe('scim.write');
        r = await request(v1App()).post('/api/v1/admin/api-keys').send({ label: 'y' });
        expect(r.status).toBe(201);
        expect(ApiKeyService.generate.mock.calls[1][0].scope).toBe('powerbi.read');
    });
});
