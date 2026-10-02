'use strict';
/**
 * HTTP hardening, proved on a real express stack (express + express-session +
 * csrf-sync + supertest) with the SAME middleware server.js mounts
 * (src/middleware/httpHardening.js):
 *   - JSON detection on the MIME essence (anchored);
 *   - `Origin: null` refused on every mutation unless a machine credential
 *     validates; pages send Referrer-Policy: same-origin (server.js, helmet);
 *   - Permissions-Policy on every response; no-referrer on /api and /scim;
 *   - the CSRF failure log carries no session id; logout Clear-Site-Data;
 *   - `__Host-` cookie name when always Secure, one-time bridge from app.sid;
 *   - /health and /readyz answer the status only to an ungated caller;
 *   - a successful mutation is not a system_logs event;
 *   - /metrics: METRICS_ALLOW_IPS;
 *   - /api/v1 discovery: status only for an anonymous remote caller.
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const express = require('express');
const session = require('express-session');
const request = require('supertest');
const fs = require('fs');
const path = require('path');
const { csrfSync } = require('csrf-sync');
const H = require('../../src/middleware/httpHardening');

const SERVER = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');

describe('isJsonType is anchored on the MIME essence', () => {
    test.each([
        ['application/json', true],
        ['application/json; charset=utf-8', true],
        ['Application/JSON', true],
        ['application/scim+json', true],
        ['application/scim+json; charset=utf-8', true],
        ['text/plain; x=application/json', false],
        ['multipart/form-data; boundary=application/json', false],
        ['application/x-www-form-urlencoded', false],
        ['text/application/json', false],
        ['', false],
        [undefined, false],
    ])('%s -> %s', (ct, want) => {
        expect(H.isJsonType(ct)).toBe(want);
    });

    test('server.js parses exactly the JSON media types the guard recognises', () => {
        expect(H.JSON_TYPES).toEqual(['application/json', 'application/*+json']);
        expect(SERVER).toMatch(/express\.json\(\{[^}]*type: _JSON_TYPES/);
        expect(SERVER).not.toMatch(/const _isJsonType/);
    });
});

// The same token source server.js gives csrf-sync.
const tokenFromRequest = (req) => (req.body && req.body._csrf) || req.headers['x-csrf-token'];

function buildApp({ credentialOk = false } = {}) {
    const app = express();
    const logged = [];
    app.use(H.securityHeaders);
    app.use(express.urlencoded({ extended: false }));
    app.use(express.json({ type: [...H.JSON_TYPES] }));
    app.use(
        session({
            secret: 'test-secret',
            resave: false,
            saveUninitialized: true,
            name: 'app.sid',
        })
    );
    app.use(
        H.originGuard({
            trustProxy: () => false,
            validatedCredential: async () => credentialOk,
            secLog: (req, action) => logged.push(action),
        })
    );
    const { generateToken, csrfSynchronisedProtection } = csrfSync({
        getTokenFromRequest: tokenFromRequest,
    });
    const failures = [];
    app.use((req, res, next) => {
        if (H.csrfSkip(req)) return next();
        csrfSynchronisedProtection(req, res, (err) => {
            if (err) {
                failures.push(H.csrfFailureLogFields(req));
                return res.status(403).send('Invalid CSRF token');
            }
            next();
        });
    });
    app.get('/token', (req, res) => res.json({ t: generateToken(req) }));
    const ok = (req, res) => res.json({ ok: true });
    app.post('/form', ok);
    app.post('/json', ok);
    app.post('/auth/sso/saml/callback', ok);
    app.get('/api/v1/x', (req, res) => res.json({ ok: true }));
    app.get('/scim/v2/Users', (req, res) => res.json({ ok: true }));
    app.get('/page', (req, res) => res.send('page'));
    return { app, logged, failures };
}

async function withToken(app) {
    const agent = request.agent(app);
    const r = await agent.get('/token');
    return { agent, token: r.body.t };
}

describe('CSRF skip list', () => {
    test('a JSON-looking parameter on a form post no longer skips CSRF', async () => {
        const { app } = buildApp();
        const { agent } = await withToken(app);
        const r = await agent
            .post('/form')
            .set('Content-Type', 'text/plain; x=application/json')
            .send('a=1');
        expect(r.status).toBe(403);
    });
    test('a real JSON body skips the token (the origin guard covers it)', () => {
        expect(
            H.csrfSkip({
                path: '/x',
                method: 'POST',
                headers: { 'content-type': 'application/json' },
            })
        ).toBe(true);
    });
    test('the multipart imports listed for SA-15 are still exempt, by prefix only', () => {
        const post = (p) => H.csrfSkip({ path: p, method: 'POST', headers: {} });
        expect(post('/data-management/import/employees')).toBe(true);
        expect(post('/admin/data/import')).toBe(true);
        expect(post('/compliance/certifications')).toBe(true);
        expect(post('/compliance/certifications/extra')).toBe(false);
        expect(post('/x/data-management/import/')).toBe(false);
        expect(post('/form')).toBe(false);
    });
    test('SSO callback POSTs skip the token', () => {
        expect(H.csrfSkip({ path: '/auth/sso/oidc/callback', method: 'POST', headers: {} })).toBe(
            true
        );
    });
});

describe('the CSRF failure log never carries the session id', () => {
    test('only a short hash prefix', async () => {
        const { app, failures } = buildApp();
        const { agent } = await withToken(app);
        await agent.post('/form').type('form').send('a=1');
        expect(failures).toHaveLength(1);
        const f = failures[0];
        expect(f).not.toHaveProperty('sessionId');
        expect(Object.values(f).join(' ')).not.toMatch(/[A-Za-z0-9_-]{20,}/);
        expect(f.sidHash).toMatch(/^[0-9a-f]{8}$/);
    });
    test('server.js logs through csrfFailureLogFields', () => {
        expect(SERVER).toMatch(/httpHardening\.csrfFailureLogFields\(req\)/);
        expect(SERVER).not.toMatch(/sessionId: req\.sessionID/);
    });
});

describe('origin guard', () => {
    test('Origin: null on a form post is refused (403)', async () => {
        const { app, logged } = buildApp();
        const { agent, token } = await withToken(app);
        const r = await agent
            .post('/form')
            .set('Origin', 'null')
            .type('form')
            .send('_csrf=' + token);
        expect(r.status).toBe(403);
        expect(r.body.error).toBe('origin_required');
        expect(logged).toContain('ORIGIN_GUARD_BLOCKED');
    });
    test('Origin: null on a JSON mutation is refused', async () => {
        const { app } = buildApp();
        const r = await request(app).post('/json').set('Origin', 'null').send({ a: 1 });
        expect(r.status).toBe(403);
    });
    test('Origin: null with a VALIDATED machine credential passes', async () => {
        const { app } = buildApp({ credentialOk: true });
        const r = await request(app).post('/json').set('Origin', 'null').send({ a: 1 });
        expect(r.status).toBe(200);
    });
    test('a malformed Origin on a form post is refused', async () => {
        const { app } = buildApp();
        const { agent, token } = await withToken(app);
        const r = await agent
            .post('/form')
            .set('Origin', 'not a url')
            .type('form')
            .send('_csrf=' + token);
        expect(r.status).toBe(403);
    });
    test('same-origin form post with the token passes', async () => {
        const { app } = buildApp();
        const { agent, token } = await withToken(app);
        const r = await agent
            .post('/form')
            .set('Host', 'app.test')
            .set('Origin', 'http://app.test')
            .type('form')
            .send('_csrf=' + token);
        expect(r.status).toBe(200);
    });
    test('an Origin-less form post goes on to the token check', async () => {
        const { app } = buildApp();
        const { agent, token } = await withToken(app);
        const r = await agent
            .post('/form')
            .type('form')
            .send('_csrf=' + token);
        expect(r.status).toBe(200);
    });
    test('cross-origin post is refused', async () => {
        const { app } = buildApp();
        const r = await request(app)
            .post('/json')
            .set('Origin', 'http://evil.example')
            .send({ a: 1 });
        expect(r.status).toBe(403);
        expect(r.body.error).toBe('cross_origin_blocked');
    });
    test('origin-less JSON mutation without a key is refused', async () => {
        const { app } = buildApp();
        const r = await request(app).post('/json').send({ a: 1 });
        expect(r.status).toBe(403);
    });
    test('the IdP callback is cross-site by design and passes', async () => {
        const { app } = buildApp();
        const r = await request(app)
            .post('/auth/sso/saml/callback')
            .set('Origin', 'https://idp.example.net')
            .type('form')
            .send('SAMLResponse=x');
        expect(r.status).toBe(200);
    });
});

describe('makeValidatedApiCredential', () => {
    const mk = (validate, legacy = null, jwtOk = false) =>
        H.makeValidatedApiCredential({
            sso: () => ({
                looksLikeJwt: (t) => /^ey/.test(t),
                isEntraBearerEnabled: () => jwtOk,
            }),
            apiKeys: () => ({ validate }),
            apiAuth: () => ({ legacySharedKey: () => legacy }),
        });
    test('the mere presence of a key is not enough', async () => {
        const v = mk(async () => null);
        expect(await v({ headers: { 'x-api-key': 'bogus' }, query: {} })).toBe(false);
        expect(await v({ headers: {}, query: { apiKey: 'bogus' } })).toBe(false);
        expect(await v({ headers: {}, query: {} })).toBe(false);
    });
    test('a key that validates, or the legacy shared key, counts', async () => {
        expect(
            await mk(async () => ({ id: 1 }))({ headers: { 'x-api-key': 'ak_x' }, query: {} })
        ).toBe(true);
        expect(
            await mk(
                async () => null,
                'legacy-key-123'
            )({
                headers: { 'x-api-key': 'legacy-key-123' },
                query: {},
            })
        ).toBe(true);
    });
    test('a JWT bearer counts only when Entra bearer auth is enabled', async () => {
        const req = { headers: { authorization: 'Bearer eyJ.a.b' }, query: {} };
        expect(await mk(async () => null, null, false)(req)).toBe(false);
        expect(await mk(async () => null, null, true)(req)).toBe(true);
    });
});

describe('headers', () => {
    test('Permissions-Policy on every response', async () => {
        const { app } = buildApp();
        for (const p of ['/page', '/api/v1/x']) {
            const r = await request(app).get(p);
            const pp = r.headers['permissions-policy'];
            for (const f of ['camera', 'microphone', 'geolocation', 'payment', 'usb', 'bluetooth'])
                expect(pp).toMatch(new RegExp(`(^|, )${f}=\\(\\)`));
        }
    });
    test('Referrer-Policy: no-referrer on /api and /scim only', async () => {
        const { app } = buildApp();
        expect((await request(app).get('/api/v1/x')).headers['referrer-policy']).toBe(
            'no-referrer'
        );
        expect((await request(app).get('/scim/v2/Users')).headers['referrer-policy']).toBe(
            'no-referrer'
        );
        expect((await request(app).get('/page')).headers['referrer-policy']).toBeUndefined();
    });
    test('pages get same-origin from helmet in server.js', () => {
        expect(SERVER).toMatch(/referrerPolicy: \{ policy: 'same-origin' \}/);
        expect(SERVER).toMatch(/app\.use\(httpHardening\.securityHeaders\)/);
    });
});

describe('session cookie name', () => {
    test('__Host- only when the cookie is always Secure', () => {
        expect(H.sessionCookieName({ env: {}, cookieSecure: true })).toBe('__Host-app.sid');
        expect(H.sessionCookieName({ env: {}, cookieSecure: 'auto', tlsConfigured: true })).toBe(
            '__Host-app.sid'
        );
        expect(H.sessionCookieName({ env: {}, cookieSecure: 'auto' })).toBe('app.sid');
        expect(H.sessionCookieName({ env: {}, cookieSecure: false })).toBe('app.sid');
        expect(
            H.sessionCookieName({ env: { SESSION_COOKIE_NAME: 'x.sid' }, cookieSecure: true })
        ).toBe('x.sid');
    });

    function bridgeApp(secure) {
        const app = express();
        app.use((req, res, next) => {
            Object.defineProperty(req, 'secure', { value: secure });
            next();
        });
        app.use(H.legacyCookieBridge('__Host-app.sid'));
        app.get('/', (req, res) => res.json({ cookie: req.headers.cookie || '' }));
        return app;
    }
    test('an app.sid session is carried over the rename (HTTPS) and the old cookie expired', async () => {
        const r = await request(bridgeApp(true)).get('/').set('Cookie', 'app.sid=s%3Aabc.sig');
        expect(r.body.cookie).toMatch(/__Host-app\.sid=s%3Aabc\.sig/);
        expect(String(r.headers['set-cookie'] || '')).toMatch(/app\.sid=;/);
    });
    test('no bridge once the new cookie exists, nor on plain HTTP', async () => {
        const r1 = await request(bridgeApp(true))
            .get('/')
            .set('Cookie', 'app.sid=old; __Host-app.sid=new');
        expect(r1.body.cookie).toBe('app.sid=old; __Host-app.sid=new');
        const r2 = await request(bridgeApp(false)).get('/').set('Cookie', 'app.sid=old');
        expect(r2.body.cookie).toBe('app.sid=old');
    });
    test('server.js mounts the bridge and the alias before the session', () => {
        const bridge = SERVER.indexOf('httpHardening.legacyCookieBridge(SESSION_COOKIE_NAME)');
        const alias = SERVER.indexOf('httpHardening.sessionCookieAlias(READER_COOKIE_NAME');
        const sess = SERVER.indexOf('name: SESSION_COOKIE_NAME');
        expect(bridge).toBeGreaterThan(-1);
        expect(alias).toBeGreaterThan(-1);
        expect(bridge).toBeLessThan(sess);
        expect(alias).toBeLessThan(sess);
    });
});

describe('logout', () => {
    test('Clear-Site-Data and the real cookie name are cleared', async () => {
        const app = express();
        app.use(H.sessionCookieAlias('app.sid', '__Host-app.sid'));
        app.post('/logout', H.logoutHardening(), (req, res) => {
            // What AuthController.logout does (it computes the reader name).
            res.clearCookie(process.env.SESSION_COOKIE_NAME || 'app.sid');
            res.redirect('/login?loggedout=1');
        });
        app.get('/idle', (req, res) => {
            res.clearCookie('app.sid');
            res.send('x');
        });
        const r = await request(app).post('/logout');
        expect(r.headers['clear-site-data']).toBe('"cache"'); // never "storage": offline drafts
        const sc = (r.headers['set-cookie'] || []).join('\n');
        expect(sc).toMatch(/__Host-app\.sid=;[^\n]*Path=\//);
        expect(sc).toMatch(/__Host-app\.sid=;[^\n]*Secure/);
        // Any other clearCookie of the reader name (sessionActivity idle sign-out).
        const i = await request(app).get('/idle');
        expect((i.headers['set-cookie'] || []).join('\n')).toMatch(/__Host-app\.sid=;/);
        expect(i.headers['clear-site-data']).toBeUndefined();
    });
    test('server.js mounts the logout hardening before the routes', () => {
        const l = SERVER.indexOf("app.post('/logout', httpHardening.logoutHardening())");
        expect(l).toBeGreaterThan(-1);
        expect(l).toBeLessThan(SERVER.indexOf("app.use('/', routes)"));
    });
});

describe('health probes', () => {
    const db = { get: jest.fn(async () => ({ ok: 1 })) };
    function probeApp(allowed) {
        const app = express();
        const detailsAllowed = () => allowed;
        app.get(
            '/health',
            H.healthHandler({ startedAt: Date.now(), detailsAllowed, serviceName: 'Svc' })
        );
        app.get('/readyz', H.readyHandler({ db, startedAt: Date.now(), detailsAllowed }));
        return app;
    }
    test('ungated caller: status only', async () => {
        const h = await request(probeApp(false)).get('/health');
        expect(h.status).toBe(200);
        expect(h.body).toEqual({ status: 'ok' });
        const r = await request(probeApp(false)).get('/readyz');
        expect(r.body).toEqual({ status: 'ready' });
    });
    test('gated caller: details', async () => {
        const h = await request(probeApp(true)).get('/health');
        expect(h.body.service).toBe('Svc');
        expect(h.body).toHaveProperty('uptimeSec');
        expect(h.body).toHaveProperty('ts');
    });
    test('the default service name is the product name', async () => {
        const app = express();
        app.get('/h', H.healthHandler({ startedAt: Date.now(), detailsAllowed: () => true }));
        const h = await request(app).get('/h');
        expect(h.body.service).toBe(require('../../src/config/product').name);
    });
    test('db down: 503 with status only when ungated', async () => {
        db.get.mockRejectedValueOnce(new Error('ECONNREFUSED 10.0.0.9:5432'));
        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const r = await request(probeApp(false)).get('/readyz');
        spy.mockRestore();
        expect(r.status).toBe(503);
        expect(r.body).toEqual({ status: 'degraded' });
    });
});

describe('request trail sink', () => {
    test('successful mutations are not system_logs events; 401/403/5xx are', () => {
        expect(H.requestAuditSink(200)).toBeNull();
        expect(H.requestAuditSink(302)).toBeNull();
        expect(H.requestAuditSink(201)).toBeNull();
        expect(H.requestAuditSink(400)).toBeNull();
        expect(H.requestAuditSink(401)).toBe('system');
        expect(H.requestAuditSink(403)).toBe('system');
        expect(H.requestAuditSink(500)).toBe('system');
        expect(H.requestAuditSink(503)).toBe('system');
    });
    test('server.js consults it and no longer writes HTTP_<method> rows', () => {
        expect(SERVER).toMatch(/httpHardening\.requestAuditSink\(sc\) !== 'system'/);
        expect(SERVER).not.toMatch(/`HTTP_\$\{m\}`/);
    });
});

describe('/metrics allow-list', () => {
    const apiAuth = require('../../src/middleware/apiAuth');
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
            apiAuth.metricsAccessAllowed(req('10.0.0.7', { 'x-forwarded-for': '192.0.2.4' }))
        ).toBe(false);
    });
    test('no list: loopback only', () => {
        delete process.env.METRICS_ALLOW_IPS;
        expect(apiAuth.metricsAccessAllowed(req('127.0.0.1'))).toBe(true);
        expect(apiAuth.metricsAccessAllowed(req('10.0.0.7'))).toBe(false);
    });
});
