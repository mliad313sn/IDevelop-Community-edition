'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';
process.env.LOGIN_RATE_LIMIT = '5';
process.env.LOGIN_RATE_WINDOW = '15';

/**
 * AMDEC L5-1 (criticality 600) — the brute-force limiter never counted a failure.
 *
 * `loginRateLimiter` sets `skipSuccessfulRequests: true`, and express-rate-limit
 * decides "successful" with its default predicate `statusCode < 400`. A failed
 * login answers `res.redirect('/login')` — a 302 — so every failure was classified
 * a success and decremented straight back out of the window. The limiter guarded
 * nothing on /login, /login/mfa, /forgot-password or /reset-password.
 *
 * Reproduced before the fix: 12 consecutive bad passwords from one IP, never
 * refused. On /login/mfa that was the ONLY network-level cap on guessing a 6-digit
 * TOTP code, and on /forgot-password it let a third party have unlimited reset mail
 * sent to a victim.
 *
 * Scoring rationale: G=6, O=10 (the predicate is wrong on every single request),
 * D=10 (a limiter that is present, configured and mounted, and simply never fires —
 * nothing observable says so).
 *
 * This test drives the REAL limiter over HTTP rather than asserting on source,
 * because the defect lived in the interaction between two correct-looking options.
 * The window is never exhausted here, so the audit handler is not invoked and the
 * test needs no database.
 */

const http = require('http');
const express = require('express');
const { loginRateLimiter } = require('../../src/middleware/rateLimiter');

function buildApp(succeed) {
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.urlencoded({ extended: false }));
    app.use((req, res, next) => {
        req.session = { passport: {} };
        req.flash = () => {};
        next();
    });
    app.post('/login', loginRateLimiter, (req, res) => {
        if (succeed) {
            // Exactly what a real successful login leaves behind before redirecting.
            req.session.passport.user = 'admin:1';
            return res.redirect('/dashboard');
        }
        return res.redirect('/login'); // the real failure branch — a 302, not a 4xx
    });
    return app;
}

function post(port, ip) {
    return new Promise((resolve, reject) => {
        const body = 'username=victim&password=wrong';
        const req = http.request(
            {
                host: '127.0.0.1',
                port,
                path: '/login',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(body),
                    'X-Forwarded-For': ip,
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

async function attempts(succeed, n, ip) {
    const server = http.createServer(buildApp(succeed));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const out = [];
    try {
        for (let i = 0; i < n; i++) out.push(await post(port, ip));
    } finally {
        await new Promise((r) => server.close(r));
    }
    return out;
}

describe('the login limiter counts what it is there to count', () => {
    test('a failed login consumes the budget', async () => {
        const res = await attempts(false, 4, '203.0.113.71');
        expect(res.map((r) => r.status)).toEqual([302, 302, 302, 302]);
        // The defect made this [4, 4, 4, 4]: every failure handed its slot back.
        expect(res.map((r) => r.remaining)).toEqual([4, 3, 2, 1]);
    });

    test('a successful login does not consume the budget', async () => {
        const res = await attempts(true, 4, '203.0.113.72');
        expect(res.every((r) => r.location === '/dashboard')).toBe(true);
        expect(res.map((r) => r.remaining)).toEqual([4, 4, 4, 4]);
    });

    test('the two are distinguished by the session, not by the HTTP status', async () => {
        // Both paths answer 302. If the predicate went back to reading the status,
        // these two expectations could not both hold.
        const bad = await attempts(false, 2, '203.0.113.73');
        const good = await attempts(true, 2, '203.0.113.74');
        expect(bad[0].status).toBe(good[0].status);
        expect(bad[1].remaining).toBeLessThan(good[1].remaining);
    });
});

describe('the predicate is explicit about why', () => {
    test('success is defined as an established session', () => {
        const src = require('../helpers/flatSource').flat(
            require('fs').readFileSync(
                require('path').join(__dirname, '../../src/middleware/rateLimiter.js'),
                'utf8'
            )
        );
        expect(src).toMatch(/requestWasSuccessful: \(req, res\) => res\.statusCode < 400/);
        expect(src).toMatch(/req\.session\.passport && req\.session\.passport\.user/);
    });
});
