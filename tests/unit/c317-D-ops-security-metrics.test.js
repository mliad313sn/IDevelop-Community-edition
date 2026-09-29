'use strict';
/**
 * 3.23.17 lane D — S-11: GET /metrics answered anyone (process memory, request
 * counters). Now: loopback peer without forwarding headers, or a Bearer
 * METRICS_TOKEN. Driven through a real express app on a real socket, plus the
 * predicate with a non-loopback peer (which a unit test cannot open for real).
 */
jest.mock('../../src/config/sso', () => ({
    looksLikeJwt: () => false,
    isEntraBearerEnabled: () => false,
    authenticateEntraBearer: async () => null,
}));
jest.mock('../../src/services/ApiKeyService', () => ({ validate: jest.fn(async () => null) }));
jest.mock('../../src/models/AdminModel', () => ({ findWithScopes: jest.fn() }));

const http = require('http');
const express = require('express');
const { requireMetricsAccess, metricsAccessAllowed } = require('../../src/middleware/apiAuth');

const TOKEN = 'metrics-token-7f3a9c1e5b2d4f6a8c0e';
let savedToken;
beforeEach(() => {
    savedToken = process.env.METRICS_TOKEN;
    delete process.env.METRICS_TOKEN;
});
afterEach(() => {
    if (savedToken === undefined) delete process.env.METRICS_TOKEN;
    else process.env.METRICS_TOKEN = savedToken;
});

function get(port, headers = {}) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/metrics', headers }, (res) => {
            let body = '';
            res.on('data', (c) => {
                body += c;
            });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        }).on('error', reject);
    });
}

describe('/metrics over a real socket (loopback)', () => {
    let server, port;
    beforeAll(async () => {
        const app = express();
        app.get('/metrics', requireMetricsAccess, (req, res) =>
            res.type('text/plain').send('app_up 1\n')
        );
        await new Promise((r) => {
            server = app.listen(0, '127.0.0.1', r);
        });
        port = server.address().port;
    });
    afterAll(() => new Promise((r) => server.close(r)));

    test('a direct loopback scrape is served', async () => {
        const r = await get(port);
        expect(r.status).toBe(200);
        expect(r.body).toMatch(/app_up 1/);
    });

    test('a request relayed by a local reverse proxy (X-Forwarded-For) is refused', async () => {
        const r = await get(port, { 'X-Forwarded-For': '203.0.113.9' });
        expect(r.status).toBe(403);
        expect(r.body).not.toMatch(/app_up/);
    });

    test('with METRICS_TOKEN, the proxied request passes only with the right Bearer', async () => {
        process.env.METRICS_TOKEN = TOKEN;
        expect(
            (
                await get(port, {
                    'X-Forwarded-For': '203.0.113.9',
                    Authorization: `Bearer ${TOKEN}`,
                })
            ).status
        ).toBe(200);
        expect(
            (await get(port, { 'X-Forwarded-For': '203.0.113.9', Authorization: 'Bearer nope' }))
                .status
        ).toBe(403);
    });
});

describe('metricsAccessAllowed — remote peers', () => {
    const req = (addr, headers = {}) => ({ socket: { remoteAddress: addr }, headers });

    test('a LAN / internet peer is refused without a token', () => {
        expect(metricsAccessAllowed(req('10.0.0.5'))).toBe(false);
        expect(metricsAccessAllowed(req('::ffff:192.168.1.20'))).toBe(false);
    });

    test('IPv4, IPv6 and v4-mapped loopback are accepted', () => {
        ['127.0.0.1', '::1', '::ffff:127.0.0.1'].forEach((a) =>
            expect(metricsAccessAllowed(req(a))).toBe(true)
        );
    });

    test('a remote peer with the right Bearer METRICS_TOKEN is accepted; wrong/absent is not', () => {
        process.env.METRICS_TOKEN = TOKEN;
        expect(metricsAccessAllowed(req('10.0.0.5', { authorization: `Bearer ${TOKEN}` }))).toBe(
            true
        );
        expect(metricsAccessAllowed(req('10.0.0.5', { authorization: `Bearer ${TOKEN}x` }))).toBe(
            false
        );
        expect(metricsAccessAllowed(req('10.0.0.5', { authorization: TOKEN }))).toBe(false);
        expect(metricsAccessAllowed(req('10.0.0.5'))).toBe(false);
    });

    test('a Bearer is worthless when METRICS_TOKEN is unset (no empty-token match)', () => {
        expect(metricsAccessAllowed(req('10.0.0.5', { authorization: 'Bearer ' }))).toBe(false);
        expect(metricsAccessAllowed(req('10.0.0.5', { authorization: 'Bearer x' }))).toBe(false);
    });
});
