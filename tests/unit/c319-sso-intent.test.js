'use strict';
/**
 * 3.23.19 — security committee S5 (alias trace), S9 (identical IP-block
 * refusal), S2 (no global lock while enforced; (username, IP) delay) and S12
 * (enforcement follows the SSO switch intent). Real modules, mocked database.
 */
const mockDb = {
    get: jest.fn(),
    all: jest.fn(async () => []),
    run: jest.fn(async () => ({ changes: 1 })),
};
jest.mock('../../src/config/database', () => mockDb);
jest.mock('../../src/services/LogService', () => ({ log: jest.fn(async () => {}) }));

describe('S5 — SsoService.resolveIdentity reports an e-mail-like alias match', () => {
    const S = require('../../src/services/SsoService');
    beforeEach(() => mockDb.get.mockReset());

    function linkedOn(uidWanted, method = 'superadmin_link') {
        mockDb.get.mockImplementation(async (sql, p) => {
            if (/FROM user_identities WHERE sso_provider = \? AND sso_uid = \?/.test(sql))
                return p[1] === uidWanted
                    ? { subject_type: 'admin', subject_id: 7, link_method: method }
                    : undefined;
            if (/FROM admins WHERE id = \? AND is_active = true/.test(sql))
                return { id: 7, username: 'ops', role: 'localadmin' };
            return undefined;
        });
    }

    test('matched on the UPN while the assertion carries another objectId → aliasMatch', async () => {
        linkedOn('ops@corp.example');
        const trace = {};
        const p = await S.resolveIdentity(
            'saml',
            { oid: 'OID-NEW', sub: 'ops@corp.example' },
            { trace }
        );
        expect(p).toEqual(expect.objectContaining({ kind: 'admin', id: 7 }));
        expect(trace.aliasMatch).toBe(true);
        expect(trace.linkMethod).toBe('superadmin_link');
    });

    test('matched on the objectId (the primary) → no alias', async () => {
        linkedOn('oid-new');
        const trace = {};
        await S.resolveIdentity('saml', { oid: 'OID-NEW', sub: 'ops@corp.example' }, { trace });
        expect(trace.aliasMatch).toBe(false);
    });

    test('an e-mail NameID that IS the only id → no alias (nothing else asserted)', async () => {
        linkedOn('ops@corp.example', 'unknown');
        const trace = {};
        await S.resolveIdentity('saml', { sub: 'ops@corp.example' }, { trace });
        expect(trace.aliasMatch).toBe(false);
        expect(trace.linkMethod).toBe('unknown');
    });

    test('the legacy inline column reports link method "legacy"', async () => {
        mockDb.get.mockImplementation(async (sql) => {
            if (/FROM admins WHERE auth_provider = \?/.test(sql))
                return { id: 7, username: 'ops', role: 'localadmin' };
            return undefined;
        });
        const trace = {};
        await S.resolveIdentity('saml', { oid: 'x' }, { trace });
        expect(trace.linkMethod).toBe('legacy');
    });
});

describe('S2/S9 — the login lockout while SSO is enforced', () => {
    let enforced = true;

    let perIp = 0;
    let rl;
    beforeAll(() => {
        jest.doMock('../../src/services/AdminSsoService', () => ({ isEnforced: () => enforced }));
        jest.doMock('../../src/models/LoginAttemptModel', () => ({
            getFailedAttemptsByIP: jest.fn(async () => perIp),
            getFailedAttemptsCount: jest.fn(async () => 99), // a GLOBAL lock would fire
        }));
        jest.doMock('../../src/models/AppSettingsModel', () => ({ getValue: async (k, d) => d }));
        mockDb.get.mockResolvedValue(undefined);
        rl = require('../../src/middleware/rateLimiter');
    });
    function run(username) {
        return new Promise((resolve) => {
            const flashes = [];
            const req = {
                method: 'POST',
                body: { username },
                ip: '10.0.0.1',
                get: () => '',
                flash: (t, m) => flashes.push([t, m]),
            };
            rl.checkAccountLockout(req, { redirect: (to) => resolve({ to, flashes }) }, () =>
                resolve({ next: true, flashes })
            );
        });
    }

    test('S2 — no global account lock while enforced (the attempt counter is ignored)', async () => {
        perIp = 0;
        const r = await run('root');
        expect(r.next).toBe(true);
    });

    test('S2 — progressive delay from the 3rd (username, IP) failure, capped at 30 s', () => {
        expect(rl.progressiveDelayMs(2)).toBe(0);
        expect(rl.progressiveDelayMs(3)).toBe(1000);
        expect(rl.progressiveDelayMs(4)).toBe(2000);
        expect(rl.progressiveDelayMs(50)).toBe(30000);
    });

    test('S9 — an IP block reads exactly like any refused password sign-in (one message)', async () => {
        // While enforced the IP block reads the throttle's IP counter.
        for (let i = 0; i < 10; i++) await rl.noteEnforcedFailure(`someone.${i}`, '10.0.0.1');
        const r = await run('anyone');
        expect(r.to).toBe('/login?breakglass=1');
        expect(r.flashes).toEqual([
            [
                'error',
                'Connexion par mot de passe non autorisée ou identifiants invalides. Utilisez la connexion SSO.',
            ],
        ]);
    });

    test('not enforced → the account lock applies (hard lock = ADMIN accounts)', async () => {
        enforced = false;
        perIp = 0;
        // Only an administrator account is hard-locked; staff and unknown names
        // are soft-locked (slowed, never refused). See accountLockoutPolicy.test.js.
        mockDb.get.mockImplementation(async (sql) =>
            /FROM admins WHERE lower\(username\)/.test(sql)
                ? { id: 1, username: 'root' }
                : undefined
        );
        try {
            const r = await run('root');
            expect(r.to).toBe('/login');
            expect(r.flashes[0][0]).toBe('error');
        } finally {
            enforced = true;
            mockDb.get.mockResolvedValue(undefined);
        }
    });
});
describe('Residual leak closed — the break-glass throttle is identical for every identifier', () => {
    // Runs on the rateLimiter + AdminSsoService doubles of the block above
    // (enforced = true), with the REAL local-strategy refusal path.
    let rl;
    let epl;
    beforeAll(() => {
        jest.doMock('../../src/models/AdminModel', () => ({
            findByUsername: jest.fn(async (u) =>
                u === 'root'
                    ? {
                          id: 1,
                          username: 'root',
                          role: 'superadmin',
                          isActive: true,
                          passwordHash: require('bcrypt').hashSync('right', 10),
                      }
                    : null
            ),
            findById: jest.fn(async () => null),
            findWithScopes: jest.fn(async () => null),
        }));
        jest.doMock('../../src/models/EmployeeModel', () => ({
            findByUsername: jest.fn(async () => null),
        }));
        rl = require('../../src/middleware/rateLimiter');
        epl = require('../../src/middleware/auth')._enforcedPasswordLogin;
    });

    // One POST /login: the lockout middleware (records the delay it waits),
    // then — when not blocked — the strategy refusal (which feeds the throttle).
    async function attempt(name, ip = '10.9.9.9') {
        const delays = [];
        const spy = jest.spyOn(global, 'setTimeout').mockImplementation((fn, ms) => {
            delays.push(ms);
            fn();
            return 0;
        });
        let passed = false;
        let to = null;
        await new Promise((resolve) =>
            rl.checkAccountLockout(
                { method: 'POST', body: { username: name }, ip, get: () => '', flash: () => {} },
                {
                    redirect: (u) => {
                        to = u;
                        resolve();
                    },
                },
                () => {
                    passed = true;
                    resolve();
                }
            )
        );
        spy.mockRestore();
        let user = null;
        if (passed) [user] = await epl({}, name, 'wrong-password', { ip, get: () => '' });
        return { delay: delays.length ? delays[0] : 0, passed, to, user };
    }

    test('a SuperAdmin name and a non-existent name get the SAME delay sequence; nobody is locked', async () => {
        const seqs = {};
        const ips = { root: '10.9.9.1', 'no.such.person': '10.9.9.2' };
        for (const name of Object.keys(ips)) {
            seqs[name] = [];
            for (let i = 0; i < 8; i++) {
                const r = await attempt(name, ips[name]);
                expect(r.passed).toBe(true); // never an account lock (S2)
                expect(r.user).toBe(false);
                seqs[name].push(r.delay);
            }
        }
        expect(seqs.root).toEqual([0, 0, 0, 1000, 2000, 4000, 8000, 16000]);
        expect(seqs['no.such.person']).toEqual(seqs.root);
        // capped at 30 s
        expect(rl.progressiveDelayMs(40)).toBe(30000);
    }, 60000);

    test('the throttle is keyed on the normalized identifier AND the address', async () => {
        for (let i = 0; i < 4; i++) await attempt(' GHOST ', '10.9.9.3');
        expect(rl.enforcedFailureCount('ghost', '10.9.9.3', 15)).toBe(4);
        expect(rl.enforcedFailureCount('ghost', '10.1.1.1', 15)).toBe(0);
    }, 60000);

    test('IP block: spraying 10 non-existent names and the SuperAdmin name 10 times trip it at the SAME attempt; other IPs unaffected', async () => {
        const firstBlocked = async (ip, nameAt) => {
            for (let i = 1; i <= 12; i++) {
                const r = await attempt(nameAt(i), ip);
                if (!r.passed) {
                    expect(r.to).toBe('/login?breakglass=1');
                    return i;
                }
            }
            return null;
        };
        const spray = await firstBlocked('10.7.7.1', (i) => `nobody.${i}`);
        const superName = await firstBlocked('10.7.7.2', () => 'root');
        expect(spray).toBe(11); // default policy: 5 attempts x 2 = 10 failures per address
        expect(superName).toBe(spray);
        // a third address is independent of both
        const other = await attempt('root', '10.7.7.3');
        expect(other.passed).toBe(true);
        expect(rl.enforcedIpFailureCount('10.7.7.3', 15)).toBe(1);
    }, 120000);
});

describe('S12/N4 — enforcement = SSO switch + an INTERACTIVE provider intended (not provider health)', () => {
    const KEYS = [
        'SSO_ENABLED',
        'AZURE_TENANT_ID',
        'AZURE_CLIENT_ID',
        'AZURE_CLIENT_SECRET',
        'AZURE_API_CLIENT_ID',
        'SSO_ENTRA_REDIRECT_URL',
        'SSO_REDIRECT_URL',
        'OIDC_CLIENT_ID',
        'SAML_ENTRY_POINT',
        'GOOGLE_CLIENT_ID',
    ];
    let saved;
    beforeEach(() => {
        jest.resetModules();
        saved = {};
        for (const k of KEYS) {
            saved[k] = process.env[k];
            delete process.env[k];
        }
    });
    afterEach(() => {
        for (const k of KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    });
    const fakePassport = () => ({ use: jest.fn(), unuse: jest.fn() });

    test('interactive provider configured but failing to register → enforced, degraded, logged critical', () => {
        process.env.SSO_ENABLED = '1';
        process.env.AZURE_CLIENT_ID = 'c'; // no tenant/secret/redirect → cannot register
        const err = jest.spyOn(console, 'error').mockImplementation(() => {});
        const sso = require('../../src/config/sso');
        sso.configureSso(fakePassport());
        expect(sso.isConfigured()).toBe(false);
        expect(sso.isSsoIntended()).toBe(true);
        expect(sso.isDegraded()).toBe(true);
        expect(err.mock.calls.some((c) => /\[CRITICAL\]/.test(String(c[0])))).toBe(true);
        err.mockRestore();
    });

    test('N4 — a BEARER-ONLY site (Power BI API token) is NOT enforced', () => {
        process.env.SSO_ENABLED = '1';
        process.env.AZURE_TENANT_ID = '11111111-2222-3333-4444-555555555555';
        process.env.AZURE_API_CLIENT_ID = 'api-client';
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const log = jest.spyOn(console, 'log').mockImplementation(() => {});
        const sso = require('../../src/config/sso');
        sso.configureSso(fakePassport());
        expect(sso.isEntraBearerEnabled()).toBe(true);
        expect(sso.isSsoIntended()).toBe(false);
        warn.mockRestore();
        log.mockRestore();
    });

    test('N4 — SSO switch on with NO provider configured at all → not enforced', () => {
        process.env.SSO_ENABLED = '1';
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const sso = require('../../src/config/sso');
        sso.configureSso(fakePassport());
        expect(sso.isSsoIntended()).toBe(false);
        warn.mockRestore();
    });

    test('an undecryptable interactive secret still counts as configured (fail closed)', async () => {
        jest.doMock('../../src/services/SsoSettingsService', () => ({
            getOverrides: async () => ({
                SSO_ENABLED: '1',
                __undecryptable: ['OIDC_CLIENT_SECRET'],
            }),
        }));
        const err = jest.spyOn(console, 'error').mockImplementation(() => {});
        const sso = require('../../src/config/sso');
        await sso.reloadSso(fakePassport());
        expect(sso.isSsoIntended()).toBe(true);
        err.mockRestore();
    });

    test('settings unreadable after SSO was on → stays enforced (last known intent)', async () => {
        let fail = false;
        jest.doMock('../../src/services/SsoSettingsService', () => ({
            getOverrides: async () => {
                if (fail) throw new Error('db down');
                return { SSO_ENABLED: '1', OIDC_CLIENT_ID: 'x' };
            },
        }));
        const err = jest.spyOn(console, 'error').mockImplementation(() => {});
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const sso = require('../../src/config/sso');
        await sso.reloadSso(fakePassport());
        expect(sso.isSsoIntended()).toBe(true);
        fail = true;
        await sso.reloadSso(fakePassport());
        expect(sso.isSsoIntended()).toBe(true);
        err.mockRestore();
        warn.mockRestore();
    });

    test('boot: the very FIRST settings read fails → decided from .env (interactive provider there → enforced)', async () => {
        jest.doMock('../../src/services/SsoSettingsService', () => ({
            getOverrides: async () => {
                throw new Error('db down at boot');
            },
        }));
        process.env.SSO_ENABLED = '1';
        process.env.SAML_ENTRY_POINT = 'https://idp.example/sso';
        const err = jest.spyOn(console, 'error').mockImplementation(() => {});
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const sso = require('../../src/config/sso');
        await sso.reloadSso(fakePassport());
        expect(sso.isSsoIntended()).toBe(true);
        delete process.env.SAML_ENTRY_POINT;
        err.mockRestore();
        warn.mockRestore();
    });

    test('SSO off → not enforced', () => {
        const sso = require('../../src/config/sso');
        sso.configureSso(fakePassport());
        expect(sso.isSsoIntended()).toBe(false);
    });
});
