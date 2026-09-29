'use strict';
/**
 * 3.23.19 — SSO for administrator accounts (design D2-D9 + amendment A2-A4).
 * Behavioural: the real SsoController / AuthController.verifyMfaChallenge /
 * AdminSsoService, with the database, passport and the SSO registry faked.
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

describe('D2/A2 — admin SSO follows SSO enforcement', () => {
    test('no provider enforced → an admin identity is refused exactly as before (same message)', async () => {
        mockState.enforced = false;
        const { req, res } = await callback(
            ssoUser({ id: 7, username: 'ops.admin', userType: 'admin' }, { via: 'linked' })
        );
        expect(res.redirected).toBe('/login');
        expect(req.user).toBeUndefined();
        expect(req.flashes[0][1]).toMatch(
            /mot de passe et une double authentification, pas par authentification unique/
        );
        expect(denied()[0]).toMatch(/admin_sso_disabled/);
    });
});

describe('D3a + D5/A4 — identity linked directly to an admin', () => {
    test('IdP-asserted MFA → signed in, session rotated, SSO_LOGIN mfa=idp + LOGIN_SUCCESS, identity stamped', async () => {
        const { req, res } = await callback(
            ssoUser({ id: 7, username: 'ops.admin', userType: 'admin' }, { mfaAsserted: true }),
            { body: { RelayState: '/admins' } }
        );
        expect(req.user && req.user.id).toBe(7);
        expect(req.regenerated).toBe(1);
        expect(res.redirected).toBe('/admins');
        // L1: the IdP proved the second factor for THIS session — not held.
        expect(req.session.mfaVerifiedInSession).toBe(true);
        const sso = mockLogs.find((l) => l.action === 'SSO_LOGIN');
        expect(sso.details).toMatch(/method=direct mfa=idp/);
        expect(sso.adminId).toBe(7);
        expect(actions()).toContain('LOGIN_SUCCESS');
        expect(mockState.runs.some((r) => /subject_type = 'admin'/.test(r.sql))).toBe(true);
    });

    test('an unsafe RelayState is never followed', async () => {
        const { res } = await callback(
            ssoUser({ id: 7, username: 'ops.admin', userType: 'admin' }, { mfaAsserted: true }),
            { body: { RelayState: '//evil.example/x' } }
        );
        expect(res.redirected).toBe('/dashboard');
    });

    test('local MFA active → NOT signed in; the /login/mfa challenge is parked with first factor SSO', async () => {
        mockState.mfaActive.add(7);
        const { req, res } = await callback(
            ssoUser({ id: 7, username: 'ops.admin', userType: 'admin' }, { mfaAsserted: true })
        );
        expect(req.user).toBeUndefined();
        expect(res.redirected).toBe('/login/mfa');
        expect(req.session.mfaPending).toEqual(
            expect.objectContaining({
                id: 7,
                userType: 'admin',
                via: 'sso',
                provider: 'saml',
                method: 'direct',
            })
        );
        expect(actions()).toContain('MFA_CHALLENGE');
        expect(actions()).not.toContain('LOGIN_SUCCESS');
    });

    test('S1 — no local MFA, no IdP MFA, no enrolment code → REFUSED with a clear message', async () => {
        const { req, res } = await callback(
            ssoUser({ id: 7, username: 'ops.admin', userType: 'admin' }, { mfaAsserted: false })
        );
        expect(req.user).toBeUndefined();
        expect(res.redirected).toBe('/login');
        expect(req.flashes[0][1]).toMatch(
            /Demandez un code d’enrôlement à un super administrateur/
        );
        expect(denied()[0]).toMatch(/admin_mfa_required/);
    });

    test('S1/B1 (3.23.20) — a SuperAdmin never signs in through SSO, even holding a code', async () => {
        mockState.enrolCodes[8] = { hash: sha('ABCDEFGHJK'), attempts: 0 };
        const { req } = await callback(
            ssoUser({ id: 8, username: 'root', userType: 'admin' }, { mfaAsserted: false })
        );
        expect(req.user).toBeUndefined();
        expect(denied()[0]).toMatch(/superadmin_sso_forbidden/);
        expect(req.flashes[0][1]).toMatch(
            /La connexion n’a pas abouti.*Contactez .* en indiquant l’heure de la tentative/
        ); // UX-4 (3.23.21)
    });

    test('S1/S10 — with a live code: NOT signed in until the code is typed; then held on enrolment set BEFORE logIn', async () => {
        mockState.enrolCodes[7] = { hash: sha('ABCDEFGHJK'), attempts: 0 };
        const first = await callback(
            ssoUser({ id: 7, username: 'ops.admin', userType: 'admin' }, { mfaAsserted: false })
        );
        expect(first.req.user).toBeUndefined();
        expect(first.res.redirected).toBe('/auth/sso/enrol-code');
        const pending = first.req.session.ssoEnrolPending;
        expect(pending).toEqual(expect.objectContaining({ id: 7, via: 'sso', method: 'direct' }));
        // wrong code → stays pending, attempt counted
        const bad = makeReqRes({
            body: { code: 'ZZZZZZZZZZ' },
            session: { ssoEnrolPending: { ...pending } },
        });
        await SsoController.submitEnrolCode(bad.req, bad.res);
        expect(bad.req.user).toBeUndefined();
        expect(bad.res.redirected).toBe('/auth/sso/enrol-code');
        expect(mockState.enrolCodes[7].attempts).toBe(1);
        // right code (case/space tolerant) → logged in, held on enrolment. (That the
        // flag SURVIVES passport's own regenerate is proven on the real stack in
        // c319-real-session.test.js.) A logIn that wipes the session — as passport
        // 0.6 does — must not lose it:
        const ok = makeReqRes({
            body: { code: 'abcde fghjk' },
            session: { ssoEnrolPending: { ...pending } },
        });
        const origLogIn = ok.req.logIn;
        ok.req.logIn = function (u, cb) {
            for (const k of Object.keys(ok.req.session))
                if (!['regenerate', 'save'].includes(k)) delete ok.req.session[k];
            return origLogIn.call(this, u, cb);
        };
        await SsoController.submitEnrolCode(ok.req, ok.res);
        await ok.finished;
        expect(ok.req.user && ok.req.user.id).toBe(7);
        expect(ok.req.session.mfaEnrolRequired).toBe(true);
        expect(ok.res.redirected).toBe('/v2/uam/mfa/setup');
        expect(mockState.enrolCodes[7].used).toBe(true);
        expect(mockLogs.find((l) => l.action === 'SSO_LOGIN').details).toMatch(/mfa=enrol-code/);
        // single use: the same code again finds nothing
        const again = makeReqRes({
            body: { code: 'ABCDEFGHJK' },
            session: { ssoEnrolPending: { ...pending, at: Date.now() } },
        });
        await SsoController.submitEnrolCode(again.req, again.res);
        expect(again.req.user).toBeUndefined();
    });

    test('S1 — 5 wrong codes end the step', async () => {
        mockState.enrolCodes[7] = { hash: sha('ABCDEFGHJK'), attempts: 0 };
        const first = await callback(
            ssoUser({ id: 7, username: 'ops.admin', userType: 'admin' }, { mfaAsserted: false })
        );
        const session = { ssoEnrolPending: { ...first.req.session.ssoEnrolPending } };
        let x;
        for (let i = 0; i < 5; i++) {
            x = makeReqRes({ body: { code: 'WRONG' + i }, session });
            await SsoController.submitEnrolCode(x.req, x.res);
            Object.assign(session, { ssoEnrolPending: x.req.session.ssoEnrolPending });
        }
        expect(x.req.session.ssoEnrolPending).toBeUndefined();
        expect(x.res.redirected).toBe('/login');
        const late = makeReqRes({
            body: { code: 'ABCDEFGHJK' },
            session: { ssoEnrolPending: { ...first.req.session.ssoEnrolPending, at: Date.now() } },
        });
        await SsoController.submitEnrolCode(late.req, late.res);
        expect(late.req.user).toBeUndefined();
    });

    test('S1 — the session-side limit holds too (5 wrong entries in one step, even across re-issued codes)', async () => {
        mockState.enrolCodes[7] = { hash: sha('ABCDEFGHJK'), attempts: 0 };
        const first = await callback(
            ssoUser({ id: 7, username: 'ops.admin', userType: 'admin' }, { mfaAsserted: false })
        );
        const x = makeReqRes({
            body: { code: 'WRONG' },
            session: { ssoEnrolPending: { ...first.req.session.ssoEnrolPending, fails: 4 } },
        });
        await SsoController.submitEnrolCode(x.req, x.res);
        expect(x.req.session.ssoEnrolPending).toBeUndefined();
        expect(x.res.redirected).toBe('/login');
    });

    test('S4 — an identity on the admin NOT linked by a SuperAdmin/onboarding merge is refused', async () => {
        for (const m of ['sso_email', 'migration_mapping', 'unknown', 'legacy', 'delegated_link']) {
            mockLogs.length = 0;
            const { req } = await callback(
                ssoUser(
                    { id: 7, username: 'ops.admin', userType: 'admin' },
                    { mfaAsserted: true, linkMethod: m }
                )
            );
            expect(req.user).toBeUndefined();
            expect(denied()[0]).toMatch(/admin_link_untrusted/);
        }
        const ok = await callback(
            ssoUser(
                { id: 7, username: 'ops.admin', userType: 'admin' },
                { mfaAsserted: true, linkMethod: 'onboarding_merge' }
            )
        );
        expect(ok.req.user && ok.req.user.id).toBe(7);
    });

    test('S5 — a match on an e-mail-like alias is refused for an admin', async () => {
        const { req } = await callback(
            ssoUser(
                { id: 7, username: 'ops.admin', userType: 'admin' },
                { mfaAsserted: true, aliasMatch: true }
            )
        );
        expect(req.user).toBeUndefined();
        expect(denied()[0]).toMatch(/admin_uid_alias/);
    });

    test('S5 residual — a SAML e-mail NameID with no immutable id is refused for an admin', async () => {
        const { req } = await callback(
            ssoUser(
                { id: 7, username: 'ops.admin', userType: 'admin' },
                { mfaAsserted: true, unstableUid: true }
            )
        );
        expect(req.user).toBeUndefined();
        expect(denied()[0]).toMatch(/admin_uid_unstable/);
        mockLogs.length = 0;
        const emp = await callback(
            ssoUser(
                { id: 55, username: 'awa', userType: 'employee' },
                { via: 'linked', unstableUid: true }
            )
        );
        expect(emp.req.user && emp.req.user.id).toBe(55); // the person, never the admin
        expect(denied()[0]).toMatch(/admin_uid_unstable/);
    });

    test('S11 — the SSO session is marked for serializeUser (via sso, linked person)', async () => {
        const { req } = await callback(
            ssoUser({ id: 7, username: 'ops.admin', userType: 'admin' }, { mfaAsserted: true })
        );
        expect(req.user._sessionVia).toEqual({ via: 'sso', viaEmployeeId: null });
    });
});

describe('D4 — the admin is re-checked like a password sign-in', () => {
    const cases = [
        ['inactive', (a) => (a.is_active = false), 'admin_inactive'],
        [
            'locked (stored)',
            (a) => (a.locked_until = new Date(Date.now() + 60000).toISOString()),
            'admin_locked',
        ],
        ['access expired', () => mockState.expired.add(7), 'admin_expired'],
    ];

    test('S2 — failed PASSWORD attempts against the username never lock the owner out of SSO', async () => {
        mockState.lockedByAttempts.add('ops.admin');
        const { req } = await callback(
            ssoUser({ id: 7, username: 'ops.admin', userType: 'admin' }, { mfaAsserted: true })
        );
        expect(req.user && req.user.id).toBe(7);
    });
    test.each(cases)('%s → generic refusal + audited reason', async (_n, mutate, reason) => {
        mutate(mockState.admins[7]);
        const { req, res } = await callback(
            ssoUser({ id: 7, username: 'ops.admin', userType: 'admin' }, { mfaAsserted: true })
        );
        expect(req.user).toBeUndefined();
        expect(res.redirected).toBe('/login');
        expect(req.flashes[0][1]).toMatch(
            /La connexion n’a pas abouti.*Contactez .* en indiquant l’heure de la tentative/
        ); // UX-4 (3.23.21)
        expect(denied()[0]).toMatch(new RegExp(reason));
    });

    test('B1 (3.23.20, supersedes A3/A6) — a SuperAdmin is refused whatever its policy, even with IdP MFA', async () => {
        for (const policy of ['local_only', 'any', 'mfa_required']) {
            mockLogs.length = 0;
            mockState.admins[8].auth_policy = policy;
            const { req } = await callback(
                ssoUser({ id: 8, username: 'root', userType: 'admin' }, { mfaAsserted: true })
            );
            expect(req.user).toBeUndefined();
            expect(denied()[0]).toMatch(/superadmin_sso_forbidden/);
        }
    });

    test("A3 — a local admin's 'local_only' cannot be honoured while enforced (treated as 'any')", async () => {
        mockState.admins[7].auth_policy = 'local_only';
        const { req } = await callback(
            ssoUser({ id: 7, username: 'ops.admin', userType: 'admin' }, { mfaAsserted: true })
        );
        expect(req.user && req.user.id).toBe(7);
    });
});

describe('D3b / D6 — the account chooser', () => {
    const employee = (ctx) => ssoUser({ id: 55, username: 'awa', userType: 'employee' }, ctx);

    test('employee SSO with no linked admin is unchanged', async () => {
        mockState.admins[7].linked_employee_id = 999;
        const { req, res } = await callback(employee({ via: 'linked' }));
        expect(req.user && req.user.id).toBe(55);
        expect(res.redirected).toBe('/employee/dashboard');
        expect(actions()).toEqual(['LOGIN_SUCCESS']);
    });

    test('never through a first-time e-mail match or a migration mapping', async () => {
        for (const via of ['email', 'mapping']) {
            mockLogs.length = 0;
            const { req, res } = await callback(employee({ via }));
            expect(req.user && req.user.id).toBe(55);
            expect(res.redirected).toBe('/employee/dashboard');
        }
    });

    test('S4 — never when the employee identity was not linked by a SuperAdmin / onboarding merge', async () => {
        for (const m of ['sso_email', 'migration_mapping', 'unknown', 'legacy', 'delegated_link']) {
            mockLogs.length = 0;
            const { req, res } = await callback(employee({ via: 'linked', linkMethod: m }));
            expect(req.user && req.user.id).toBe(55);
            expect(res.redirected).toBe('/employee/dashboard');
            expect(denied()[0]).toMatch(/admin_link_untrusted/);
        }
    });

    test('S5 — never on an e-mail-like alias match', async () => {
        const { req } = await callback(employee({ via: 'linked', aliasMatch: true }));
        expect(req.user && req.user.id).toBe(55);
        expect(denied()[0]).toMatch(/admin_uid_alias/);
    });

    test('never when admin SSO is off (no provider enforced)', async () => {
        mockState.enforced = false;
        const { req } = await callback(employee({ via: 'linked' }));
        expect(req.user && req.user.id).toBe(55);
    });

    async function offered() {
        const x = await callback(employee({ via: 'linked', mfaAsserted: true }), {
            body: { RelayState: '/reports' },
        });
        expect(x.req.user).toBeUndefined();
        expect(x.res.redirected).toBe('/auth/sso/choose');
        expect(x.req.regenerated).toBe(1);
        const c = x.req.session.ssoChoice;
        expect(c).toEqual(
            expect.objectContaining({
                employeeId: 55,
                adminIds: [7],
                provider: 'saml',
                mfaAsserted: true,
                relay: '/reports',
            })
        );
        expect(typeof c.nonce).toBe('string');
        return c;
    }

    async function post(choice, body) {
        const x = makeReqRes({ body, session: choice ? { ssoChoice: choice } : {} });
        await SsoController.submitChoice(x.req, x.res);
        return x;
    }

    test('GET renders the person and the eligible admin account', async () => {
        const c = await offered();
        const x = makeReqRes({ session: { ssoChoice: c } });
        await SsoController.showChoice(x.req, x.res);
        expect(x.res.rendered.v).toBe('pages/auth/sso-choose-account');
        expect(x.res.rendered.o.personName).toBe('Awa Silva');
        expect(x.res.rendered.o.admins).toEqual([
            { id: 7, username: 'ops.admin', role: 'localadmin' },
        ]);
        expect(x.res.rendered.o.nonce).toBe(c.nonce);
    });

    test('choosing the admin → re-validated, session rotated, signed in as the admin (IdP MFA)', async () => {
        const c = await offered();
        const x = await post(c, { nonce: c.nonce, choice: 'admin:7' });
        expect(x.req.user && x.req.user.id).toBe(7);
        expect(x.req.regenerated).toBe(1);
        expect(x.res.redirected).toBe('/reports');
        expect(mockLogs.find((l) => l.action === 'SSO_LOGIN').details).toMatch(
            /method=linked-person mfa=idp/
        );
    });

    test('choosing the employee → today’s employee sign-in', async () => {
        const c = await offered();
        const x = await post(c, { nonce: c.nonce, choice: 'employee' });
        expect(x.req.user && x.req.user.id).toBe(55);
        expect(x.res.redirected).toBe('/reports');
    });

    test('single use: a replayed POST finds nothing', async () => {
        const c = await offered();
        const first = await post(c, { nonce: c.nonce, choice: 'employee' });
        expect(first.req.session.ssoChoice).toBeUndefined();
        mockLogs.length = 0;
        const replay = await post(null, { nonce: c.nonce, choice: 'admin:7' });
        expect(replay.req.user).toBeUndefined();
        expect(denied()[0]).toMatch(/chooser_invalid/);
    });

    test('a failed attempt spends the choice too (no nonce guessing on one choice)', async () => {
        const c = await offered();
        const x = makeReqRes({
            body: { nonce: 'guess', choice: 'admin:7' },
            session: { ssoChoice: c },
        });
        await SsoController.submitChoice(x.req, x.res);
        expect(x.req.session.ssoChoice).toBeUndefined();
        x.req.body = { nonce: c.nonce, choice: 'admin:7' };
        await SsoController.submitChoice(x.req, x.res);
        expect(x.req.user).toBeUndefined();
    });

    test('expired after 5 minutes', async () => {
        const c = await offered();
        c.at = Date.now() - 5 * 60 * 1000 - 1;
        const x = await post(c, { nonce: c.nonce, choice: 'admin:7' });
        expect(x.req.user).toBeUndefined();
        expect(denied().pop()).toMatch(/chooser_expired/);
        expect(x.req.flashes[0][1]).toMatch(/expiré/);
    });

    test('wrong nonce and a tampered admin id are refused', async () => {
        const c = await offered();
        const a = await post({ ...c }, { nonce: 'forged', choice: 'admin:7' });
        expect(a.req.user).toBeUndefined();
        const b = await post({ ...c }, { nonce: c.nonce, choice: 'admin:8' });
        expect(b.req.user).toBeUndefined();
        expect(denied().filter((d) => /chooser_invalid/.test(d)).length).toBe(2);
    });

    test('re-validated at POST time: link removed or admin locked meanwhile → refused', async () => {
        const c = await offered();
        mockState.admins[7].linked_employee_id = 1;
        const x = await post({ ...c }, { nonce: c.nonce, choice: 'admin:7' });
        expect(x.req.user).toBeUndefined();
        mockState.admins[7].linked_employee_id = 55;
        mockState.admins[7].is_active = false;
        const y = await post({ ...c }, { nonce: c.nonce, choice: 'admin:7' });
        expect(y.req.user).toBeUndefined();
        expect(denied().some((d) => /admin_inactive/.test(d))).toBe(true);
    });

    test('the chooser routes precede /auth/sso/:provider and are not CSRF-exempt', () => {
        const fs = require('fs');
        const path = require('path');
        const { flat } = require('../helpers/flatSource');
        const routes = flat(
            fs.readFileSync(path.join(__dirname, '../../src/routes/index.js'), 'utf8')
        );
        const iChoose = routes.indexOf(
            "router.post('/auth/sso/choose', loginRateLimiter, SsoController.submitChoice)"
        );
        const iProv = routes.indexOf("router.get('/auth/sso/:provider', SsoController.initiate)");
        expect(iChoose).toBeGreaterThan(-1);
        expect(iChoose).toBeLessThan(iProv);
        // server.js exempts only /auth/sso/<p>/callback from CSRF.
        expect(/^\/auth\/sso\/[^/]+\/callback$/.test('/auth/sso/choose')).toBe(false);
    });
});

describe('D5 — the /login/mfa step after an SSO first factor', () => {
    function mfaReq(pending, code = '123456') {
        return makeReqRes({
            body: { code },
            session: { mfaPending: { at: Date.now(), ...pending } },
        });
    }

    test('valid code → signed in as the admin, audit mfa=local, relay honoured', async () => {
        const x = mfaReq({
            id: 7,
            userType: 'admin',
            via: 'sso',
            provider: 'saml',
            method: 'direct',
            relay: '/admins',
            mapped: { oid: 'oid-9' },
        });
        await AuthController.verifyMfaChallenge(x.req, x.res);
        await x.finished;
        expect(x.req.user && x.req.user.id).toBe(7);
        expect(x.res.redirected).toBe('/admins');
        expect(x.req.session.mfaVerifiedInSession).toBe(true); // L1: proven in THIS session
        expect(mockLogs.find((l) => l.action === 'SSO_LOGIN').details).toMatch(/mfa=local/);
    });

    test('the admin became ineligible while on the code screen → refused', async () => {
        mockState.admins[7].is_active = false;
        const x = mfaReq({
            id: 7,
            userType: 'admin',
            via: 'sso',
            provider: 'saml',
            method: 'direct',
        });
        await AuthController.verifyMfaChallenge(x.req, x.res);
        expect(x.req.user).toBeUndefined();
        expect(denied()[0]).toMatch(/admin_inactive/);
    });

    test('linked-person route: the link must still hold', async () => {
        const x = mfaReq({
            id: 7,
            userType: 'admin',
            via: 'sso',
            provider: 'saml',
            method: 'linked-person',
            employeeId: 999,
        });
        await AuthController.verifyMfaChallenge(x.req, x.res);
        expect(x.req.user).toBeUndefined();
        expect(denied()[0]).toMatch(/chooser_invalid/);
    });

    test('A1 — a PASSWORD first factor of a local admin is refused at the MFA step while enforced', async () => {
        const x = mfaReq({ id: 7, userType: 'admin' });
        await AuthController.verifyMfaChallenge(x.req, x.res);
        expect(x.req.user).toBeUndefined();
        expect(x.res.redirected).toBe('/login?breakglass=1');
    });

    test('A6 — the SuperAdmin password + MFA break-glass works while enforced', async () => {
        const x = mfaReq({ id: 8, userType: 'admin' });
        await AuthController.verifyMfaChallenge(x.req, x.res);
        await x.finished;
        expect(x.req.user && x.req.user.id).toBe(8);
    });
});

describe('IdP multi-factor detection (normalized mfaAsserted)', () => {
    test('OIDC / Entra amr and acr', () => {
        expect(AdminSso.mfaFromOidcClaims({ amr: ['pwd', 'mfa'] })).toBe(true);
        expect(AdminSso.mfaFromOidcClaims({ amr: ['mca'] })).toBe(true);
        // S6: two DISTINCT factor classes count; one factor alone never does.
        expect(AdminSso.mfaFromOidcClaims({ amr: ['pwd', 'otp'] })).toBe(true);
        expect(AdminSso.mfaFromOidcClaims({ amr: ['otp', 'fpt'] })).toBe(true);
        expect(AdminSso.mfaFromOidcClaims({ amr: ['rsa'] })).toBe(false);
        expect(AdminSso.mfaFromOidcClaims({ amr: ['sms'] })).toBe(false);
        expect(AdminSso.mfaFromOidcClaims({ amr: ['otp', 'sms'] })).toBe(false); // same class
        expect(AdminSso.mfaFromOidcClaims({ amr: ['pwd', 'kba'] })).toBe(false); // same class
        expect(AdminSso.mfaFromOidcClaims({ amr: ['pwd'] })).toBe(false);
        expect(AdminSso.mfaFromOidcClaims({ acr: '1' })).toBe(false); // Entra v1: "not anonymous"
        expect(
            AdminSso.mfaFromOidcClaims({
                acr: 'http://schemas.openid.net/pape/policies/2007/06/multi-factor',
            })
        ).toBe(true);
        expect(AdminSso.mfaFromOidcClaims({ acr: 'urn:acme:loa:high' })).toBe(false);
        // …unless the operator listed it (sso.mfaAcrValues).
        expect(
            AdminSso.mfaFromOidcClaims({ acr: 'urn:acme:loa:high' }, ['URN:ACME:LOA:HIGH'])
        ).toBe(true);
        expect(AdminSso.mfaFromOidcClaims({})).toBe(false);
        expect(AdminSso.mfaFromOidcContext({ methods: ['otp'] })).toBe(false);
        expect(AdminSso.mfaFromOidcContext({ methods: ['pwd', 'hwk'] })).toBe(true);
    });
    test('SAML AuthnContextClassRef and Entra authnmethodsreferences', () => {
        const withRef = (ref) => ({
            getAssertion: () => ({
                Assertion: {
                    AuthnStatement: [{ AuthnContext: [{ AuthnContextClassRef: [ref] }] }],
                },
            }),
        });
        expect(
            AdminSso.mfaFromSamlProfile(
                withRef('urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport')
            )
        ).toBe(false);
        expect(
            AdminSso.mfaFromSamlProfile(
                withRef('http://schemas.microsoft.com/claims/multipleauthn')
            )
        ).toBe(true);
        expect(AdminSso.mfaFromSamlProfile(withRef('https://refeds.org/profile/mfa'))).toBe(true);
        expect(
            AdminSso.mfaFromSamlProfile({
                'http://schemas.microsoft.com/claims/authnmethodsreferences': [
                    'http://schemas.microsoft.com/ws/2008/06/identity/authenticationmethod/password',
                    'http://schemas.microsoft.com/claims/multipleauthn',
                ],
            })
        ).toBe(true);
        expect(AdminSso.mfaFromSamlProfile({})).toBe(false);
    });
});
