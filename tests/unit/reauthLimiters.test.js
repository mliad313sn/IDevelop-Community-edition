'use strict';

/**
 * The authenticated secret checks are rate-limited per
 * user: POST /change-password (passwordReauthLimiter) and POST /v2/uam/mfa/verify
 * + /mfa/disable (mfaReauthLimiter). Only refused posts count. Real limiter,
 * real HTTP; the v2-uam router is mounted for real with MfaService mocked.
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';
delete process.env.ACCOUNT_REAUTH_LIMIT;
delete process.env.ACCOUNT_REAUTH_WINDOW;
delete process.env.REDIS_URL;

jest.mock('../../src/config/database', () => ({
    get: jest.fn(async () => null),
    all: jest.fn(async () => []),
    run: jest.fn(async () => ({ changes: 0 })),
}));
jest.mock('../../src/services/LogService', () => ({ log: jest.fn(() => Promise.resolve()) }));
const mockMfa = {
    mfaUserType: () => 'employee',
    verifyAndConfirm: jest.fn(async () => false),
    verifyAtLogin: jest.fn(async () => false),
    consumeBackupCode: jest.fn(async () => false),
    isPrivileged: () => false,
};
jest.mock('../../src/services/MfaService', () => mockMfa);
jest.mock('../../src/services/AdminSsoService', () => ({ isActiveSuperadmin: () => false }));
jest.mock('../../src/middleware/auth', () => ({
    requireAuth: (req, res, next) => next(),
    requireSuperAdmin: (req, res, next) => next(),
}));

const http = require('http');
const express = require('express');
const rl = require('../../src/middleware/rateLimiter');

function buildApp(calls) {
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.urlencoded({ extended: false }));
    const sessions = new Map();
    app.use((req, res, next) => {
        const user = req.get('x-user');
        if (!sessions.has(user)) sessions.set(user, { passport: {} });
        req.session = sessions.get(user);
        req.flash = (type, msg) => {
            req.session.flash = req.session.flash || {};
            (req.session.flash[type] = req.session.flash[type] || []).push(msg);
        };
        req.user = { userType: 'manager', id: Number(user), username: `u${user}` };
        next();
    });
    app.post('/change-password', rl.passwordReauthLimiter, (req, res) => {
        calls.push('pw');
        req.flash('error', 'Le mot de passe actuel est incorrect.');
        res.redirect('/change-password');
    });
    // A new-password rule refusal happens before the current password is read: the
    // controller marks it, and it must not use up the budget (verification V1 #2).
    app.post('/change-password-policy', rl.passwordReauthLimiter, (req, res) => {
        calls.push('policy');
        req._reauthNotAGuess = true;
        req.flash('error', 'Mot de passe trop courant.');
        res.redirect('/change-password');
    });
    app.use('/v2/uam', require('../../src/routes/v2-uam'));
    return app;
}

function post(port, p, user) {
    return new Promise((resolve, reject) => {
        const body = 'code=000000';
        const r = http.request(
            {
                host: '127.0.0.1',
                port,
                path: p,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(body),
                    'X-User': String(user),
                },
            },
            (res) => {
                res.resume();
                res.on('end', () =>
                    resolve({ status: res.statusCode, location: res.headers.location })
                );
            }
        );
        r.on('error', reject);
        r.end(body);
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

test('/change-password: 10 refused current-password checks, the 11th never reaches the controller', async () => {
    await withServer(async (port, calls) => {
        for (let i = 0; i < 11; i++) await post(port, '/change-password', 501);
        expect(calls.length).toBe(10);
    });
});

test('/change-password: new-password rule refusals never burn the budget', async () => {
    await withServer(async (port, calls) => {
        for (let i = 0; i < 15; i++) await post(port, '/change-password-policy', 502);
        expect(calls.length).toBe(15);
    });
});

test('/v2/uam/mfa/verify and /mfa/disable share one per-user budget of refused codes', async () => {
    await withServer(async (port) => {
        for (let i = 0; i < 6; i++) await post(port, '/v2/uam/mfa/verify', 601);
        for (let i = 0; i < 4; i++) await post(port, '/v2/uam/mfa/disable', 601);
        const before = mockMfa.verifyAtLogin.mock.calls.length;
        const r = await post(port, '/v2/uam/mfa/disable', 601);
        expect(mockMfa.verifyAtLogin.mock.calls.length).toBe(before); // refused before the check
        expect(r.location).toBe('/v2/uam/mfa/manage');
        // another user is unaffected
        const before2 = mockMfa.verifyAndConfirm.mock.calls.length;
        await post(port, '/v2/uam/mfa/verify', 602);
        expect(mockMfa.verifyAndConfirm.mock.calls.length).toBe(before2 + 1);
    });
});
