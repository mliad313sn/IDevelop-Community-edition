'use strict';
/**
 * 3.23.20 — AMENDMENT B1: a SuperAdmin NEVER signs in through SSO, on any path
 * (identity linked directly, linked-person chooser, the /login/mfa step after an
 * SSO first factor, the one-time enrolment code). Behavioural: the real
 * SsoController / AuthController.verifyMfaChallenge / AdminSsoService, with the
 * database, passport and the SSO registry faked (harness of c319-admin-sso).
 */

// ---- fakes ---------------------------------------------------------------
const mockState = {
    enforced: true,
    admins: {}, // id -> row (snake_case like the DB before camelCasing)
    mfaActive: new Set(), // admin ids with confirmed MFA
    expired: new Set(), // admin ids whose grants all expired
    lockedByAttempts: new Set(), // usernames
    nextUser: null, // what passport's SSO strategy "returns"
    runs: [],
};

jest.mock('../../src/config/database', () => ({
    get: jest.fn(async (sql, p) => {
        const s = String(sql);
        if (/FROM admins WHERE id = \?/.test(s)) {
            const a = mockState.admins[Number(p[0])];
            return a ? { ...a } : undefined;
        }
        if (/UPDATE admin_mfa_enrol_codes\s+SET attempts = attempts \+ 1/.test(s)) {
            const c = mockState.enrolCodes[Number(p[1])];
            if (!c || c.used) return undefined;
            c.attempts += 1;
            return { attempts: c.attempts };
        }
        if (/FROM admin_mfa_enrol_codes/.test(s)) {
            const c = mockState.enrolCodes[Number(p[0])];
            return c && !c.used && c.attempts < 5
                ? { id: Number(p[0]), code_hash: c.hash, attempts: c.attempts }
                : undefined;
        }
        return undefined;
    }),
    all: jest.fn(async (sql, p) => {
        const s = String(sql);
        if (/FROM admins WHERE linked_employee_id = \? AND is_active = true/.test(s)) {
            return Object.values(mockState.admins)
                .filter((a) => a.linked_employee_id === Number(p[0]) && a.is_active)
                .map((a) => ({ id: a.id }));
        }
        return [];
    }),
    run: jest.fn(async (sql, p) => {
        const s = String(sql);
        mockState.runs.push({ sql: s, p });
        // enrol codes keyed by admin id (the row id IS the admin id in this fake)
        if (/UPDATE admin_mfa_enrol_codes SET used_at/.test(s)) {
            const c = mockState.enrolCodes[Number(p[0])];
            if (!c || c.used) return { changes: 0 };
            c.used = true;
        }
        if (/UPDATE admin_mfa_enrol_codes SET attempts/.test(s)) {
            const c = mockState.enrolCodes[Number(p[3])];
            if (c) c.attempts = Number(p[0]);
        }
        return { changes: 1 };
    }),
}));

const mockLogs = [];
jest.mock('../../src/services/LogService', () => ({
    log: jest.fn((e) => {
        mockLogs.push(e);
        return Promise.resolve();
    }),
}));

jest.mock('../../src/services/MfaService', () => ({
    isActive: jest.fn(async ({ userId }) => mockState.mfaActive.has(Number(userId))),
    mfaUserType: (u) => (u.userType === 'admin' ? 'admin' : 'employee'),
    verifyAtLogin: jest.fn(async ({ code }) => code === '123456'),
    consumeBackupCode: jest.fn(async () => false),
}));

jest.mock('../../src/models/AdminPermissionModel', () => ({
    getExpiryStateForAdmin: jest.fn(async (id) => ({ expired: mockState.expired.has(Number(id)) })),
    findSlugsByAdminId: jest.fn(async () => []),
}));

jest.mock('../../src/middleware/rateLimiter', () => ({
    lockStateFor: jest.fn(async (u) => ({ locked: mockState.lockedByAttempts.has(u) })),
    recordLoginAttempt: jest.fn(async () => {}),
}));

jest.mock('../../src/models/EmployeeModel', () => ({
    findById: jest.fn(async (id) => ({
        id,
        firstName: 'Awa',
        lastName: 'Silva',
        username: 'awa',
    })),
    findByIdWithOrganization: jest.fn(async (id) => ({ id, username: 'awa', isActive: true })),
    governanceOf: jest.fn(async () => ({ governs: false, supervises: false, manages: false })),
}));

jest.mock('../../src/models/AdminModel', () => ({
    findWithScopes: jest.fn(async (id) => {
        const a = mockState.admins[Number(id)];
        return a ? { id: a.id, username: a.username, role: a.role, isActive: a.is_active } : null;
    }),
}));

function mockHydrate(principal) {
    if (principal.kind === 'employee') {
        const e = { id: principal.id, username: 'awa', userType: 'employee', isActive: true };
        return e;
    }
    const a = mockState.admins[principal.id];
    return a ? { id: a.id, username: a.username, role: a.role, userType: 'admin' } : null;
}

jest.mock('../../src/config/sso', () => ({
    isConfigured: () => mockState.enforced,
    isSsoIntended: () => mockState.enforced,
    getProvider: (key) =>
        key === 'saml' ? { key: 'saml', strategyName: 'sso-saml', authOptions: {} } : null,
    getEnabledProviders: () => (mockState.enforced ? [{ key: 'saml', label: 'x', icon: 'i' }] : []),
    hydratePrincipal: jest.fn(async (p) => mockHydrate(p)),
}));

jest.mock('passport', () => ({
    authenticate: jest.fn((name, cb) => () => cb(null, mockState.nextUser, undefined)),
}));

const SsoController = require('../../src/controllers/SsoController');
const AuthController = require('../../src/controllers/AuthController');
const AdminSso = require('../../src/services/AdminSsoService');

// A user as resolveAndFinish hands it over (non-enumerable SSO context).
function ssoUser(base, ctx) {
    const u = { ...base };
    Object.defineProperty(u, '_ssoContext', {
        value: {
            provider: 'saml',
            mfaAsserted: false,
            via: 'linked',
            linkMethod: 'superadmin_link',
            aliasMatch: false,
            mapped: { oid: 'oid-9' },
            ...ctx,
        },
        enumerable: false,
    });
    return u;
}

function makeReqRes({ body = {}, query = {}, session = {} } = {}) {
    let done;
    const finished = new Promise((r) => (done = r));
    const req = {
        params: { provider: 'saml' },
        body,
        query,
        ip: '10.0.0.1',
        get: () => 'jest',
        flashes: [],
        flash(type, msg) {
            this.flashes.push([type, msg]);
        },
        isAuthenticated() {
            return !!this.user;
        },
        logIn(user, cb) {
            this.user = user;
            cb();
        },
        regenerated: 0,
    };
    req.session = Object.assign(
        {
            regenerate(cb) {
                req.regenerated += 1;
                for (const k of Object.keys(req.session))
                    if (!['regenerate', 'save'].includes(k)) delete req.session[k];
                cb();
            },
            save(cb) {
                cb();
            },
        },
        session
    );
    const res = {
        redirected: null,
        rendered: null,
        redirect(u) {
            this.redirected = u;
            done();
        },
        render(v, o) {
            this.rendered = { v, o };
            done();
        },
    };
    return { req, res, finished };
}

async function callback(user, opts = {}) {
    mockState.nextUser = user;
    const x = makeReqRes(opts);
    SsoController.callback(x.req, x.res, () => {});
    await x.finished;
    await new Promise((r) => setImmediate(r));
    return x;
}

const sha = (s) => require('crypto').createHash('sha256').update(s).digest('hex');
const actions = () => mockLogs.map((l) => l.action);
const denied = () => mockLogs.filter((l) => l.action === 'SSO_DENIED').map((l) => l.details);

beforeEach(() => {
    mockLogs.length = 0;
    mockState.runs.length = 0;
    mockState.enforced = true;
    mockState.mfaActive = new Set();
    mockState.expired = new Set();
    mockState.lockedByAttempts = new Set();
    mockState.enrolCodes = {};
    mockState.admins = {
        7: {
            id: 7,
            username: 'ops.admin',
            role: 'localadmin',
            is_active: true,
            locked_until: null,
            auth_policy: 'any',
            linked_employee_id: 55,
        },
        8: {
            id: 8,
            username: 'root',
            role: 'superadmin',
            is_active: true,
            locked_until: null,
            auth_policy: 'any',
            linked_employee_id: null,
        },
    };
});

const forbidden = () => denied().filter((d) => /superadmin_sso_forbidden/.test(d));

describe('B1 — a SuperAdmin never signs in through SSO', () => {
    test('eligibility refuses a SuperAdmin on every route (with or without the switch check)', async () => {
        expect((await AdminSso.eligibility(8)).reason).toBe('superadmin_sso_forbidden');
        expect((await AdminSso.eligibility(8, { skipSwitch: true })).reason).toBe(
            'superadmin_sso_forbidden'
        );
        // control: a local admin still passes
        expect((await AdminSso.eligibility(7)).ok).toBe(true);
    });

    test('direct identity: refused even with IdP MFA AND local MFA — no session, no MFA step, generic message', async () => {
        mockState.mfaActive.add(8);
        const { req, res } = await callback(
            ssoUser({ id: 8, username: 'root', userType: 'admin' }, { mfaAsserted: true })
        );
        expect(req.user).toBeUndefined();
        expect(req.session.mfaPending).toBeUndefined();
        expect(res.redirected).toBe('/login');
        expect(req.flashes[0][1]).toMatch(
            /La connexion n’a pas abouti.*Contactez .* en indiquant l’heure de la tentative/
        ); // UX-4 (3.23.21)
        expect(forbidden()).toHaveLength(1);
        expect(actions()).not.toContain('LOGIN_SUCCESS');
        expect(actions()).not.toContain('MFA_CHALLENGE');
    });

    test('chooser: an employee whose linked admin is a SuperAdmin is never offered it — signs in as themselves', async () => {
        mockState.admins[8].linked_employee_id = 56;
        expect(await AdminSso.linkedAdminCandidates(56)).toEqual([]);
        const { req, res } = await callback(
            ssoUser({ id: 56, username: 'awa', userType: 'employee' }, { mfaAsserted: true })
        );
        expect(res.redirected).not.toBe('/auth/sso/choose');
        expect(req.session.ssoChoice).toBeUndefined();
        expect(req.user && req.user.id).toBe(56);
        expect(req.user.userType).toBe('employee');
    });

    test('chooser POST: a stale or forged choice naming a SuperAdmin is refused', async () => {
        mockState.admins[8].linked_employee_id = 56;
        const c = {
            employeeId: 56,
            adminIds: [8],
            provider: 'saml',
            mfaAsserted: true,
            relay: null,
            mapped: {},
            nonce: 'n0nce-value',
            at: Date.now(),
        };
        const x = makeReqRes({
            body: { nonce: c.nonce, choice: 'admin:8' },
            session: { ssoChoice: c },
        });
        await SsoController.submitChoice(x.req, x.res);
        expect(x.req.user).toBeUndefined();
        expect(x.res.redirected).toBe('/login');
        expect(forbidden()).toHaveLength(1);
    });

    test('/login/mfa after an SSO first factor: a SuperAdmin is refused even with a valid code', async () => {
        mockState.mfaActive.add(8);
        const x = makeReqRes({
            body: { code: '123456' },
            session: {
                mfaPending: {
                    id: 8,
                    userType: 'admin',
                    via: 'sso',
                    provider: 'saml',
                    method: 'direct',
                    at: Date.now(),
                },
            },
        });
        await AuthController.verifyMfaChallenge(x.req, x.res);
        expect(x.req.user).toBeUndefined();
        expect(x.res.redirected).toBe('/login');
        expect(forbidden()).toHaveLength(1);
    });

    test('enrolment-code step: a SuperAdmin is refused and the code is NOT consumed', async () => {
        mockState.enrolCodes[8] = { hash: sha('ABCDEFGHJK'), attempts: 0 };
        const x = makeReqRes({
            body: { code: 'ABCDEFGHJK' },
            session: {
                ssoEnrolPending: {
                    id: 8,
                    userType: 'admin',
                    via: 'sso',
                    provider: 'saml',
                    method: 'direct',
                    at: Date.now(),
                    fails: 0,
                },
            },
        });
        await SsoController.submitEnrolCode(x.req, x.res);
        expect(x.req.user).toBeUndefined();
        expect(mockState.enrolCodes[8].used).toBeFalsy();
        expect(forbidden()).toHaveLength(1);
    });
});
