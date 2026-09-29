'use strict';
/**
 * 3.23.19 — security committee re-verification: N3 (SSO settings off the generic
 * handler + acr validation), N5 (across-addresses slowdown, not a lock), N6
 * (the enrolment code rendered once, never stored in flash/session), and the
 * lows (dummy bcrypt at the SuperAdmin's cost; S5 residual on SAML).
 */
const mockDb = {
    get: jest.fn(async () => undefined),
    all: jest.fn(async () => []),
    run: jest.fn(async () => ({ changes: 1 })),
    runTransaction: jest.fn(async (fn) => fn()),
};
jest.mock('../../src/config/database', () => mockDb);
const mockLogs = [];
jest.mock('../../src/services/LogService', () => ({
    log: jest.fn(async (e) => {
        mockLogs.push(e);
    }),
}));

describe('N3 — SSO settings are never written through the generic settings handler', () => {
    let AppSettingsModel;
    let C;
    beforeAll(() => {
        AppSettingsModel = require('../../src/models/AppSettingsModel');
        C = require('../../src/controllers/AppSettingsController');
    });
    async function post(user, setting, value) {
        jest.spyOn(AppSettingsModel, 'findAll').mockResolvedValue([setting]);
        const upd = jest.spyOn(AppSettingsModel, 'update').mockResolvedValue();
        const flashes = [];
        let to = null;
        await C.update(
            {
                user,
                body: { id: setting.id, settingValue: value },
                flash: (t, m) => flashes.push([t, m]),
                ip: '1',
                get: () => '',
            },
            { redirect: (u) => (to = u) }
        );
        const wrote = upd.mock.calls.length > 0;
        upd.mockRestore();
        return { flashes, to, wrote };
    }
    const DELEGATE = {
        id: 5,
        userType: 'admin',
        role: 'localadmin',
        permissions: ['manage_app_settings'],
    };
    const SUPER = { id: 1, userType: 'admin', role: 'superadmin', permissions: [] };

    test.each([
        ['sso.mfaAcrValues', '1'],
        ['sso.enabled', 'true'],
        ['sso.saml.idpIssuer', 'https://evil.example'],
        ['ssoDisablesLocalPassword', 'true'],
    ])(
        '%s cannot be set by a delegated admin — nor by a SuperAdmin on this page',
        async (key, value) => {
            const s = {
                id: 9,
                settingKey: key,
                settingType: 'string',
                category: 'sso',
                description: '',
            };
            for (const u of [DELEGATE, SUPER]) {
                const r = await post(u, s, value);
                expect(r.wrote).toBe(false);
                expect(r.flashes[0][0]).toBe('error');
            }
        }
    );

    test('a key named sso.* is refused even if filed in another category', async () => {
        const r = await post(
            DELEGATE,
            {
                id: 3,
                settingKey: 'sso.mfaAcrValues',
                settingType: 'string',
                category: 'general',
                description: '',
            },
            '1'
        );
        expect(r.wrote).toBe(false);
    });

    test('an ordinary setting is still written by a delegate', async () => {
        const r = await post(
            DELEGATE,
            {
                id: 4,
                settingKey: 'readinessThreshold',
                settingType: 'number',
                category: 'readiness',
                description: '',
            },
            '75'
        );
        expect(r.wrote).toBe(true);
    });
});

describe('N3 — sso.mfaAcrValues accepts URIs or explicit names only', () => {
    const S = require('../../src/services/SsoSettingsService');
    test.each([['1'], ['0'], ['2'], ['42'], ['ab'], ['has space'], ['urn:ok, 1']])(
        'refuses %p',
        (v) => {
            expect(S.validateMfaAcrValues(v).ok).toBe(false);
        }
    );
    test.each([
        ['urn:acme:loa:high'],
        ['https://refeds.org/profile/mfa'],
        ['acme-mfa'],
        ['urn:a:b, https://x.example/mfa'],
    ])('accepts %p', (v) => {
        expect(S.validateMfaAcrValues(v).ok).toBe(true);
    });
    test('save() refuses the WHOLE form before writing anything', async () => {
        const AppSettingsModel = require('../../src/models/AppSettingsModel');
        const set = jest.spyOn(AppSettingsModel, 'setValue').mockResolvedValue();
        await expect(S.save({ enabled: '1', mfaAcrValues: '1' }, 1)).rejects.toMatchObject({
            code: 'sso_mfa_acr_invalid',
        });
        expect(set).not.toHaveBeenCalled();
        set.mockRestore();
    });
    test('a bare number never counts as MFA even if it reached the setting', () => {
        const AdminSso = require('../../src/services/AdminSsoService');
        expect(AdminSso.mfaFromEvidence({ acr: ['1'] }, ['1'])).toBe(false);
    });
});

describe('N5 — across-addresses slowdown on a name (never a lock) + SuperAdmin alert', () => {
    let rl;
    beforeAll(() => {
        jest.doMock('../../src/services/AdminSsoService', () => ({ isEnforced: () => true }));
        jest.doMock('../../src/models/AppSettingsModel', () => ({ getValue: async (k, d) => d }));
        jest.doMock('../../src/models/LoginAttemptModel', () => ({
            getFailedAttemptsByIP: jest.fn(async () => 0),
            getFailedAttemptsCount: jest.fn(async () => 99),
        }));
        rl = require('../../src/middleware/rateLimiter');
    });
    function lockoutDelay(name, ip) {
        const delays = [];
        const spy = jest.spyOn(global, 'setTimeout').mockImplementation((fn, ms) => {
            delays.push(ms);
            fn();
            return 0;
        });
        return new Promise((resolve) =>
            rl.checkAccountLockout(
                { method: 'POST', body: { username: name }, ip, get: () => '', flash: () => {} },
                {
                    redirect: (to) => {
                        spy.mockRestore();
                        resolve({ blocked: to, delay: delays[0] || 0 });
                    },
                },
                () => {
                    spy.mockRestore();
                    resolve({ passed: true, delay: delays[0] || 0 });
                }
            )
        );
    }

    test('10 failures spread over 10 addresses → the 11th attempt from a NEW address waits ≥ 5 s; nobody is locked', async () => {
        for (let i = 0; i < 10; i++) await rl.noteEnforcedFailure('spread.name', `10.50.0.${i}`);
        const r = await lockoutDelay('spread.name', '10.50.1.1');
        expect(r.passed).toBe(true); // a slowdown, never a lock
        expect(r.delay).toBe(5000);
        expect(rl.accountSlowdownMs(9)).toBe(0);
        expect(rl.accountSlowdownMs(11)).toBe(10000);
        expect(rl.accountSlowdownMs(100)).toBe(60000);
    });

    test('identical for a non-existent name and a SuperAdmin name', async () => {
        mockDb.get.mockImplementation(async (sql, p) =>
            /role = 'superadmin'/.test(sql) && p[0] === 'root.super'
                ? { id: 1, username: 'root.super' }
                : undefined
        );
        for (let i = 0; i < 12; i++) {
            await rl.noteEnforcedFailure('root.super', `10.60.0.${i}`);
            await rl.noteEnforcedFailure('ghost.name', `10.61.0.${i}`);
        }
        const a = await lockoutDelay('root.super', '10.62.0.1');
        const b = await lockoutDelay('ghost.name', '10.62.0.2');
        expect(a.delay).toBe(b.delay);
        expect(a.delay).toBe(20000);
        // the CRITICAL alert names the SuperAdmin only (audit, asynchronous)
        await new Promise((r) => setImmediate(r));
        const alerts = mockLogs.filter((l) => l.action === 'SUPERADMIN_PASSWORD_ATTACK');
        expect(alerts.length).toBeGreaterThanOrEqual(1);
        expect(alerts.every((l) => l.adminId === 1)).toBe(true);
    });
});

describe('N6 — the enrolment code is rendered once, never stored in flash or session', () => {
    test('the route is SuperAdmin-guarded and matches numeric ids (a lost backslash broke it once)', () => {
        const { flat } = require('../helpers/flatSource');
        const src = flat(
            require('fs').readFileSync(
                require('path').join(__dirname, '../../src/routes/index.js'),
                'utf8'
            )
        );
        expect(src).toContain(
            "router.post('/admins/:id(\\\\d+)/mfa-enrol-code', requireSuperAdmin, require('../utils/asyncHandler')(SsoController.issueEnrolCode))"
        );
    });

    test('rendered in the response with no-store; flash and session untouched', async () => {
        jest.resetModules();
        jest.doMock('../../src/services/AdminSsoService', () => ({
            issueEnrolCode: jest.fn(async () => ({
                ok: true,
                code: 'ABCDEFGHJK',
                username: 'ops',
                ttlHours: 24,
            })),
        }));
        const SsoController = require('../../src/controllers/SsoController');
        const flashes = [];
        const session = {};
        const out = {};
        await SsoController.issueEnrolCode(
            {
                params: { id: '7' },
                user: { id: 1, role: 'superadmin', userType: 'admin' },
                flash: (...a) => flashes.push(a),
                session,
            },
            {
                set: (k, v) => (out.header = [k, v]),
                render: (view, locals) => Object.assign(out, { view, locals }),
                redirect: () => {},
            }
        );
        expect(out.view).toBe('pages/admins/enrol-code-issued');
        expect(out.locals.code).toBe('ABCDEFGHJK');
        expect(out.header).toEqual(['Cache-Control', 'no-store']);
        expect(flashes).toEqual([]);
        expect(JSON.stringify(session)).not.toContain('ABCDEFGHJK');
        jest.resetModules();
    });
});

describe('Lows', () => {
    test('dummy bcrypt runs at the SuperAdmins’ highest cost for a refused name', async () => {
        jest.resetModules();
        const bcrypt = require('bcrypt');
        const cost12 = bcrypt.hashSync('x', 12);
        jest.doMock('../../src/services/AdminSsoService', () => ({ isEnforced: () => true }));
        jest.doMock('../../src/models/AdminModel', () => ({
            findByUsername: jest.fn(async () => null),
            findById: jest.fn(async () => null),
        }));
        jest.doMock('../../src/models/EmployeeModel', () => ({
            findByUsername: jest.fn(async () => null),
        }));
        jest.doMock('../../src/middleware/rateLimiter', () => ({
            recordLoginAttempt: jest.fn(async () => {}),
            noteEnforcedFailure: jest.fn(async () => {}),
            clearEnforcedFailures: jest.fn(),
        }));
        mockDb.all.mockImplementation(async (sql) =>
            /role = 'superadmin'/.test(sql) ? [{ password_hash: cost12 }] : []
        );
        const auth = require('../../src/middleware/auth');
        const spy = jest.spyOn(require('bcrypt'), 'compare');
        const ctx = { ip: '1', get: () => '' };
        await auth._enforcedPasswordLogin({}, 'nobody', 'x', ctx); // starts the background refresh
        await new Promise((r) => setImmediate(r));
        spy.mockClear();
        await auth._enforcedPasswordLogin({}, 'nobody', 'x', ctx);
        expect(String(spy.mock.calls[0][1])).toMatch(/^\$2[aby]?\$12\$/);
        spy.mockRestore();
        mockDb.all.mockImplementation(async () => []);
        jest.resetModules();
    }, 30000);

    test('S5 residual — SAML admin matched on an e-mail NameID with no immutable id → unstableUid', async () => {
        jest.resetModules();
        const S = require('../../src/services/SsoService');
        mockDb.get.mockImplementation(async (sql, p) => {
            if (/FROM user_identities WHERE sso_provider = \? AND sso_uid = \?/.test(sql))
                return p[1] === 'ops@corp.example'
                    ? { subject_type: 'admin', subject_id: 7, link_method: 'superadmin_link' }
                    : undefined;
            if (/FROM admins WHERE id = \? AND is_active = true/.test(sql))
                return { id: 7, username: 'ops', role: 'localadmin' };
            return undefined;
        });
        const t1 = {};
        await S.resolveIdentity('saml', { sub: 'ops@corp.example' }, { trace: t1 });
        expect(t1.unstableUid).toBe(true);
        const persistent = { sub: 'ops@corp.example' };
        Object.defineProperty(persistent, 'nameIdPersistent', { value: true });
        const t2 = {};
        await S.resolveIdentity('saml', persistent, { trace: t2 });
        expect(t2.unstableUid).toBe(false);
        const t3 = {};
        await S.resolveIdentity('entra', { sub: 'ops@corp.example' }, { trace: t3 });
        expect(t3.unstableUid).toBe(false); // only SAML NameIDs are in scope
        mockDb.get.mockImplementation(async () => undefined);
    });
});

describe('F1 — no bulk writer imports SSO settings; the acr list is re-validated on read', () => {
    test('JSON system import skips sso.* / SSO_* / category sso / ssoDisablesLocalPassword and reports them', async () => {
        jest.resetModules();
        const writes = [];
        mockDb.get.mockImplementation(async (sql, p) =>
            /FROM app_settings WHERE setting_key/.test(sql)
                ? p[0] === 'enabled'
                    ? { id: 3, category: 'sso' } // an existing SSO row with an innocuous key
                    : p[0] === 'readinessThreshold'
                      ? { id: 1, category: 'readiness' }
                      : undefined
                : undefined
        );
        mockDb.run.mockImplementation(async (sql, p) => {
            if (/app_settings/.test(sql)) writes.push([sql.replace(/\s+/g, ' '), p]);
            return { changes: 1 };
        });
        const S = require('../../src/services/UnifiedJsonService');
        const data = {
            appSettings: [
                { key: 'sso.mfaAcrValues', value: '1' },
                { key: 'SSO_OIDC_ISSUER', value: 'https://evil.example' },
                { key: 'sso.enabled', value: 'true' },
                { key: 'ssoDisablesLocalPassword', value: 'true' },
                { key: 'harmless', value: 'x', category: 'sso' },
                { key: 'enabled', value: 'false' },
                { key: 'readinessThreshold', value: '70' },
            ],
        };
        const r = await S.importSystemFromJson(data, {
            id: 42,
            userType: 'admin',
            role: 'localadmin',
            permissions: ['import_data'],
        });
        expect(r.results.appSettingsSkippedSso.sort()).toEqual(
            [
                'SSO_OIDC_ISSUER',
                'enabled',
                'harmless',
                'sso.enabled',
                'sso.mfaAcrValues',
                'ssoDisablesLocalPassword',
            ].sort()
        );
        expect(r.results.appSettings).toBe(1);
        expect(writes).toHaveLength(1);
        expect(writes[0][1]).toEqual(['70', 'readinessThreshold']);
        // the dry-run says so up front
        const pv = await S.previewSystemFromJson(data);
        expect(pv.counts.appSettings.skippedSso).toEqual(
            expect.arrayContaining(['sso.mfaAcrValues', 'SSO_OIDC_ISSUER'])
        );
        mockDb.get.mockImplementation(async () => undefined);
        mockDb.run.mockImplementation(async () => ({ changes: 1 }));
        jest.resetModules();
    });

    test('operatorAcrValues drops digits-only and password class refs, whatever wrote the row', async () => {
        jest.resetModules();
        jest.dontMock('../../src/services/AdminSsoService');
        jest.doMock('../../src/models/AppSettingsModel', () => ({
            getValue: async () =>
                '1, 0, urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport, urn:oasis:names:tc:SAML:2.0:ac:classes:Password, pwd, urn:acme:loa:high',
        }));
        const A = require('../../src/services/AdminSsoService');
        expect(await A.operatorAcrValues()).toEqual(['urn:acme:loa:high']);
        expect(await A.mfaAsserted({ amr: ['pwd'], acr: ['1'] })).toBe(false);
        expect(
            await A.mfaAsserted({
                acr: ['urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport'],
            })
        ).toBe(false);
        expect(await A.mfaAsserted({ acr: ['urn:acme:loa:high'] })).toBe(true);
        jest.resetModules();
    });

    test('the SSO page refuses a password class ref too', () => {
        jest.resetModules();
        jest.dontMock('../../src/services/AdminSsoService');
        const S = require('../../src/services/SsoSettingsService');
        expect(
            S.validateMfaAcrValues(
                'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport'
            ).ok
        ).toBe(false);
        expect(S.validateMfaAcrValues('pwd').ok).toBe(false);
    });
});

describe('L1 — the MFA hold is derived from the session origin, not only the flag', () => {
    function load(active) {
        jest.resetModules();
        jest.doMock('../../src/models/AppSettingsModel', () => ({ getValue: async () => false }));
        jest.doMock('../../src/services/MfaService', () => ({
            isActive: async () => active,
            mfaUserType: () => 'admin',
        }));
        return require('../../src/middleware/mfaEnforcement').enforceMfaEnrollment;
    }
    const run = async (mw, session, user = { id: 7, userType: 'admin' }) => {
        const out = {};
        await mw(
            { path: '/dashboard', session, user, isAuthenticated: () => true, flash: () => {} },
            { redirect: (u) => (out.to = u), status: () => ({ json: () => {} }) },
            () => (out.next = true)
        );
        return out;
    };
    test.each([['sso'], ['breakglass']])(
        'via %s, no MFA proven here, no local MFA → held even without the flag',
        async (via) => {
            const mw = load(false);
            expect(
                (await run(mw, { passport: { user: { id: 7, userType: 'admin', via } } })).to
            ).toBe('/v2/uam/mfa/setup');
        }
    );
    test('second factor proven in this session (IdP MFA, /login/mfa, /mfa/verify) → free', async () => {
        const mw = load(false);
        expect(
            (
                await run(mw, {
                    mfaVerifiedInSession: true,
                    passport: { user: { id: 7, userType: 'admin', via: 'sso' } },
                })
            ).next
        ).toBe(true);
    });
    test('local MFA active → free; an ordinary password admin session (no via) → policy as before', async () => {
        expect(
            (
                await run(load(true), {
                    passport: { user: { id: 7, userType: 'admin', via: 'sso' } },
                })
            ).next
        ).toBe(true);
        expect(
            (await run(load(false), { passport: { user: { id: 7, userType: 'admin' } } })).next
        ).toBe(true);
    });
    test('an employee SSO session is never held', async () => {
        const mw = load(false);
        expect(
            (
                await run(
                    mw,
                    { passport: { user: { id: 55, userType: 'employee', via: 'sso' } } },
                    { id: 55, userType: 'employee' }
                )
            ).next
        ).toBe(true);
    });
});
