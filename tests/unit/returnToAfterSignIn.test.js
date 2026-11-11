'use strict';
/**
 * Back to the requested page after sign-in, on the REAL
 * stack (express + express-session + passport 0.6 + the app's local strategy,
 * guards and AuthController.login / verifyMfaChallenge). Only the database-facing
 * models and settings are faked.
 *
 *   - an anonymous page navigation bounced by a guard is remembered, WITHOUT the
 *     red « Please log in » flash, and the password sign-in lands there — across
 *     passport's session regeneration, and across the MFA code step;
 *   - it is used once, and expires (15 min);
 *   - never anything but a same-origin relative path: « //evil.com », « /\evil »,
 *     an absolute URL, a scheme, /login|/logout|/auth|/api|static, over-long;
 *   - a fetch (JSON) is answered 401 and remembered nowhere; a POST keeps the flash.
 */
const mockHash = require('bcrypt').hashSync('right-password', 10);
const mockSettings = {};
const mockMfa = { active: false };
const mockEmp = {
    id: 41,
    username: 'deep.user',
    firstName: 'D',
    lastName: 'User',
    employeeNumber: 'E41',
    isActive: true,
    isAccountActive: true,
    passwordHash: mockHash,
    authPolicy: 'any',
};

jest.mock('../../src/config/database', () => ({
    get: jest.fn(async () => undefined),
    all: jest.fn(async () => []),
    run: jest.fn(async () => ({ changes: 1 })),
}));
jest.mock('../../src/services/LogService', () => ({ log: jest.fn(async () => {}) }));
jest.mock('../../src/services/SuperadminAlertService', () => ({ alert: jest.fn(async () => 1) }));
jest.mock('../../src/config/sso', () => ({
    isConfigured: () => false,
    isSsoIntended: () => false,
    getProvider: () => null,
    getEnabledProviders: () => [],
}));
jest.mock('../../src/services/MfaService', () => ({
    isActive: jest.fn(async () => mockMfa.active),
    mfaUserType: (u) => (u && u.userType === 'admin' ? 'admin' : 'employee'),
    verifyAtLogin: jest.fn(async ({ code }) => code === '123456'),
    consumeBackupCode: jest.fn(async () => false),
}));
jest.mock('../../src/models/AppSettingsModel', () => ({
    getValue: jest.fn(async (k, d) =>
        Object.prototype.hasOwnProperty.call(mockSettings, k) ? mockSettings[k] : d
    ),
}));
jest.mock('../../src/models/AdminModel', () => ({
    findByUsername: jest.fn(async () => null),
    findById: jest.fn(async () => null),
    findWithScopes: jest.fn(async () => null),
}));
jest.mock('../../src/models/EmployeeModel', () => ({
    findByUsername: jest.fn(async (u) => (u === 'deep.user' ? { ...mockEmp } : null)),
    findById: jest.fn(async (id) => (Number(id) === 41 ? { ...mockEmp } : null)),
    findByIdWithOrganization: jest.fn(async (id) => (Number(id) === 41 ? { ...mockEmp } : null)),
    governanceOf: jest.fn(async () => ({ governs: false, supervises: false, manages: false })),
    update: jest.fn(async () => ({})),
}));

const express = require('express');
const session = require('express-session');
const flash = require('../../src/middleware/flash');
const request = require('supertest');
const auth = require('../../src/middleware/auth');
const AuthController = require('../../src/controllers/AuthController');

const { passport, requireAuth, requireAdmin, requireEmployeeOrManager, safeReturnPath } = auth;
let clock = Date.parse('2026-10-03T08:00:00Z');

const { encodeReturnTo, RETURN_TO_COOKIE } = require('../../src/utils/returnTo');
let store;

function buildApp() {
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    store = new session.MemoryStore();
    app.use(session({ store, secret: 'return-to-test', resave: false, saveUninitialized: false }));
    app.use(flash());
    app.use(passport.initialize());
    app.use(passport.session());
    app.post('/login', AuthController.login);
    app.post('/login/mfa', AuthController.verifyMfaChallenge);
    app.get('/flash', (req, res) => res.json({ error: req.flash('error') }));
    app.get('/peek', (req, res) => res.json({ returnTo: auth.peekReturnTo(req) }));
    // A test-only door to plant a value in the return-to cookie (the path lives
    // in a signed cookie, never in the session). `signed=1` plants a value WE
    // signed (the path itself must still be refused); otherwise a forged,
    // unsigned one (never followed).
    app.get('/plant', (req, res) => {
        const p = String(req.query.p);
        const v =
            req.query.signed === '1'
                ? encodeReturnTo(p, Date.now())
                : `${Buffer.from(p).toString('base64url')}.${Date.now()}.forged`;
        res.cookie(RETURN_TO_COOKIE, v, { path: '/', httpOnly: true, sameSite: 'lax' });
        res.json({ ok: true });
    });
    // Stores something in the session (an established session, as a form page's
    // CSRF token would); a `returnTo` key there is never followed.
    app.get('/plant-session', (req, res) => {
        req.session.returnTo = { path: String(req.query.p), at: Date.now() };
        res.json({ ok: true });
    });
    app.get('/sessions', (req, res) => store.length((e, n) => res.json({ n: n || 0 })));
    app.get('/notifications/:id/go', requireAuth, (req, res) => res.json({ page: 'go' }));
    app.post('/notifications/:id/act', requireAuth, (req, res) => res.json({ page: 'act' }));
    app.get('/admin/thing', requireAdmin, (req, res) => res.json({ page: 'admin' }));
    app.get('/employee/x', requireEmployeeOrManager, (req, res) => res.json({ page: 'x' }));
    app.use(requireAuth, (req, res) => res.json({ page: 'any' }));
    return app;
}

const nav = (agent, path) =>
    agent.get(path).set('Sec-Fetch-Mode', 'navigate').set('Sec-Fetch-Dest', 'document');
const login = (agent) =>
    agent.post('/login').type('form').send({ username: 'deep.user', password: 'right-password' });

beforeEach(() => {
    for (const k of Object.keys(mockSettings)) delete mockSettings[k];
    mockMfa.active = false;
    clock = Date.parse('2026-10-03T08:00:00Z');
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('return-to — happy path', () => {
    test('anonymous navigation → /login with NO red flash → sign-in lands on the page', async () => {
        const agent = request.agent(buildApp());
        const r = await nav(agent, '/notifications/12/go?from=mail');
        expect(r.status).toBe(302);
        expect(r.headers.location).toBe('/login');
        expect((await agent.get('/flash')).body.error).toEqual([]);
        expect((await agent.get('/peek')).body.returnTo).toBe('/notifications/12/go?from=mail');
        const li = await login(agent);
        expect(li.headers.location).toBe('/notifications/12/go?from=mail');
        // the session was regenerated by passport: still signed in on the target
        expect((await nav(agent, '/notifications/12/go?from=mail')).body).toEqual({ page: 'go' });
    });

    test('used once: the next sign-in goes to the role home', async () => {
        const agent = request.agent(buildApp());
        await nav(agent, '/notifications/12/go');
        expect((await login(agent)).headers.location).toBe('/notifications/12/go');
        expect((await agent.get('/peek')).body.returnTo).toBeNull(); // consumed
        expect((await login(agent)).headers.location).toBe('/employee/dashboard');
    });

    test('through the MFA code step (a second regeneration)', async () => {
        mockMfa.active = true;
        const agent = request.agent(buildApp());
        await nav(agent, '/employee/x?tab=2');
        const r1 = await login(agent);
        expect(r1.headers.location).toBe('/login/mfa');
        const r2 = await agent.post('/login/mfa').type('form').send({ code: '123456' });
        expect(r2.headers.location).toBe('/employee/x?tab=2');
    });

    test('the other guards remember too (admin page, anonymous)', async () => {
        const agent = request.agent(buildApp());
        const r = await nav(agent, '/admin/thing');
        expect(r.headers.location).toBe('/login');
        expect((await agent.get('/flash')).body.error).toEqual([]);
        expect((await agent.get('/peek')).body.returnTo).toBe('/admin/thing');
    });

    test('expires after 15 minutes → role home', async () => {
        const agent = request.agent(buildApp());
        await nav(agent, '/notifications/12/go');
        clock += 16 * 60 * 1000;
        expect((await login(agent)).headers.location).toBe('/employee/dashboard');
    });
});

describe('return-to — never anything but a same-origin relative path', () => {
    test.each([
        '//evil.com',
        '//evil.com/x',
        '/\\evil.com',
        'https://evil.com/x',
        'http:/evil.com',
        'javascript:alert(1)',
        '/javascript:alert(1)',
        '/https://evil.com',
        'evil.com/x',
        '/login',
        '/login?next=/x',
        '/logout',
        '/auth/sso/entra',
        '/api/notifications',
        '/css/style.css',
        '/js/main.js',
        '/vendor/x.js',
        '/x\r\nSet-Cookie: a=b',
        `/${'a'.repeat(600)}`,
        '',
        null,
        42,
    ])('safeReturnPath(%p) → null', (p) => {
        expect(safeReturnPath(p)).toBeNull();
    });

    test.each(['/notifications/12/go', '/tasks?x=1#y', '/employee/dashboard', '/jsx', '/apiary'])(
        'safeReturnPath(%p) is kept',
        (p) => expect(safeReturnPath(p)).toBe(p)
    );

    test('a navigation to //evil.com is never remembered; sign-in lands home', async () => {
        const agent = request.agent(buildApp());
        const r = await nav(agent, '//evil.com/');
        expect(r.status).toBe(302);
        expect((await agent.get('/peek')).body.returnTo).toBeNull();
        expect((await login(agent)).headers.location).toBe('/employee/dashboard');
    });

    // The value lives in a signed cookie; a signed-but-unsafe path and an
    // unsigned value both fail.
    test.each(['https://evil.com/x', '//evil.com', '/\\evil.com'])(
        'a signed cookie value %p is not followed (path re-validated on read)',
        async (p) => {
            const agent = request.agent(buildApp());
            await agent.get(`/plant?signed=1&p=${encodeURIComponent(p)}`);
            const li = await login(agent);
            expect(li.headers.location).toBe('/employee/dashboard');
        }
    );

    test('an unsigned / tampered cookie is not followed, even to a safe path', async () => {
        const agent = request.agent(buildApp());
        await agent.get('/plant?p=%2Fnotifications%2F12%2Fgo');
        expect((await agent.get('/peek')).body.returnTo).toBeNull();
        expect((await login(agent)).headers.location).toBe('/employee/dashboard');
    });

    test('a correctly signed safe path IS followed (control for the two above)', async () => {
        const agent = request.agent(buildApp());
        await agent.get('/plant?signed=1&p=%2Fnotifications%2F12%2Fgo');
        expect((await login(agent)).headers.location).toBe('/notifications/12/go');
    });

    test('a returnTo kept in the session is never followed', async () => {
        const agent = request.agent(buildApp());
        await agent.get('/plant-session?p=%2Fnotifications%2F12%2Fgo');
        expect((await login(agent)).headers.location).toBe('/employee/dashboard');
    });
});

describe('anonymous navigations create no session', () => {
    test('15 anonymous navigations to protected URLs → 0 sessions; sign-in still lands on the deep link', async () => {
        const agent = request.agent(buildApp());
        for (let i = 0; i < 15; i++) {
            const r = await nav(agent, `/notifications/${i}/go`);
            expect(r.status).toBe(302);
            expect(r.headers.location).toBe('/login');
            const c = (r.headers['set-cookie'] || []).find((s) =>
                s.startsWith(`${RETURN_TO_COOKIE}=`)
            );
            expect(c).toMatch(/HttpOnly/i);
            expect(c).toMatch(/SameSite=Lax/i);
            expect(c).toMatch(/Max-Age=900/);
        }
        expect((await agent.get('/sessions')).body.n).toBe(0);
        const li = await login(agent);
        expect(li.headers.location).toBe('/notifications/14/go'); // the last one
        expect((li.headers['set-cookie'] || []).join(';')).toMatch(
            new RegExp(`${RETURN_TO_COOKIE}=;`)
        ); // consumed: cleared on the sign-in response
    });

    test('fresh browsers (no cookie jar) never create a session either', async () => {
        const app = buildApp();
        for (let i = 0; i < 15; i++) await nav(request(app), `/admin/thing?i=${i}`);
        await new Promise((r) => store.length((e, n) => r(expect(n || 0).toBe(0))));
    });
});

describe('return-to — what is NOT remembered', () => {
    test('a fetch (JSON) gets 401 and nothing is remembered', async () => {
        const agent = request.agent(buildApp());
        const r = await agent.get('/notifications/1/go').set('Accept', 'application/json');
        expect(r.status).toBe(401);
        expect((await agent.get('/peek')).body.returnTo).toBeNull();
    });

    test('a POST from an expired page keeps the error flash and is not remembered', async () => {
        const agent = request.agent(buildApp());
        // A flash is stored only in an ESTABLISHED session (a form page holds
        // its CSRF token there) — the stand-in here is any stored value. A
        // visitor with no session at all gets the redirect and no session
        // (asserted just below).
        await agent.get('/plant-session?p=x');
        const r = await agent.post('/notifications/1/act').type('form').send({});
        expect(r.headers.location).toBe('/login');
        expect((await agent.get('/flash')).body.error.length).toBe(1);
        expect((await agent.get('/peek')).body.returnTo).toBeNull();
    });

    test('the same POST with no session at all → /login, no flash, no session row', async () => {
        const agent = request.agent(buildApp());
        const r = await agent.post('/notifications/1/act').type('form').send({});
        expect(r.headers.location).toBe('/login');
        expect((await agent.get('/flash')).body.error).toEqual([]);
        expect((await agent.get('/sessions')).body.n).toBe(0);
    });

    test('an iframe / sub-resource load (Sec-Fetch-Dest ≠ document) is not remembered', async () => {
        const agent = request.agent(buildApp());
        await agent
            .get('/notifications/1/go')
            .set('Sec-Fetch-Mode', 'no-cors')
            .set('Sec-Fetch-Dest', 'image');
        expect((await agent.get('/peek')).body.returnTo).toBeNull();
    });
});
