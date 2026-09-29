'use strict';
/**
 * 3.23.19 — security committee N1, on the REAL stack: express + express-session
 * (MemoryStore) + passport 0.6 + the app's own serializers, local strategy,
 * SsoController, AuthController and mfaEnforcement. Nothing mocks req.logIn.
 * Only the database-facing models are faked.
 *
 * Proves that the MFA-enrolment hold survives passport 0.6's own session
 * regeneration inside logIn (which copies nothing across), for:
 *   - an admin signing in by SSO with a one-time enrolment code;
 *   - the SuperAdmin break-glass password sign-in without local MFA;
 * and that the session id still rotates at sign-in (fixation).
 */
const crypto = require('crypto');
const mockHash = require('bcrypt').hashSync('right-password', 10);
const mockCodeHash = crypto.createHash('sha256').update('ABCDEFGHJK').digest('hex');
const mockState = { codeUsed: false };

jest.mock('../../src/config/database', () => ({
    get: jest.fn(async (sql, p) => {
        const s = String(sql);
        if (/FROM admins WHERE id = \?/.test(s)) {
            const id = Number(p[0]);
            if (id === 7)
                return {
                    id: 7,
                    username: 'ops',
                    role: 'localadmin',
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
jest.mock('../../src/config/sso', () => ({
    isConfigured: () => true,
    isSsoIntended: () => true,
    getProvider: () => null,
    getEnabledProviders: () => [],
    hydratePrincipal: jest.fn(async ({ id }) => ({
        id,
        username: id === 1 ? 'root' : 'ops',
        role: id === 1 ? 'superadmin' : 'localadmin',
        userType: 'admin',
        isActive: true,
    })),
}));
jest.mock('../../src/services/MfaService', () => ({
    isActive: jest.fn(async () => false),
    mfaUserType: () => 'admin',
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
                  role: id === 1 ? 'superadmin' : 'localadmin',
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
const { passport } = require('../../src/middleware/auth'); // registers the app's strategy + serializers
const SsoController = require('../../src/controllers/SsoController');
const AuthController = require('../../src/controllers/AuthController');
const { enforceMfaEnrollment } = require('../../src/middleware/mfaEnforcement');

function buildApp() {
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(session({ secret: 'c319-test', resave: false, saveUninitialized: false }));
    app.use(flash());
    app.use(passport.initialize());
    app.use(passport.session());
    // Test seams: open an ANONYMOUS session (its id is what an attacker could
    // fixate), and park the enrolment-code step exactly as SsoController does.
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
    // L1 seam: simulate a lost second save — the hold FLAG disappears.
    app.get('/drop-flag', (req, res) => {
        delete req.session.mfaEnrolRequired;
        res.json({ ok: true });
    });
    app.post('/auth/sso/enrol-code', SsoController.submitEnrolCode);
    app.post('/login', AuthController.login);
    app.get('/state', (req, res) =>
        res.json({
            auth: req.isAuthenticated(),
            userId: req.user ? req.user.id : null,
            hold: req.session.mfaEnrolRequired === true,
            sid: req.sessionID,
        })
    );
    app.use(enforceMfaEnrollment);
    app.get('/dashboard', (req, res) => res.json({ reached: true }));
    return app;
}

beforeEach(() => {
    mockState.codeUsed = false;
});

test('N1 — enrolment-code admin: signed in, HELD on MFA setup, session id rotated', async () => {
    const agent = request.agent(buildApp());
    const before = (await agent.get('/seed-enrol')).body.sid;
    const r = await agent.post('/auth/sso/enrol-code').type('form').send({ code: 'ABCDE-FGHJK' });
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('/v2/uam/mfa/setup');
    const st = (await agent.get('/state')).body;
    expect(st.auth).toBe(true);
    expect(st.userId).toBe(7);
    expect(st.hold).toBe(true); // survived passport 0.6's regenerate
    expect(st.sid).not.toBe(before); // fixation: rotated
    // the hold is effective: every other page funnels to the setup
    const d = await agent.get('/dashboard');
    expect(d.status).toBe(302);
    expect(d.headers.location).toBe('/v2/uam/mfa/setup');
});

test('N1/S13 — break-glass SuperAdmin without MFA: signed in, HELD on MFA setup, session id rotated', async () => {
    const agent = request.agent(buildApp());
    const before = (await agent.get('/anon')).body.sid;
    const r = await agent
        .post('/login')
        .type('form')
        .send({ username: 'root', password: 'right-password' });
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('/v2/uam/mfa/setup');
    const st = (await agent.get('/state')).body;
    expect(st.auth).toBe(true);
    expect(st.userId).toBe(1);
    expect(st.hold).toBe(true);
    expect(st.sid).not.toBe(before);
    const d = await agent.get('/dashboard');
    expect(d.status).toBe(302);
    expect(d.headers.location).toBe('/v2/uam/mfa/setup');
});

test('control — a refused password (wrong) signs nobody in and holds nothing', async () => {
    const agent = request.agent(buildApp());
    await agent.get('/anon');
    const r = await agent.post('/login').type('form').send({ username: 'root', password: 'nope' });
    expect(r.headers.location).toBe('/login?breakglass=1');
    const st = (await agent.get('/state')).body;
    expect(st.auth).toBe(false);
});

test('L1 — the hold survives even if the FLAG is lost: derived from the session origin (break-glass / SSO)', async () => {
    for (const flow of ['breakglass', 'sso-code']) {
        mockState.codeUsed = false;
        const agent = request.agent(buildApp());
        if (flow === 'breakglass') {
            await agent.get('/anon');
            await agent
                .post('/login')
                .type('form')
                .send({ username: 'root', password: 'right-password' });
        } else {
            await agent.get('/seed-enrol');
            await agent.post('/auth/sso/enrol-code').type('form').send({ code: 'ABCDEFGHJK' });
        }
        await agent.get('/drop-flag');
        const st = (await agent.get('/state')).body;
        expect(st.auth).toBe(true);
        expect(st.hold).toBe(false); // the flag is gone…
        const d = await agent.get('/dashboard');
        expect(d.status).toBe(302); // …and the session is STILL held
        expect(d.headers.location).toBe('/v2/uam/mfa/setup');
    }
});
