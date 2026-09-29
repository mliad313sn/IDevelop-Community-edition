'use strict';
/**
 * WAVE 1 — de-authorization of API keys owned by a deactivated admin.
 *
 * THE HOLE: an owned key runs AS its owner (middleware/apiAuth resolves the
 * owning admin and hands their RBAC clearance to the request). `auth.js`
 * deserializeUser kills a live browser session the moment `admins.is_active`
 * flips false — but the API-key path tested only `if (!admin)`, so a deactivated
 * or soft-deleted owner's key kept returning org-wide HR data indefinitely.
 * On the live install the ONLY existing key was owned by
 * `_deleted_delegate_roles_87` (is_active = false).
 *
 * DB-free: the service and the model are mocked so this runs in CI.
 */

jest.mock('../../src/config/sso', () => ({
    looksLikeJwt: () => false,
    isEntraBearerEnabled: () => false,
    authenticateEntraBearer: async () => null,
}));
jest.mock('../../src/services/ApiKeyService', () => ({ validate: jest.fn() }));
jest.mock('../../src/models/AdminModel', () => ({ findWithScopes: jest.fn() }));
jest.mock('../../src/config/app', () => ({ apiKey: 'env-shared-key-not-used-here', env: 'test' }));

const ApiKeyService = require('../../src/services/ApiKeyService');
const AdminModel = require('../../src/models/AdminModel');
const { requireApiKey } = require('../../src/middleware/apiAuth');

function mkRes() {
    const res = { statusCode: null, body: null };
    res.status = (c) => {
        res.statusCode = c;
        return res;
    };
    res.json = (b) => {
        res.body = b;
        return res;
    };
    return res;
}
const mkReq = (key) => ({ headers: { 'x-api-key': key }, query: {} });

describe('apiAuth — an API key dies with its owner', () => {
    beforeEach(() => {
        ApiKeyService.validate.mockReset();
        AdminModel.findWithScopes.mockReset();
    });

    test("a DEACTIVATED owner's key is refused with 403 and never becomes a principal", async () => {
        ApiKeyService.validate.mockResolvedValue({
            id: 9,
            label: 'test',
            scope: 'powerbi.read',
            ownerAdminId: 87,
        });
        // The service's own JOIN normally makes this unreachable; the middleware
        // guard is the second line (the account can be disabled between queries).
        AdminModel.findWithScopes.mockResolvedValue({
            id: 87,
            username: '_deleted_87',
            role: 'localadmin',
            isActive: false,
            scopes: [],
        });

        const req = mkReq('idv_deadowner');
        const res = mkRes();
        const next = jest.fn();
        await requireApiKey(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
        expect(res.body.error).toMatch(/deactivated/i);
        expect(req.user).toBeUndefined(); // no clearance was ever attached
    });

    test('is_active = 0 (integer form) is treated the same as false', async () => {
        ApiKeyService.validate.mockResolvedValue({
            id: 9,
            label: 'test',
            scope: 'powerbi.read',
            ownerAdminId: 87,
        });
        AdminModel.findWithScopes.mockResolvedValue({
            id: 87,
            role: 'localadmin',
            isActive: 0,
            scopes: [],
        });

        const res = mkRes();
        const next = jest.fn();
        await requireApiKey(mkReq('idv_deadowner'), res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
    });

    test('an ACTIVE owner still authenticates and inherits their clearance', async () => {
        ApiKeyService.validate.mockResolvedValue({
            id: 4,
            label: 'bi',
            scope: 'powerbi.read',
            ownerAdminId: 12,
        });
        AdminModel.findWithScopes.mockResolvedValue({
            id: 12,
            role: 'localadmin',
            isActive: true,
            scopes: [{ scopeType: 'site', siteId: 3 }],
        });

        const req = mkReq('idv_good');
        const res = mkRes();
        const next = jest.fn();
        await requireApiKey(req, res, next);

        expect(next).toHaveBeenCalled();
        expect(res.statusCode).toBeNull();
        expect(req.user.id).toBe(12);
        expect(req.user.userType).toBe('admin');
    });

    test('an admin row WITHOUT an is_active column is not locked out (fail-open on absence only)', async () => {
        ApiKeyService.validate.mockResolvedValue({
            id: 5,
            label: 'legacy',
            scope: 'powerbi.read',
            ownerAdminId: 20,
        });
        AdminModel.findWithScopes.mockResolvedValue({ id: 20, role: 'localadmin', scopes: [] });

        const next = jest.fn();
        const res = mkRes();
        await requireApiKey(mkReq('idv_legacy'), res, next);
        expect(next).toHaveBeenCalled();
    });

    test('an OWNERLESS (system) key is unaffected — it never borrowed a clearance', async () => {
        ApiKeyService.validate.mockResolvedValue({
            id: 7,
            label: 'system',
            scope: 'powerbi.read',
            ownerAdminId: null,
        });

        const req = mkReq('idv_system');
        const next = jest.fn();
        await requireApiKey(req, mkRes(), next);

        expect(next).toHaveBeenCalled();
        expect(AdminModel.findWithScopes).not.toHaveBeenCalled();
        expect(req.user.role).toBe('superadmin');
    });

    test('a key the service refuses (revoked, expired, or dead owner) 403s', async () => {
        ApiKeyService.validate.mockResolvedValue(null);
        const res = mkRes();
        const next = jest.fn();
        await requireApiKey(mkReq('idv_unknown'), res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
        expect(res.body.error).toMatch(/Invalid API Key/i);
    });
});
