'use strict';
/**
 * API keys in headers (a key in the URL only with the per-key legacy flag of
 * migration 163, or the env shared key with API_KEY_QUERY_STRING=1), anonymous
 * /api/v1 discovery reveals the status only, metrics allow-list, and the
 * SuperAdmin toggle. Real express + supertest; only the database-facing
 * services are mocked.
 */
const mockKeys = {
    ak_header_only: {
        id: 1,
        label: 'new',
        scope: 'powerbi.read',
        ownerAdminId: null,
        expiresAt: null,
        allowQueryKey: false,
    },
    ak_legacy: {
        id: 2,
        label: 'old',
        scope: 'powerbi.read',
        ownerAdminId: null,
        expiresAt: null,
        allowQueryKey: true,
    },
};
jest.mock('../../src/config/database', () => ({
    get: jest.fn(async () => undefined),
    all: jest.fn(async () => []),
    run: jest.fn(async () => ({ changes: 1 })),
}));
jest.mock('../../src/services/LogService', () => ({ log: jest.fn(async () => {}) }));
jest.mock('../../src/services/ApiKeyService', () => ({
    validate: jest.fn(async (k) => mockKeys[k] || null),
    setQueryKeyAllowed: jest.fn(async (id) => (Number(id) === 2 ? 1 : 0)),
    list: jest.fn(async () => []),
}));
jest.mock('../../src/config/sso', () => ({
    looksLikeJwt: (t) => /^ey[\w-]+\.[\w-]+\.[\w-]+$/.test(String(t || '')),
    isEntraBearerEnabled: () => false,
    authenticateEntraBearer: jest.fn(async () => null),
}));

const express = require('express');
const request = require('supertest');
const apiAuth = require('../../src/middleware/apiAuth');

function feedApp() {
    const app = express();
    app.get('/api/powerbi/employees', apiAuth.requireApiKey, (req, res) =>
        res.json({ ok: true, key: req._apiKey && req._apiKey.id })
    );
    return app;
}

describe('Power BI feeds: header by default, ?apiKey= only with the legacy flag', () => {
    test('X-API-Key header → 200', async () => {
        const r = await request(feedApp())
            .get('/api/powerbi/employees')
            .set('X-API-Key', 'ak_header_only');
        expect(r.status).toBe(200);
    });
    test('opaque Authorization: Bearer → 200', async () => {
        const r = await request(feedApp())
            .get('/api/powerbi/employees')
            .set('Authorization', 'Bearer ak_header_only');
        expect(r.status).toBe(200);
    });
    test('?apiKey= for a key WITHOUT the flag → 401, with the header hint', async () => {
        const r = await request(feedApp()).get('/api/powerbi/employees?apiKey=ak_header_only');
        expect(r.status).toBe(401);
        expect(r.body.error).toBe('api_key_in_url_refused');
        expect(r.body.hint).toMatch(/X-API-Key/);
    });
    test('?apiKey= for a key WITH the legacy flag → 200', async () => {
        const r = await request(feedApp()).get('/api/powerbi/employees?apiKey=ak_legacy');
        expect(r.status).toBe(200);
        expect(r.body.key).toBe(2);
    });
    describe('env shared key', () => {
        const saved = {};
        beforeEach(() => {
            for (const k of ['API_KEY', 'APP_KEY', 'API_KEY_QUERY_STRING'])
                saved[k] = process.env[k];
            delete process.env.API_KEY_QUERY_STRING;
            jest.resetModules();
        });
        afterEach(() => {
            for (const [k, v] of Object.entries(saved)) {
                if (v === undefined) delete process.env[k];
                else process.env[k] = v;
            }
        });
        function envApp() {
            jest.doMock('../../src/config/app', () => ({ apiKey: 'env-shared-key-123456' }));
            const a = require('../../src/middleware/apiAuth');
            const app = express();
            app.get('/api/powerbi/employees', a.requireApiKey, (req, res) => res.json({ ok: 1 }));
            return app;
        }
        test('in the header → 200; in the URL → 401 unless API_KEY_QUERY_STRING=1', async () => {
            const app = envApp();
            expect(
                (
                    await request(app)
                        .get('/api/powerbi/employees')
                        .set('X-API-Key', 'env-shared-key-123456')
                ).status
            ).toBe(200);
            expect(
                (await request(app).get('/api/powerbi/employees?apiKey=env-shared-key-123456'))
                    .status
            ).toBe(401);
            process.env.API_KEY_QUERY_STRING = '1';
            expect(
                (await request(app).get('/api/powerbi/employees?apiKey=env-shared-key-123456'))
                    .status
            ).toBe(200);
        });
    });
});

describe('/api/v1', () => {
    function v1App(user) {
        const app = express();
        app.use(express.json());
        app.use((req, res, next) => {
            req.isAuthenticated = () => !!user;
            req.user = user || undefined;
            next();
        });
        app.use('/api/v1', require('../../src/api/v1'));
        return app;
    }
    // supertest connects over loopback: X-Forwarded-For makes the caller REMOTE.
    const REMOTE = { 'X-Forwarded-For': '10.1.2.3' };

    test('anonymous remote GET /api/v1/ → status only (no version, no endpoints)', async () => {
        const r = await request(v1App()).get('/api/v1/').set(REMOTE);
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ status: 'ok' });
    });
    test('anonymous remote GET /api/v1/openapi.json → 401', async () => {
        const r = await request(v1App()).get('/api/v1/openapi.json').set(REMOTE);
        expect(r.status).toBe(401);
        expect(JSON.stringify(r.body)).not.toMatch(/paths|version/);
    });
    test('with a valid key → full discovery and the OpenAPI document', async () => {
        const d = await request(v1App())
            .get('/api/v1/')
            .set(REMOTE)
            .set('X-API-Key', 'ak_header_only');
        expect(d.body.version).toBeDefined();
        expect(Array.isArray(d.body.endpoints)).toBe(true);
        const o = await request(v1App())
            .get('/api/v1/openapi.json')
            .set(REMOTE)
            .set('X-API-Key', 'ak_header_only');
        expect(o.status).toBe(200);
        expect(o.body.paths).toBeDefined();
    });
    test('with an invalid key → 401 (never the document)', async () => {
        const r = await request(v1App()).get('/api/v1/').set(REMOTE).set('X-API-Key', 'bogus');
        expect(r.status).toBe(401);
    });
    test('loopback (installer post-deploy check) → version', async () => {
        const r = await request(v1App()).get('/api/v1/');
        expect(r.body.version).toBeDefined();
        expect(r.body.status).toBe('ok');
    });
    test('/api/v1/skills: ?apiKey= refused for a header-only key', async () => {
        const r = await request(v1App()).get('/api/v1/skills?apiKey=ak_header_only').set(REMOTE);
        expect(r.status).toBe(401);
        expect(r.body.error).toBe('api_key_in_url_refused');
    });

    describe('POST /api/v1/admin/api-keys/:id/query-string', () => {
        const svc = () => require('../../src/services/ApiKeyService');
        const sa = { id: 1, userType: 'admin', role: 'superadmin', username: 'root' };
        test('superadmin session toggles the flag', async () => {
            const r = await request(v1App(sa))
                .post('/api/v1/admin/api-keys/2/query-string')
                .send({ allowed: false });
            expect(r.status).toBe(200);
            expect(svc().setQueryKeyAllowed).toHaveBeenCalledWith(2, false, expect.anything());
        });
        test('a local admin session is refused', async () => {
            svc().setQueryKeyAllowed.mockClear();
            const r = await request(v1App({ ...sa, role: 'admin' }))
                .post('/api/v1/admin/api-keys/2/query-string')
                .send({ allowed: true });
            expect(r.status).toBe(403);
            expect(svc().setQueryKeyAllowed).not.toHaveBeenCalled();
        });
        test('non-boolean → 400; unknown key → 404', async () => {
            expect(
                (
                    await request(v1App(sa))
                        .post('/api/v1/admin/api-keys/2/query-string')
                        .send({ allowed: 'yes' })
                ).status
            ).toBe(400);
            expect(
                (
                    await request(v1App(sa))
                        .post('/api/v1/admin/api-keys/9/query-string')
                        .send({ allowed: true })
                ).status
            ).toBe(404);
        });
    });
});

describe('/metrics allow-list', () => {
    const saved = {};
    beforeEach(() => {
        saved.a = process.env.METRICS_ALLOW_IPS;
        saved.t = process.env.METRICS_TOKEN;
        delete process.env.METRICS_TOKEN;
    });
    afterEach(() => {
        if (saved.a === undefined) delete process.env.METRICS_ALLOW_IPS;
        else process.env.METRICS_ALLOW_IPS = saved.a;
        if (saved.t === undefined) delete process.env.METRICS_TOKEN;
        else process.env.METRICS_TOKEN = saved.t;
    });
    const req = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers });
    test('a listed LAN peer is admitted; an unlisted one is not', () => {
        process.env.METRICS_ALLOW_IPS = '10.0.0.7, 10.0.0.8';
        expect(apiAuth.metricsAccessAllowed(req('10.0.0.7'))).toBe(true);
        expect(apiAuth.metricsAccessAllowed(req('::ffff:10.0.0.8'))).toBe(true);
        expect(apiAuth.metricsAccessAllowed(req('10.0.0.9'))).toBe(false);
    });
    test('never through a forwarding proxy, even from a listed peer', () => {
        process.env.METRICS_ALLOW_IPS = '10.0.0.7';
        expect(
            apiAuth.metricsAccessAllowed(req('10.0.0.7', { 'x-forwarded-for': '1.2.3.4' }))
        ).toBe(false);
    });
    test('no list: loopback only', () => {
        delete process.env.METRICS_ALLOW_IPS;
        expect(apiAuth.metricsAccessAllowed(req('127.0.0.1'))).toBe(true);
        expect(apiAuth.metricsAccessAllowed(req('10.0.0.7'))).toBe(false);
    });
});
