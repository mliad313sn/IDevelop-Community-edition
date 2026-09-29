'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';
process.env.LOGIN_RATE_LIMIT = '5';
process.env.LOGIN_RATE_WINDOW = '15';
delete process.env.ACCOUNT_REAUTH_LIMIT;
delete process.env.ACCOUNT_REAUTH_WINDOW;
delete process.env.REDIS_URL;

/**
 * 3.23.18 lane O-ops2 — POST /account had no rate limit. Changing one's own
 * e-mail requires the current password, so the route was an unlimited password
 * oracle for anyone holding a session. The dedicated limiter:
 *   - allows 10 REFUSED posts per user per 15 min, then refuses without reaching
 *     the controller;
 *   - does not count successful saves (both outcomes are a 302 → it reads the
 *     error flash queued during the request);
 *   - is per user and shares NO state with the login limiter.
 * Driven over real HTTP with the real limiter; the controller is a stub that
 * behaves like AuthController.updateProfile (flash error + 302 on refusal).
 */
jest.mock('../../src/config/database', () => ({
    get: jest.fn(async () => null),
    all: jest.fn(async () => []),
    run: jest.fn(async () => ({ changes: 0 })),
}));
jest.mock('../../src/services/LogService', () => ({ log: jest.fn(() => Promise.resolve()) }));

const http = require('http');
const express = require('express');
const LogService = require('../../src/services/LogService');
const { accountReauthLimiter, loginRateLimiter } = require('../../src/middleware/rateLimiter');

function buildApp(calls) {
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.urlencoded({ extended: false }));
    const sessions = new Map();
    app.use((req, res, next) => {
        const user = req.get('x-user') || 'anon';
        if (!sessions.has(user)) sessions.set(user, { passport: {} });
        req.session = sessions.get(user);
        // connect-flash's storage shape: session.flash[type] = [msgs]
        req.flash = (type, msg) => {
            req.session.flash = req.session.flash || {};
            (req.session.flash[type] = req.session.flash[type] || []).push(msg);
        };
        if (user !== 'anon') req.user = { userType: 'employee', id: Number(user) };
        next();
    });
    app.post('/account', accountReauthLimiter, (req, res) => {
        calls.push(req.get('x-user'));
        if (req.body.currentPassword !== 'right') {
            req.flash('error', 'Mot de passe actuel incorrect.');
            return res.redirect('/account');
        }
        return res.redirect('/account');
    });
    app.post('/login', loginRateLimiter, (req, res) => res.redirect('/login'));
    return app;
}

function post(port, p, user, body, ip = '203.0.113.90') {
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                host: '127.0.0.1',
                port,
                path: p,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(body),
                    'X-Forwarded-For': ip,
                    ...(user ? { 'X-User': user } : {}),
                },
            },
            (res) => {
                res.resume();
                res.on('end', () =>
                    resolve({
                        status: res.statusCode,
                        remaining: Number(res.headers['ratelimit-remaining']),
                        location: res.headers.location,
                    })
                );
            }
        );
        req.on('error', reject);
        req.end(body);
    });
}

async function withServer(fn) {
    const calls = [];
    const server = http.createServer(buildApp(calls));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
        return await fn(server.address().port, calls);
    } finally {
        await new Promise((r) => server.close(r));
    }
}

const WRONG = 'email=new%40x.example&currentPassword=guess';
const RIGHT = 'email=new%40x.example&currentPassword=right';

describe('POST /account re-authentication limiter', () => {
    test('the route mounts it after requireAuth (so the key is the signed-in user)', () => {
        const src = require('fs').readFileSync(
            require('path').join(__dirname, '../../src/routes/index.js'),
            'utf8'
        );
        expect(src).toMatch(
            /router\.post\(\s*'\/account',\s*requireAuth,\s*require\('\.\.\/middleware\/rateLimiter'\)\.accountReauthLimiter,/
        );
    });

    test('10 refused re-authentications, then the 11th never reaches the controller', async () => {
        await withServer(async (port, calls) => {
            const out = [];
            for (let i = 0; i < 11; i++) out.push(await post(port, '/account', '101', WRONG));
            expect(calls.length).toBe(10);
            expect(out.slice(0, 10).map((r) => r.remaining)).toEqual([
                9, 8, 7, 6, 5, 4, 3, 2, 1, 0,
            ]);
            expect(out[10].status).toBe(302);
            expect(out[10].location).toBe('/account');
            expect(LogService.log).toHaveBeenCalledWith(
                expect.objectContaining({ action: 'ACCOUNT_REAUTH_RATE_LIMITED' })
            );
            // Even the RIGHT password is refused while the window is exhausted.
            await post(port, '/account', '101', RIGHT);
            expect(calls.length).toBe(10);
        });
    });

    test('successful saves cost nothing (even with an unread error flash in the session)', async () => {
        await withServer(async (port, calls) => {
            await post(port, '/account', '202', WRONG); // leaves an unread error flash behind
            const out = [];
            for (let i = 0; i < 15; i++) out.push(await post(port, '/account', '202', RIGHT));
            expect(calls.length).toBe(16);
            // The header is computed before the success is refunded: 1 refusal on
            // file + this request = 8, and it stays 8 — nothing accumulates.
            expect(out.map((r) => r.remaining)).toEqual(new Array(15).fill(8));
            const next = await post(port, '/account', '202', WRONG);
            expect(next.remaining).toBe(8);
        });
    });

    test('per user: one exhausted account does not block a colleague on the same IP', async () => {
        await withServer(async (port, calls) => {
            for (let i = 0; i < 11; i++) await post(port, '/account', '303', WRONG);
            const other = await post(port, '/account', '304', WRONG);
            expect(other.remaining).toBe(9);
            expect(calls.filter((u) => u === '304').length).toBe(1);
        });
    });

    test('shares no state with the login limiter (either direction)', async () => {
        await withServer(async (port, calls) => {
            const ip = '203.0.113.91';
            for (let i = 0; i < 6; i++)
                await post(port, '/login', null, 'username=x&password=y', ip);
            const acct = await post(port, '/account', '404', WRONG, ip);
            expect(acct.remaining).toBe(9);
            expect(calls).toEqual(['404']);
            for (let i = 0; i < 11; i++) await post(port, '/account', '405', WRONG, '203.0.113.92');
            const login = await post(port, '/login', null, 'username=x&password=y', '203.0.113.92');
            expect(login.remaining).toBe(4);
        });
    });
});
