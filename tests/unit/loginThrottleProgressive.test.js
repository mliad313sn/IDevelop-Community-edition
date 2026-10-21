'use strict';

/**
 * Pre-authentication throttle (per endpoint, per (IP, identifier), progressive,
 * NAT-friendly IP ceiling) and the /api limiter that never gives an unvalidated
 * key its own bucket. Driven over real HTTP with the real middleware.
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';
process.env.LOGIN_RATE_LIMIT = '5';
process.env.LOGIN_RATE_WINDOW = '15';
process.env.LOGIN_IP_CEILING = '12';
process.env.API_IP_RATE_LIMIT = '5';
process.env.API_RATE_LIMIT = '3';
delete process.env.REDIS_URL;

jest.mock('../../src/config/database', () => ({
    get: jest.fn(async () => null),
    all: jest.fn(async () => []),
    run: jest.fn(async () => ({ changes: 0 })),
}));
jest.mock('../../src/services/LogService', () => ({ log: jest.fn(() => Promise.resolve()) }));
jest.mock('../../src/services/AdminSsoService', () => ({ isEnforced: () => false }));
const mockValidate = jest.fn(async (raw) =>
    raw === 'good-key' ? { id: 42, label: 'pbi', scope: 'powerbi.read', ownerAdminId: null } : null
);
jest.mock('../../src/services/ApiKeyService', () => ({ validate: (r) => mockValidate(r) }));

const http = require('http');
const express = require('express');
const rl = require('../../src/middleware/rateLimiter');

function buildApp() {
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.urlencoded({ extended: false }));
    app.use((req, res, next) => {
        req.session = { passport: {} };
        req.flash = () => {};
        next();
    });
    const fail = (to) => (req, res) => res.redirect(to);
    app.post('/login', rl.loginRateLimiter, fail('/login'));
    app.post('/forgot-password', rl.loginRateLimiter, fail('/login'));
    app.use('/api/', rl.apiRateLimiter);
    app.get('/api/x', (req, res) => res.json({ ok: true }));
    return app;
}

let server;
let port;
beforeAll(async () => {
    server = http.createServer(buildApp());
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
});
afterAll(() => new Promise((r) => server.close(r)));
beforeEach(() => rl._resetThrottlesForTests());

function send(method, p, { ip, body = '', headers = {} }) {
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                host: '127.0.0.1',
                port,
                path: p,
                method,
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(body),
                    'X-Forwarded-For': ip,
                    ...headers,
                },
            },
            (res) => {
                res.resume();
                res.on('end', () =>
                    resolve({
                        status: res.statusCode,
                        retryAfter: res.headers['retry-after'],
                        remaining: Number(res.headers['ratelimit-remaining']),
                    })
                );
            }
        );
        req.on('error', reject);
        req.end(body);
    });
}
const login = (ip, user) => send('POST', '/login', { ip, body: `username=${user}&password=x` });

describe('per (IP, identifier), progressive, per endpoint', () => {
    test('5 free failures, then the next attempt must wait (Retry-After), capped at 15 min', async () => {
        const out = [];
        for (let i = 0; i < 6; i++) out.push(await login('198.51.100.1', 'victim'));
        expect(out.slice(0, 5).every((r) => !r.retryAfter)).toBe(true);
        expect(Number(out[5].retryAfter)).toBeGreaterThan(0);
        expect(rl.throttleDelayMs(4)).toBe(0);
        expect(rl.throttleDelayMs(5)).toBe(2000);
        expect(rl.throttleDelayMs(6)).toBe(4000);
        expect(rl.throttleDelayMs(40)).toBe(15 * 60 * 1000);
    });

    test('colleagues behind the same NAT address are not blocked by one person’s typos', async () => {
        for (let i = 0; i < 7; i++) await login('198.51.100.2', 'clumsy');
        const other = await login('198.51.100.2', 'colleague');
        expect(other.retryAfter).toBeUndefined();
        expect(other.remaining).toBe(4);
    });

    test('endpoints never share counters (/forgot-password vs /login)', async () => {
        for (let i = 0; i < 7; i++)
            await send('POST', '/forgot-password', {
                ip: '198.51.100.3',
                body: 'identifier=victim',
            });
        const l = await login('198.51.100.3', 'victim');
        expect(l.retryAfter).toBeUndefined();
        expect(l.remaining).toBe(4);
    });

    test('per-IP ceiling (LOGIN_IP_CEILING) for spraying many names from one address', async () => {
        let firstRefused = null;
        for (let i = 1; i <= 14; i++) {
            const r = await login('198.51.100.4', `name${i}`);
            if (r.retryAfter && firstRefused === null) firstRefused = i;
        }
        expect(firstRefused).toBe(13); // 12 failures allowed, the 13th is throttled
    });
});

describe('/api: IP bucket always, per-key bucket only for a VALID key', () => {
    test('random junk keys all drain the SAME IP bucket (no bucket per raw key)', async () => {
        const out = [];
        for (let i = 0; i < 6; i++)
            out.push(
                await send('GET', '/api/x', {
                    ip: '203.0.113.50',
                    headers: { 'X-API-Key': `junk-${i}-${Math.random()}` },
                })
            );
        expect(out.slice(0, 5).map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
        expect(out[5].status).toBe(429);
    });

    test('a valid key also gets its own (second) bucket, after validation', async () => {
        const out = [];
        for (let i = 0; i < 4; i++)
            out.push(
                await send('GET', '/api/x', {
                    ip: `203.0.113.${60 + i}`, // different IPs: only the key bucket is shared
                    headers: { 'X-API-Key': 'good-key' },
                })
            );
        expect(out.map((r) => r.status)).toEqual([200, 200, 200, 429]); // API_RATE_LIMIT = 3
        expect(mockValidate).toHaveBeenCalledWith('good-key');
    });
});
