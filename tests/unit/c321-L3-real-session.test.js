'use strict';
/**
 * 3.23.21 lane L3 — EXC (employee SSO exceptions) and UX-8 on the REAL stack:
 * express + express-session (MemoryStore) + passport 0.6 + the app's own local
 * strategy, serializers, AuthController and mfaEnforcement. Nothing mocks
 * req.logIn — only the database-facing models are faked.
 *   - while SSO is enforced, an employee a SuperAdmin listed as an SSO exception
 *     signs in with the password (not held on MFA enrolment);
 *   - any other employee is refused EXACTLY like a wrong password (same status,
 *     same destination, same message) — anti-enumeration unchanged;
 *   - an exception set by nobody (sso_exception_by NULL) is not honoured;
 *   - UX-8: « Changer le mot de passe » is offered only when allowed.
 */
const mockHash = require('bcrypt').hashSync('right-password', 10);
const mockState = { enforced: false };
const mockEmployees = {
    exc: { id: 41, username: 'exc', ssoExceptionAt: '2026-09-29T08:00:00Z', ssoExceptionBy: 1 },
    plain: { id: 42, username: 'plain', ssoExceptionAt: null, ssoExceptionBy: null },
    orphan: {
        id: 43,
        username: 'orphan',
        ssoExceptionAt: '2026-09-29T08:00:00Z',
        ssoExceptionBy: null,
    },
};
const mockRow = (e) =>
    e && {
        ...e,
        firstName: 'P',
        lastName: e.username,
        employeeNumber: `E${e.id}`,
        isActive: true,
        isAccountActive: true,
        passwordHash: mockHash,
        authPolicy: 'any',
    };
const mockById = (id) => Object.values(mockEmployees).find((e) => e.id === Number(id));

jest.mock('../../src/config/database', () => ({
    get: jest.fn(async () => undefined),
    all: jest.fn(async () => []),
    run: jest.fn(async () => ({ changes: 1 })),
}));
jest.mock('../../src/services/LogService', () => ({ log: jest.fn(async () => {}) }));
jest.mock('../../src/services/SuperadminAlertService', () => ({ alert: jest.fn(async () => 1) }));
jest.mock('../../src/config/sso', () => ({
    isConfigured: () => mockState.enforced,
    isSsoIntended: () => mockState.enforced,
    getProvider: () => null,
    getEnabledProviders: () => [],
}));
jest.mock('../../src/services/MfaService', () => ({
    isActive: jest.fn(async () => false),
    mfaUserType: (u) => (u && u.userType === 'admin' ? 'admin' : 'employee'),
    verifyAtLogin: jest.fn(async () => false),
    consumeBackupCode: jest.fn(async () => false),
}));
jest.mock('../../src/models/AppSettingsModel', () => ({ getValue: jest.fn(async (k, d) => d) }));
jest.mock('../../src/models/AdminModel', () => ({
    findByUsername: jest.fn(async () => null),
    findById: jest.fn(async () => null),
    findWithScopes: jest.fn(async () => null),
}));
jest.mock('../../src/models/EmployeeModel', () => ({
    findByUsername: jest.fn(async (u) => mockRow(mockEmployees[u])),
    findById: jest.fn(async (id) => mockRow(mockById(id))),
    findByIdWithOrganization: jest.fn(async (id) => mockRow(mockById(id))),
    governanceOf: jest.fn(async () => ({ governs: false, supervises: false, manages: false })),
    update: jest.fn(async () => ({})),
}));

const express = require('express');
const session = require('express-session');
const flash = require('express-flash');
const request = require('supertest');
const { passport } = require('../../src/middleware/auth');
const AuthController = require('../../src/controllers/AuthController');
const { enforceMfaEnrollment } = require('../../src/middleware/mfaEnforcement');

function buildApp() {
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(session({ secret: 'c321-l3', resave: false, saveUninitialized: false }));
    app.use(flash());
    app.use(passport.initialize());
    app.use(passport.session());
    app.get('/anon', (req, res) => {
        req.session.visited = true;
        res.json({ ok: true });
    });
    app.post('/login', AuthController.login);
    app.get('/flash', (req, res) => res.json({ error: req.flash('error') }));
    app.use(enforceMfaEnrollment);
    app.get('/state', (req, res) =>
        res.json({
            auth: req.isAuthenticated(),
            userId: req.user ? req.user.id : null,
            hold: req.session.mfaEnrolRequired === true,
            pwChange: res.locals.passwordChangeAllowed,
        })
    );
    return app;
}

async function login(agent, username, password = 'right-password') {
    await agent.get('/anon');
    const r = await agent.post('/login').type('form').send({ username, password });
    const f = (await agent.get('/flash')).body.error;
    return { status: r.status, location: r.headers.location, flash: f };
}

beforeEach(() => {
    mockState.enforced = false;
});

describe('EXC — an employee SSO exception keeps password sign-in while SSO is enforced', () => {
    test('the listed employee signs in, lands on the employee home, is NOT held, may change the password', async () => {
        mockState.enforced = true;
        const agent = request.agent(buildApp());
        const r = await login(agent, 'exc');
        expect(r.location).toBe('/employee/dashboard');
        const st = (await agent.get('/state')).body;
        expect(st).toEqual({ auth: true, userId: 41, hold: false, pwChange: true });
    });

    test('anyone else is refused EXACTLY like a wrong password (anti-enumeration)', async () => {
        mockState.enforced = true;
        const plain = await login(request.agent(buildApp()), 'plain');
        const wrong = await login(request.agent(buildApp()), 'exc', 'wrong-password');
        const unknown = await login(request.agent(buildApp()), 'nobody');
        const orphan = await login(request.agent(buildApp()), 'orphan'); // no SuperAdmin behind it
        for (const r of [wrong, unknown, orphan]) expect(r).toEqual(plain);
        expect(plain.location).toBe('/login?breakglass=1');
        expect(plain.status).toBe(302);
    });

    test('SSO not enforced: unchanged — every employee signs in with the password', async () => {
        const agent = request.agent(buildApp());
        const r = await login(agent, 'plain');
        expect(r.location).toBe('/employee/dashboard');
        expect((await agent.get('/state')).body.pwChange).toBe(true);
    });

    test('UX-8 — a plain employee session loses « change password » once SSO is enforced', async () => {
        const agent = request.agent(buildApp());
        await login(agent, 'plain');
        mockState.enforced = true;
        const st = (await agent.get('/state')).body;
        expect(st.auth).toBe(true);
        expect(st.pwChange).toBe(false);
    });
});
