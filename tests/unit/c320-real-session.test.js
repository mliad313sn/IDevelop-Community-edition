'use strict';
/**
 * 3.23.20 — Amendment C2 (SuperAdmin MFA ALWAYS mandatory) and C1d (an SSO
 * session promoted to SuperAdmin ends), on the REAL stack: express +
 * express-session (MemoryStore) + passport 0.6 + the app's own serializers,
 * local strategy, AuthController, SsoController and mfaEnforcement. Nothing
 * mocks req.logIn — only the database-facing models are faked.
 */
const crypto = require('crypto');
const mockHash = require('bcrypt').hashSync('right-password', 10);
const mockCodeHash = crypto.createHash('sha256').update('ABCDEFGHJK').digest('hex');
const mockState = {
    enforced: false,
    mfa: new Set(), // admin ids with confirmed MFA
    mfaThrows: false,
    role7: 'localadmin',
    codeUsed: false,
    alerts: [],
};

jest.mock('../../src/config/database', () => ({
    get: jest.fn(async (sql, p) => {
        const s = String(sql);
        if (/FROM admins WHERE id = \?/.test(s)) {
            const id = Number(p[0]);
            if (id === 7)
                return {
                    id: 7,
                    username: 'ops',
                    role: mockState.role7,
                    is_active: true,
                    locked_until: null,
                    auth_policy: 'any',
                    linked_employee_id: null,
                };
            if (id === 1)
                return {
                    id: 1,
                    username: 'root',
                    role: 'superadmin',
                    is_active: true,
                    locked_until: null,
                    auth_policy: 'any',
                    linked_employee_id: null,
                };
            return undefined;
        }
        if (/FROM admin_mfa_enrol_codes/.test(s))
            return mockState.codeUsed ? undefined : { id: 1, code_hash: mockCodeHash, attempts: 0 };
        return undefined;
    }),
    all: jest.fn(async () => []),
    run: jest.fn(async (sql) => {
        if (/SET used_at = now\(\)/.test(String(sql))) {
            if (mockState.codeUsed) return { changes: 0 };
            mockState.codeUsed = true;
        }
        return { changes: 1 };
    }),
}));
jest.mock('../../src/services/LogService', () => ({ log: jest.fn(async () => {}) }));
jest.mock('../../src/services/SuperadminAlertService', () => ({
    alert: jest.fn(async (kind, p) => {
        mockState.alerts.push([kind, p && p.targetAdminId]);
        return 1;
    }),
}));
jest.mock('../../src/config/sso', () => ({
    isConfigured: () => mockState.enforced,
    isSsoIntended: () => mockState.enforced,
    getProvider: () => null,
    getEnabledProviders: () => [],
    hydratePrincipal: jest.fn(async ({ id }) => ({
        id,
        username: id === 1 ? 'root' : 'ops',
        role: id === 1 ? 'superadmin' : mockState.role7,
        userType: 'admin',
        isActive: true,
    })),
}));
jest.mock('../../src/services/MfaService', () => ({
    isActive: jest.fn(async ({ userId }) => {
        if (mockState.mfaThrows) throw new Error('db down');
        return mockState.mfa.has(Number(userId));
    }),
    mfaUserType: () => 'admin',
    verifyAtLogin: jest.fn(async ({ code }) => code === '123456'),
    consumeBackupCode: jest.fn(async () => false),
}));
jest.mock('../../src/models/AppSettingsModel', () => ({ getValue: jest.fn(async (k, d) => d) }));
jest.mock('../../src/models/AdminPermissionModel', () => ({
    getExpiryStateForAdmin: jest.fn(async () => ({ expired: false })),
    findSlugsByAdminId: jest.fn(async () => []),
}));
jest.mock('../../src/models/AdminModel', () => ({
    findByUsername: jest.fn(async (u) =>
        u === 'root'
            ? {
                  id: 1,
                  username: 'root',
                  role: 'superadmin',
                  isActive: true,
                  passwordHash: mockHash,
              }
            : null
    ),
    findById: jest.fn(async () => null),
    findWithScopes: jest.fn(async (id) =>
        id === 1 || id === 7
            ? {
                  id,
                  username: id === 1 ? 'root' : 'ops',
                  role: id === 1 ? 'superadmin' : mockState.role7,
                  isActive: true,
                  lockedUntil: null,
                  linkedEmployeeId: null,
              }
            : null
    ),
}));
jest.mock('../../src/models/EmployeeModel', () => ({
    findByUsername: jest.fn(async () => null),
    findById: jest.fn(async () => null),
}));

const express = require('express');
const session = require('express-session');
const flash = require('express-flash');
const request = require('supertest');
const { passport } = require('../../src/middleware/auth');
const SsoController = require('../../src/controllers/SsoController');
const AuthController = require('../../src/controllers/AuthController');
const { enforceMfaEnrollment } = require('../../src/middleware/mfaEnforcement');

function buildApp() {
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(session({ secret: 'c320-test', resave: false, saveUninitialized: false }));
    app.use(flash());
    app.use(passport.initialize());
    app.use(passport.session());
    app.get('/anon', (req, res) => {
        req.session.visited = true;
        res.json({ sid: req.sessionID });
    });
    app.get('/seed-enrol', (req, res) => {
        req.session.ssoEnrolPending = {
            id: 7,
            userType: 'admin',
            at: Date.now(),
            via: 'sso',
            provider: 'saml',
            method: 'direct',
            employeeId: null,
            relay: null,
            mapped: { oid: 'o-7' },
            fails: 0,
        };
        res.json({ sid: req.sessionID });
    });
    app.get('/drop-flag', (req, res) => {
        delete req.session.mfaEnrolRequired;
        res.json({ ok: true });
    });
    app.post('/auth/sso/enrol-code', SsoController.submitEnrolCode);
    app.post('/login', AuthController.login);
    app.post('/login/mfa', AuthController.verifyMfaChallenge);
    app.get('/state', (req, res) =>
        res.json({
            auth: req.isAuthenticated(),
            userId: req.user ? req.user.id : null,
            hold: req.session.mfaEnrolRequired === true,
        })
    );
    app.use(enforceMfaEnrollment);
    app.get('/dashboard', (req, res) => res.json({ reached: true }));
    return app;
}

beforeEach(() => {
    mockState.enforced = false;
    mockState.mfa = new Set();
    mockState.mfaThrows = false;
    mockState.role7 = 'localadmin';
    mockState.codeUsed = false;
    mockState.alerts = [];
});

async function passwordLogin(agent) {
    await agent.get('/anon');
    return agent.post('/login').type('form').send({ username: 'root', password: 'right-password' });
}

describe('C2 — a SuperAdmin ALWAYS needs MFA (with or without SSO)', () => {
    test('SSO OFF, no MFA enrolled → signed in but HELD on enrolment (every page funnels to setup)', async () => {
        const agent = request.agent(buildApp());
        const r = await passwordLogin(agent);
        expect(r.headers.location).toBe('/v2/uam/mfa/setup');
        const st = (await agent.get('/state')).body;
        expect(st.auth).toBe(true);
        expect(st.hold).toBe(true);
        const d = await agent.get('/dashboard');
        expect(d.status).toBe(302);
        expect(d.headers.location).toBe('/v2/uam/mfa/setup');
    });

    test('the hold is DERIVED from the role: with the flag lost and SSO off, a SuperAdmin without MFA stays held', async () => {
        const agent = request.agent(buildApp());
        await passwordLogin(agent);
        await agent.get('/drop-flag');
        const st = (await agent.get('/state')).body;
        expect(st.auth).toBe(true);
        expect(st.hold).toBe(false); // the flag is gone (and no break-glass origin: SSO off)…
        const d = await agent.get('/dashboard');
        expect(d.status).toBe(302); // …yet the session is STILL held
        expect(d.headers.location).toBe('/v2/uam/mfa/setup');
    });

    test('N1 (security) — a held session is NEVER released because MFA got enrolled ELSEWHERE: signed out, back to the code challenge', async () => {
        for (const dropFlag of [false, true]) {
            mockState.mfa = new Set();
            const agent = request.agent(buildApp());
            await passwordLogin(agent); // the password holder, no MFA → held on setup
            if (dropFlag) await agent.get('/drop-flag');
            mockState.mfa.add(1); // the real owner enrols from another session
            const d = await agent.get('/dashboard');
            expect(d.status).toBe(302);
            expect(d.headers.location).toBe('/login');
            expect((await agent.get('/state')).body.auth).toBe(false);
        }
    });

    for (const enforced of [false, true]) {
        test(`SSO ${enforced ? 'ENFORCED' : 'OFF'}, MFA enrolled → the /login/mfa challenge, NOT signed in until the code`, async () => {
            mockState.enforced = enforced;
            mockState.mfa.add(1);
            const agent = request.agent(buildApp());
            const r = await passwordLogin(agent);
            expect(r.headers.location).toBe('/login/mfa');
            expect((await agent.get('/state')).body.auth).toBe(false);
            const bad = await agent.post('/login/mfa').type('form').send({ code: '000000' });
            expect(bad.headers.location).toBe('/login/mfa');
            expect((await agent.get('/state')).body.auth).toBe(false);
            const ok = await agent.post('/login/mfa').type('form').send({ code: '123456' });
            expect(ok.status).toBe(302);
            const st = (await agent.get('/state')).body;
            expect(st.auth).toBe(true);
            expect(st.userId).toBe(1);
            expect((await agent.get('/dashboard')).body.reached).toBe(true);
            // C2f: a break-glass sign-in is alerted only while SSO is enforced
            const bg = mockState.alerts.filter(([k]) => k === 'security.breakglass_signin');
            expect(bg.length).toBe(enforced ? 1 : 0);
        });
    }

    test('fails CLOSED for a SuperAdmin: an MFA lookup error holds the session on setup', async () => {
        mockState.mfa.add(1);
        const agent = request.agent(buildApp());
        await passwordLogin(agent);
        await agent.post('/login/mfa').type('form').send({ code: '123456' });
        // a fresh request on a session where the second factor was proven passes…
        expect((await agent.get('/dashboard')).body.reached).toBe(true);
        // …a SuperAdmin session WITHOUT that proof and a failing lookup is held.
        const agent2 = request.agent(buildApp());
        mockState.mfa = new Set();
        await passwordLogin(agent2); // held (no MFA)
        mockState.mfaThrows = true;
        const d = await agent2.get('/dashboard');
        expect(d.headers.location).toBe('/v2/uam/mfa/setup');
    });
});

describe('C1d — an SSO session promoted to SuperAdmin is ended at the next request', () => {
    test('local admin signed in by SSO (enrolment code) → promoted → next request is anonymous', async () => {
        mockState.enforced = true;
        const agent = request.agent(buildApp());
        await agent.get('/seed-enrol');
        await agent.post('/auth/sso/enrol-code').type('form').send({ code: 'ABCDEFGHJK' });
        expect((await agent.get('/state')).body.auth).toBe(true);
        mockState.role7 = 'superadmin';
        const st = (await agent.get('/state')).body;
        expect(st.auth).toBe(false);
        expect(st.userId).toBeNull();
    });
});
