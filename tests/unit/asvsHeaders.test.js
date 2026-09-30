'use strict';
/**
 * ASVS 4.0.3 V8.1 / V13.1.5 / V14.3-14.4 on the REAL middleware chain of
 * server.js (tests/helpers/c318/buildApp.js compiles it without booting):
 *
 *  - security headers on every response: Permissions-Policy denying device
 *    APIs, COOP/CORP same-origin, nosniff, Referrer-Policy, no X-Powered-By;
 *  - Cache-Control: no-store on dynamic HTML and JSON, while static assets
 *    stay cacheable;
 *  - JSON-only APIs (/api/v1, /scim/v2) answer 415 to a non-JSON body;
 *  - an uploaded SVG logo is served under a sandboxing CSP.
 */
process.env.ACTIVITY_TRAIL = '0';
require('dotenv').config();

jest.mock('../../src/config/sessionStore', () => require('../helpers/c318/sessionStoreMock'));
jest.mock('../../src/services/LogService', () => {
    const real = jest.requireActual('../../src/services/LogService');
    real.log = async () => null;
    return real;
});
jest.mock('../../src/services/PerfEventService', () => {
    const real = jest.requireActual('../../src/services/PerfEventService');
    real.record = () => null;
    return real;
});
jest.mock('../../src/utils/branding', () => {
    const real = jest.requireActual('../../src/utils/branding');
    return {
        ...real,
        getAssetDataUrl: async () =>
            'data:image/svg+xml;base64,' +
            Buffer.from(
                '<svg xmlns="http://www.w3.org/2000/svg"><animate onbegin="alert(1)"/></svg>'
            ).toString('base64'),
    };
});

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { loadApp } = require('../helpers/c318/buildApp');
const { isJsonContentType } = require('../../src/middleware/jsonContentType');

jest.setTimeout(60000);

let app;
let db;
beforeAll(async () => {
    db = require('../../src/config/database');
    await db.connect();
    app = loadApp();
});
afterAll(async () => {
    try {
        await db.close();
    } catch (_) {
        /* closed */
    }
});

function expectSecurityHeaders(res) {
    const pp = res.headers['permissions-policy'] || '';
    for (const f of ['camera', 'microphone', 'geolocation', 'payment', 'usb', 'serial', 'hid'])
        expect([f, pp.includes(`${f}=()`)]).toEqual([f, true]);
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['content-security-policy']).toMatch(/frame-ancestors 'self'/);
}

describe('security headers (ASVS 14.3.3, 14.4)', () => {
    test('JSON probe', async () => {
        const res = await request(app).get('/health');
        expect(res.status).toBe(200);
        expectSecurityHeaders(res);
    });

    test('404 page', async () => {
        const res = await request(app).get('/no-such-page-asvs');
        expectSecurityHeaders(res);
    });

    test('static asset', async () => {
        const css = fs.readdirSync(path.join(__dirname, '../../public/css'))[0];
        const res = await request(app).get('/css/' + css);
        expect(res.status).toBe(200);
        expectSecurityHeaders(res);
    });
});

describe('caching (ASVS 8.1.1, 8.2.1)', () => {
    test('dynamic responses behind the session are no-store', async () => {
        const res = await request(app).get('/no-such-page-asvs');
        expect(res.headers['cache-control']).toMatch(/no-store/);
        const api = await request(app).get('/api/v1/employees').set('Accept', 'application/json');
        expect(api.headers['cache-control']).toMatch(/no-store/);
    });

    test('static assets stay cacheable', async () => {
        const css = fs.readdirSync(path.join(__dirname, '../../public/css'))[0];
        const res = await request(app).get('/css/' + css);
        expect(res.headers['cache-control'] || '').not.toMatch(/no-store/);
    });
});

describe('JSON-only APIs refuse other bodies (ASVS 13.1.5)', () => {
    test.each([
        ['/api/v1/admin/api-keys', 'text/plain', 'label=x'],
        ['/api/v1/admin/api-keys', 'application/x-www-form-urlencoded', 'label=x'],
        ['/scim/v2/Users', 'application/xml', '<user/>'],
    ])('POST %s as %s → 415', async (url, type, body) => {
        const res = await request(app).post(url).set('Content-Type', type).send(body);
        expect(res.status).toBe(415);
        expect(res.body.error).toBe('unsupported_media_type');
    });

    test('a JSON body goes on to authentication (not 415)', async () => {
        const res = await request(app)
            .post('/scim/v2/Users')
            .set('Content-Type', 'application/scim+json')
            .send(JSON.stringify({ userName: 'x' }));
        expect(res.status).not.toBe(415);
    });

    test('a bodyless call is not affected', async () => {
        const res = await request(app).delete('/api/v1/admin/api-keys/1');
        expect(res.status).not.toBe(415);
    });

    test('media-type matching', () => {
        expect(isJsonContentType('application/json; charset=utf-8')).toBe(true);
        expect(isJsonContentType('application/scim+json')).toBe(true);
        expect(isJsonContentType('text/plain')).toBe(false);
        expect(isJsonContentType('application/jsonp')).toBe(false);
        expect(isJsonContentType('')).toBe(false);
    });
});

describe('uploaded SVG logo (ASVS 5.2.7, 12.5.2)', () => {
    test('is served under a sandboxing CSP with no script', async () => {
        // The asset route sits behind the sign-in gate: use a minted session.
        const { mintSession } = require('../helpers/c318/buildApp');
        const store = require('../helpers/c318/sessionStoreMock').state.store;
        const row = await db.get(
            'SELECT id FROM employees WHERE is_active = true ORDER BY id LIMIT 1'
        );
        const cookie = await mintSession(store, { id: row.id, userType: 'employee' }, 'asvs');
        const res = await request(app).get('/branding/logo').set('Cookie', cookie);
        expect(res.status).toBe(200);
        const csp = res.headers['content-security-policy'];
        expect(csp).toMatch(/default-src 'none'/);
        expect(csp).toMatch(/sandbox/);
        expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
        expect(csp).not.toMatch(/script-src-attr/);
    });
});
