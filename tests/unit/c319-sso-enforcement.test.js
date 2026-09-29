'use strict';
/**
 * 3.23.19 — amendment A (SSO ENFORCED while a provider is enabled).
 * A1 password door SuperAdmin-only (identical refusal), login page, reset,
 * signup; A4 forced enrolment; A5 readiness report. Behavioural, mocked db.
 */
const path = require('path');

const mockEnv = { enforced: true, admins: {}, employees: {}, rows: {} };

jest.mock('../../src/config/sso', () => ({
    isConfigured: () => mockEnv.enforced,
    getEnabledProviders: () =>
        mockEnv.enforced
            ? [
                  {
                      key: 'entra',
                      label: 'Sign in with Microsoft',
                      icon: 'fab fa-microsoft',
                      name: 'Microsoft',
                      customLabel: false,
                  },
              ]
            : [],
}));

jest.mock('../../src/config/database', () => ({
    get: jest.fn(async (sql, p) => {
        const s = String(sql);
        if (/SELECT role, is_active FROM admins WHERE id = \?/.test(s)) return mockEnv.admins[p[0]];
        if (/COUNT\(\*\)::int AS n FROM employees/.test(s))
            return { n: mockEnv.rows.employeesWithout };
        return undefined;
    }),
    all: jest.fn(async (sql) => {
        if (/FROM admins a/.test(String(sql))) return mockEnv.rows.admins || [];
        return [];
    }),
    run: jest.fn(async () => ({ changes: 1 })),
}));

const mockAudit = [];
jest.mock('../../src/services/LogService', () => ({
    log: jest.fn((e) => {
        mockAudit.push(e);
        return Promise.resolve();
    }),
}));

const mockRecord = jest.fn(async () => {});
jest.mock('../../src/middleware/rateLimiter', () => ({
    recordLoginAttempt: (...a) => mockRecord(...a),
    noteEnforcedFailure: jest.fn(async () => {}),
    clearEnforcedFailures: jest.fn(),
    lockStateFor: jest.fn(async () => ({ locked: false })),
}));

jest.mock('../../src/models/AdminModel', () => ({
    findByUsername: jest.fn(async (u) => mockEnv.adminsByName && mockEnv.adminsByName[u]),
    findById: jest.fn(async () => null),
    findWithScopes: jest.fn(async () => null),
}));
jest.mock('../../src/models/EmployeeModel', () => ({
    findByUsername: jest.fn(async (u) => mockEnv.employees[u]),
    findById: jest.fn(async () => mockEnv.person),
}));
jest.mock('../../src/models/AdminPermissionModel', () => ({
    getExpiryStateForAdmin: jest.fn(async () => ({ expired: mockEnv.expired === true })),
    findSlugsByAdminId: jest.fn(async () => []),
}));
const mockAuthLogin = jest.fn();
jest.mock('../../src/services/AuthService', () => ({ login: (...a) => mockAuthLogin(...a) }));
const mockEmpLogin = jest.fn();
jest.mock('../../src/services/EmployeeAuthService', () => ({
    login: (...a) => mockEmpLogin(...a),
    takeRefusalCode: () => null,
}));

const bcrypt = require('bcrypt');
const mockGoodHash = bcrypt.hashSync('good', 10);
const topDb = require('../../src/config/database');
const AdminSso = require('../../src/services/AdminSsoService');
const { _enforcedPasswordLogin } = require('../../src/middleware/auth');

const ctx = { ip: '10.0.0.9', get: () => 'jest' };

beforeEach(() => {
    mockEnv.enforced = true;
    mockAudit.length = 0;
    mockRecord.mockClear();
    mockAuthLogin.mockReset();
    mockEmpLogin.mockReset();
    mockEnv.adminsByName = {
        root: {
            id: 1,
            username: 'root',
            role: 'superadmin',
            isActive: true,
            passwordHash: mockGoodHash,
        },
        ops: { id: 7, username: 'ops', role: 'localadmin', isActive: true },
        viewer: { id: 9, username: 'viewer', role: 'viewer', isActive: true },
    };
    mockEnv.employees = { awa: { id: 55, username: 'awa', passwordHash: mockGoodHash } };
});

describe('A1 — while enforced, a password opens ONLY an active SuperAdmin', () => {
    test('SuperAdmin with the right password → signed in (break-glass, A6)', async () => {
        const [user] = await _enforcedPasswordLogin({}, 'root', 'good', ctx);
        expect(user).toEqual(expect.objectContaining({ id: 1, userType: 'admin' }));
        expect(mockRecord).toHaveBeenCalledWith('root', ctx.ip, true);
        expect(mockAuthLogin).not.toHaveBeenCalled(); // S8: one lookup, one bcrypt, inline
    });

    test('S8 — local admin, viewer, employee, unknown, SuperAdmin bad password, SuperAdmin locked → SAME refusal after the SAME awaited work', async () => {
        mockEnv.adminsByName.locked = {
            id: 2,
            username: 'locked',
            role: 'superadmin',
            isActive: true,
            passwordHash: mockGoodHash,
            lockedUntil: new Date(Date.now() + 60000).toISOString(),
        };
        const spy = jest.spyOn(bcrypt, 'compare');
        const AdminModel = require('../../src/models/AdminModel');
        const EmployeeModel = require('../../src/models/EmployeeModel');
        AdminModel.findByUsername.mockClear();
        EmployeeModel.findByUsername.mockClear();
        const names = ['ops', 'viewer', 'awa', 'nobody', 'root', 'locked'];
        const answers = [];
        for (const u of names)
            answers.push(
                await _enforcedPasswordLogin({}, u, u === 'locked' ? 'good' : 'whatever', ctx)
            );
        await new Promise((r) => setImmediate(r));
        answers.forEach((a) =>
            expect(a).toEqual([false, { message: 'Invalid credentials', code: 'SSO_ENFORCED' }])
        );
        // Every request: one admin lookup, one employee lookup, ONE bcrypt.
        expect(AdminModel.findByUsername).toHaveBeenCalledTimes(names.length);
        expect(EmployeeModel.findByUsername).toHaveBeenCalledTimes(names.length);
        expect(spy).toHaveBeenCalledTimes(names.length);
        // S8: the dummy runs at the cost of the stored hash (10 here), never a cheaper one.
        spy.mock.calls.forEach((c) => expect(String(c[1])).toMatch(/^\$2[aby]?\$10\$/));
        // The employee password service is never consulted while enforced.
        expect(mockEmpLogin).not.toHaveBeenCalled();
        // S2: ONLY the SuperAdmin's wrong password is recorded.
        expect(mockRecord.mock.calls).toEqual([['root', ctx.ip, false]]);
        // The reason lives in the audit only.
        const blocked = mockAudit.filter((l) => l.action === 'LOGIN_BLOCKED').map((l) => l.details);
        expect(blocked.filter((r) => /password_login_blocked_sso_enforced/.test(r))).toHaveLength(
            3
        );
        expect(blocked.filter((r) => /password_login_unknown_sso_enforced/.test(r))).toHaveLength(
            1
        );
        const failed = mockAudit.filter((l) => l.action === 'LOGIN_FAILED').map((l) => l.details);
        expect(failed.some((r) => /password_login_bad_password/.test(r))).toBe(true);
        expect(failed.some((r) => /password_login_locked/.test(r))).toBe(true);
        spy.mockRestore();
    });

    test('the registered passport local strategy applies the gate (no employee/admin service call for a local admin)', async () => {
        const passport = require('passport');
        const strat = passport._strategy('local');
        const out = await new Promise((resolve) =>
            strat._verify({ ip: ctx.ip, get: ctx.get }, 'ops', 'pw', (err, user, info) =>
                resolve({ err, user, info })
            )
        );
        expect(out.err).toBeNull();
        expect(out.user).toBe(false);
        expect(out.info).toEqual({ message: 'Invalid credentials', code: 'SSO_ENFORCED' });
        expect(mockAuthLogin).not.toHaveBeenCalled();
        expect(mockEmpLogin).not.toHaveBeenCalled();
    });

    test('AuthController.login: a refusal reads and lands exactly like a wrong password', async () => {
        jest.resetModules();
        const results = [];
        for (const user of [
            false,
            { id: 7, userType: 'admin', role: 'localadmin', isActive: true },
            { id: 55, userType: 'employee' },
        ]) {
            jest.doMock('passport', () => ({
                authenticate: (n, cb) => () => cb(null, user, { message: 'Invalid credentials' }),
            }));
            const AC = require('../../src/controllers/AuthController');
            const flashes = [];
            let to = null;
            await AC.login(
                {
                    body: { username: 'x' },
                    ip: '1',
                    get: () => '',
                    flash: (t, m) => flashes.push([t, m]),
                    session: {},
                },
                { redirect: (u) => (to = u) },
                () => {}
            );
            results.push({ flashes, to });
            jest.resetModules();
        }
        results.forEach((r) => {
            expect(r.to).toBe('/login?breakglass=1');
            expect(r.flashes).toEqual([
                [
                    'error',
                    'Connexion par mot de passe non autorisée ou identifiants invalides. Utilisez la connexion SSO.',
                ],
            ]);
        });
        jest.dontMock('passport');
    });
});

describe('A1 — reset and signup', () => {
    const PasswordResetService = require('../../src/services/PasswordResetService');
    test('reset allowed only for an active SuperAdmin while enforced; everyone when not', async () => {
        mockEnv.admins = {
            1: { role: 'superadmin', is_active: true },
            7: { role: 'localadmin', is_active: true },
            2: { role: 'superadmin', is_active: false },
        };
        expect(await PasswordResetService.resetAllowed('admin', 1)).toBe(true);
        expect(await PasswordResetService.resetAllowed('admin', 7)).toBe(false);
        expect(await PasswordResetService.resetAllowed('admin', 2)).toBe(false);
        expect(await PasswordResetService.resetAllowed('employee', 55)).toBe(false);
        mockEnv.enforced = false;
        expect(await PasswordResetService.resetAllowed('employee', 55)).toBe(true);
    });
    test('local signup is closed while enforced', async () => {
        const OnboardingService = require('../../src/services/OnboardingService');
        expect(await OnboardingService.allowSignup()).toBe(false);
    });
});

describe('A1 — the login page', () => {
    const ejs = require('ejs');
    const file = path.join(__dirname, '../../views/pages/auth/login.ejs');
    const render = (locals) =>
        ejs.renderFile(file, {
            __: (k, o) => (o && o.name ? `${k}:${o.name}` : k),
            assetVersion: 't',
            cspNonce: 'n',
            csrfToken: 'c',
            errors: [],
            success: [],
            warnings: [],
            ...locals,
        });
    const providers = [
        {
            key: 'entra',
            label: 'Sign in with Microsoft',
            icon: 'fab fa-microsoft',
            name: 'Microsoft',
            customLabel: false,
        },
    ];

    test('enforced → SSO button(s) only, NO password form, one break-glass link', async () => {
        const html = await render({
            ssoProviders: providers,
            ssoEnforced: true,
            breakglass: false,
            emailEnabled: true,
        });
        expect(html).toMatch(/href="\/auth\/sso\/entra"/);
        expect(html).toMatch(/auth:login_sso_with:Microsoft/);
        expect(html).not.toMatch(/name="password"/);
        expect(html).not.toMatch(/action="\/login"/);
        expect(html).not.toMatch(/forgot-password/);
        expect(html).toMatch(/href="\/login\?breakglass=1"/);
    });
    test('?breakglass=1 → password form under the SuperAdmin banner, no reset/signup link', async () => {
        const html = await render({
            ssoProviders: providers,
            ssoEnforced: true,
            breakglass: true,
            emailEnabled: true,
            signupEnabled: true,
        });
        expect(html).toMatch(/name="password"/);
        expect(html).toMatch(/auth:login_breakglass_banner/);
        expect(html).not.toMatch(/forgot-password/);
        expect(html).not.toMatch(/href="\/signup"/);
    });
    test('S12 — SSO switched on but no provider: still enforced, alert shown, break-glass link offered, no password form', async () => {
        const html = await render({
            ssoProviders: [],
            ssoEnforced: true,
            ssoDegraded: true,
            breakglass: false,
        });
        expect(html).toMatch(/data-sso-degraded/);
        expect(html).toMatch(/auth:login_sso_degraded/);
        expect(html).not.toMatch(/name="password"/);
        expect(html).toMatch(/href="\/login\?breakglass=1"/);
    });

    test('not enforced (no provider) → the password page as before', async () => {
        const html = await render({ ssoProviders: [], ssoEnforced: false, emailEnabled: true });
        expect(html).toMatch(/name="password"/);
        expect(html).toMatch(/forgot-password/);
        expect(html).not.toMatch(/\?breakglass=1/);
    });
});

describe('S10/S13/S3 — the MFA-enrolment hold and the forced password change', () => {
    function loadMw(active) {
        jest.resetModules();
        jest.doMock('../../src/models/AppSettingsModel', () => ({ getValue: async () => false }));
        jest.doMock('../../src/services/MfaService', () => ({
            isActive: async () => active.v,
            mfaUserType: () => 'admin',
        }));
        const { enforceMfaEnrollment } = require('../../src/middleware/mfaEnforcement');
        const { forcePasswordChange } = require('../../src/middleware/forcePasswordChange');
        return { enforceMfaEnrollment, forcePasswordChange };
    }
    const mk = (session, path = '/dashboard', user = { id: 7, userType: 'admin' }) => {
        const out = { next: false, to: null, loggedOut: false };
        const req = {
            path,
            session,
            user,
            isAuthenticated: () => true,
            flash: () => {},
            logout: (cb) => {
                out.loggedOut = true;
                cb();
            },
        };
        return {
            req,
            out,
            res: { redirect: (u) => (out.to = u), status: () => ({ json: () => {} }) },
            next: () => (out.next = true),
        };
    };

    test('S10 — held whatever the policy says; enrolment elsewhere does NOT release it; only a code verified in THIS session does', async () => {
        const active = { v: false };
        const { enforceMfaEnrollment } = loadMw(active);
        const a = mk({ mfaEnrolRequired: true });
        await enforceMfaEnrollment(a.req, a.res, a.next);
        expect(a.out.to).toBe('/v2/uam/mfa/setup');
        const b = mk({}); // an ordinary admin session, policy off → free
        await enforceMfaEnrollment(b.req, b.res, b.next);
        expect(b.out.next).toBe(true);
        // MFA became active (another session enrolled) but not proven here → signed out, never released.
        active.v = true;
        const s = { mfaEnrolRequired: true };
        const c = mk(s);
        await enforceMfaEnrollment(c.req, c.res, c.next);
        expect(c.out.next).toBe(false);
        expect(c.out.loggedOut).toBe(true);
        expect(c.out.to).toBe('/login');
        // Verified in this session → released.
        const s2 = { mfaEnrolRequired: true, mfaVerifiedInSession: true };
        const d = mk(s2);
        await enforceMfaEnrollment(d.req, d.res, d.next);
        expect(d.out.next).toBe(true);
        expect(s2.mfaEnrolRequired).toBeUndefined();
        jest.resetModules();
    });

    test('S10 — a DB error keeps a held session held (fail closed)', async () => {
        jest.resetModules();
        jest.doMock('../../src/models/AppSettingsModel', () => ({ getValue: async () => false }));
        jest.doMock('../../src/services/MfaService', () => ({
            isActive: async () => {
                throw new Error('db down');
            },
            mfaUserType: () => 'admin',
        }));
        const { enforceMfaEnrollment } = require('../../src/middleware/mfaEnforcement');
        const a = mk({ mfaEnrolRequired: true });
        await enforceMfaEnrollment(a.req, a.res, a.next);
        expect(a.out.next).toBe(false);
        expect(a.out.to).toBe('/v2/uam/mfa/setup');
        jest.resetModules();
    });

    test('S3 — no redirect loop: an SSO admin with force_password_change + the MFA hold lands on the setup page and stays able to use it', async () => {
        const { enforceMfaEnrollment, forcePasswordChange } = loadMw({ v: false });
        const user = { id: 7, userType: 'admin', forcePasswordChange: true };
        const ssoSession = () => ({
            mfaEnrolRequired: true,
            passport: { user: { id: 7, userType: 'admin', via: 'sso' } },
        });
        // Walk the two middlewares like server.js does, following redirects.
        async function walk(session, path) {
            const seen = [];
            for (let hop = 0; hop < 5; hop++) {
                seen.push(path);
                const x = mk(session, path, user);
                forcePasswordChange(x.req, x.res, x.next);
                if (x.out.to) {
                    path = x.out.to;
                    continue;
                }
                const y = mk(session, path, user);
                await enforceMfaEnrollment(y.req, y.res, y.next);
                if (y.out.to) {
                    path = y.out.to;
                    continue;
                }
                return { settled: path, seen };
            }
            return { settled: null, seen };
        }
        const r = await walk(ssoSession(), '/dashboard');
        expect(r.settled).toBe('/v2/uam/mfa/setup');
        expect(r.seen).not.toContain('/change-password'); // S3: never sent there
        // A PASSWORD session (the SuperAdmin break-glass) is still asked to change it —
        // and /change-password is reachable under the MFA hold (no bounce).
        const pw = await walk(
            { mfaEnrolRequired: true, passport: { user: { id: 1, userType: 'admin' } } },
            '/dashboard'
        );
        expect(pw.settled).toBe('/change-password');
        jest.resetModules();
    });

    test('S13/N1 — the SuperAdmin break-glass without local MFA is held on enrolment, even when logIn wipes the session', async () => {
        jest.resetModules();
        const superUser = {
            id: 1,
            userType: 'admin',
            role: 'superadmin',
            isActive: true,
            username: 'root',
        };
        jest.doMock('passport', () => ({
            authenticate: (n, cb) => () => cb(null, superUser, undefined),
        }));
        jest.doMock('../../src/services/MfaService', () => ({
            isActive: async () => false,
            mfaUserType: () => 'admin',
        }));
        const AC = require('../../src/controllers/AuthController');
        let to = null;
        const session = { stale: true };
        session.regenerate = (cb) => cb();
        const req = {
            body: { username: 'root' },
            ip: '1',
            get: () => '',
            flash: () => {},
            session,
            // like passport 0.6: logIn regenerates and copies nothing across
            logIn: (u, cb) => {
                for (const k of Object.keys(session)) if (k !== 'regenerate') delete session[k];
                cb();
            },
        };
        await new Promise((resolve) => {
            AC.login(
                req,
                {
                    redirect: (u) => {
                        to = u;
                        resolve();
                    },
                },
                () => {}
            );
        });
        expect(session.mfaEnrolRequired).toBe(true);
        expect(to).toBe('/v2/uam/mfa/setup');
        jest.resetModules();
        jest.dontMock('passport');
        jest.dontMock('../../src/services/MfaService');
    });
});

describe('S11 — deserializeUser re-checks an admin session', () => {
    const passport = require('passport');
    const AdminModel = require('../../src/models/AdminModel');
    const deser = (s) =>
        new Promise((resolve) => passport._deserializers[0](s, (err, u) => resolve(u)));
    let admin;
    beforeEach(() => {
        admin = {
            id: 7,
            username: 'ops',
            role: 'localadmin',
            isActive: true,
            linkedEmployeeId: 55,
            lockedUntil: null,
        };
        AdminModel.findWithScopes.mockImplementation(async () => ({ ...admin }));
        mockEnv.person = { id: 55, isActive: true, isAccountActive: true };
        mockEnv.expired = false;
    });
    test('explicit lock ends any admin session', async () => {
        admin.lockedUntil = new Date(Date.now() + 60000).toISOString();
        expect(await deser({ id: 7, userType: 'admin' })).toBe(false);
    });
    test('SSO session via the linked person: the person leaving or the link moving ends it', async () => {
        expect(await deser({ id: 7, userType: 'admin', via: 'sso', viaEmp: 55 })).toEqual(
            expect.objectContaining({ id: 7 })
        );
        mockEnv.person = { id: 55, isActive: false };
        expect(await deser({ id: 7, userType: 'admin', via: 'sso', viaEmp: 55 })).toBe(false);
        mockEnv.person = { id: 55, isActive: true };
        admin.linkedEmployeeId = 99;
        expect(await deser({ id: 7, userType: 'admin', via: 'sso', viaEmp: 55 })).toBe(false);
    });
    test('SSO session: access expiry ends it; a password session keeps today’s behaviour', async () => {
        mockEnv.expired = true;
        expect(await deser({ id: 7, userType: 'admin', via: 'sso' })).toBe(false);
        expect(await deser({ id: 7, userType: 'admin' })).toEqual(
            expect.objectContaining({ id: 7 })
        );
    });
    test('serializeUser records via sso + the linked person only when marked', async () => {
        const ser = (u) =>
            new Promise((resolve) => passport._serializers[0](u, (e, s) => resolve(s)));
        expect(await ser({ id: 7, userType: 'admin' })).toEqual({ id: 7, userType: 'admin' });
        const u = { id: 7, userType: 'admin' };
        Object.defineProperty(u, '_sessionVia', { value: { via: 'sso', viaEmployeeId: 55 } });
        expect(await ser(u)).toEqual({ id: 7, userType: 'admin', via: 'sso', viaEmp: 55 });
    });
});

describe('A5 — readiness report', () => {
    test('lists admins with no SSO path and local_only ones; counts employees', async () => {
        mockEnv.rows = {
            admins: [
                { id: 7, username: 'ops', role: 'localadmin', has_path: false, auth_policy: 'any' },
                {
                    id: 9,
                    username: 'viewer',
                    role: 'viewer',
                    has_path: true,
                    auth_policy: 'local_only',
                },
                {
                    id: 10,
                    username: 'fine',
                    role: 'localadmin',
                    has_path: true,
                    auth_policy: 'any',
                },
            ],
            employeesWithout: 12,
        };
        const r = await AdminSso.readiness();
        expect(r.enforced).toBe(true);
        expect(r.adminsWithoutSso).toEqual([{ id: 7, username: 'ops', role: 'localadmin' }]);
        expect(r.adminsLocalOnly).toEqual([{ id: 9, username: 'viewer', role: 'viewer' }]);
        expect(r.employeesWithoutSso).toBe(12);
        expect(r.hasGaps).toBe(true);
    });
    test('the SQL never counts an e-mail as an admin SSO path', async () => {
        const db = topDb;
        db.all.mockClear();
        await AdminSso.readiness();
        const sql = String(db.all.mock.calls[0][0]);
        expect(sql).toMatch(/subject_type = 'admin'/);
        expect(sql).not.toMatch(/email/i);
    });
});
