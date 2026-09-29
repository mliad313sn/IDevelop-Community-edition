'use strict';
/**
 * 3.23.20 — AMENDMENT B1 on the two paths that do not go through SsoController:
 *   - the shared strategy tail (config/sso resolveAndFinish): an identity that
 *     resolves to a SuperAdmin is refused BEFORE any side-effect (no identity
 *     stamp, no last-login stamp, no user handed to passport);
 *   - the Entra API bearer: never a SuperAdmin principal, even with a trusted
 *     link and MFA in the token (a local admin in the same shape still passes).
 * Real config/sso + SsoService + AdminSsoService; database and models faked.
 */
const mockState = { subject: 8 };
const mockRuns = [];

jest.mock('../../src/config/database', () => ({
    get: jest.fn(async (sql, p) => {
        const s = String(sql);
        if (/FROM user_identities WHERE sso_provider = \? AND sso_uid = \?/.test(s))
            return p[1] === 'oid-x'
                ? {
                      subject_type: 'admin',
                      subject_id: mockState.subject,
                      link_method: 'superadmin_link',
                  }
                : undefined;
        if (/FROM admins WHERE id = \?/.test(s)) {
            const id = Number(p[0]);
            if (id === 8)
                return {
                    id: 8,
                    username: 'root',
                    role: 'superadmin',
                    is_active: true,
                    locked_until: null,
                    auth_policy: 'any',
                    linked_employee_id: null,
                };
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
        }
        return undefined;
    }),
    all: jest.fn(async () => []),
    run: jest.fn(async (sql, p) => {
        mockRuns.push({ sql: String(sql), p });
        return { changes: 1 };
    }),
}));
jest.mock('../../src/services/LogService', () => ({ log: jest.fn(async () => {}) }));
jest.mock('../../src/models/AdminPermissionModel', () => ({
    getExpiryStateForAdmin: jest.fn(async () => ({ expired: false })),
    findSlugsByAdminId: jest.fn(async () => []),
}));
jest.mock('../../src/models/AdminModel', () => ({
    findWithScopes: jest.fn(async (id) =>
        id === 8 || id === 7
            ? {
                  id,
                  username: id === 8 ? 'root' : 'ops',
                  role: id === 8 ? 'superadmin' : 'localadmin',
              }
            : null
    ),
}));
jest.mock('../../src/models/EmployeeModel', () => ({}));

const ENV_KEYS = ['SSO_ENABLED', 'AZURE_TENANT_ID', 'AZURE_API_CLIENT_ID'];
const saved = {};
let sso;
let bearer;

beforeAll(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.SSO_ENABLED = '1';
    process.env.AZURE_TENANT_ID = '11111111-2222-3333-4444-555555555555';
    process.env.AZURE_API_CLIENT_ID = 'api-client';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    sso = require('../../src/config/sso');
    const used = [];
    sso.configureSso({ use: (name, s) => used.push(s), unuse: jest.fn() });
    warn.mockRestore();
    log.mockRestore();
    bearer = used.find((s) => s && typeof s.verifyToken === 'function');
});

afterAll(() => {
    for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }
});

beforeEach(() => {
    mockRuns.length = 0;
    // Enforcement on (as with an interactive provider) so admin SSO is allowed.
    // (Per test: the jest config restores spies between tests.)
    jest.spyOn(sso, 'isSsoIntended').mockReturnValue(true);
});

function tokenFor() {
    const mapped = { oid: 'oid-x', sub: 'sub-x', email: 'x@corp.example' };
    Object.defineProperty(mapped, '_mfaEvidence', {
        value: { amr: ['pwd', 'mfa'], acr: [] },
        enumerable: false,
    });
    bearer.verifyToken = jest.fn(async () => mapped);
    return { headers: { authorization: 'Bearer aaa.bbb.ccc' } };
}

describe('B1 — the Entra API bearer never yields a SuperAdmin', () => {
    test('the bearer strategy is registered', () => {
        expect(sso.isEntraBearerEnabled()).toBe(true);
        expect(bearer).toBeTruthy();
    });

    test('a token resolving to a SuperAdmin (trusted link, MFA in the token) → null', async () => {
        mockState.subject = 8;
        expect(await sso.authenticateEntraBearer(tokenFor())).toBeNull();
    });

    test('control: the same token shape resolving to a local admin → the admin', async () => {
        mockState.subject = 7;
        const u = await sso.authenticateEntraBearer(tokenFor());
        expect(u && u.id).toBe(7);
        expect(u.userType).toBe('admin');
    });
});

describe('B1 — the strategy tail refuses a SuperAdmin before any side-effect', () => {
    function finish(mapped) {
        return new Promise((resolve) =>
            sso._resolveAndFinishForTests('saml', mapped, (err, user, info) =>
                resolve({ err, user, info })
            )
        );
    }

    test('SuperAdmin identity → no user, reason superadmin_sso_forbidden, nothing stamped', async () => {
        mockState.subject = 8;
        const r = await finish({ oid: 'oid-x' });
        expect(r.err).toBeNull();
        expect(r.user).toBe(false);
        expect(r.info).toEqual({ code: 'superadmin_sso_forbidden', adminId: 8 });
        expect(mockRuns.filter((x) => /UPDATE|INSERT/i.test(x.sql))).toEqual([]);
    });

    test('control: a local admin identity is handed on (the controller then applies its checks)', async () => {
        mockState.subject = 7;
        const r = await finish({ oid: 'oid-x' });
        expect(r.user && r.user.id).toBe(7);
    });
});
