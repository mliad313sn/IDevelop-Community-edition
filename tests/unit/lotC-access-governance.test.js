'use strict';

/**
 * Lot C — access governance primitives (L1-09/15/19/21/24, L6-13).
 *
 * The rule these pin: a delegation is never DELETED. "Désactiver" flags every
 * grant and every scope row with `revoked_at` + the operator's reason; the row
 * stays on the account, confers nothing while flagged, and "Réactiver" gives
 * the exact same perimeter back. Every read that decides authority therefore
 * has to filter `revoked_at IS NULL` — a single missed filter would hand a
 * deactivated account its capabilities back, which is why each read is pinned
 * on its SQL here rather than on a hand-written summary of it.
 */

const mockDb = {
    all: jest.fn(async () => []),
    get: jest.fn(async () => null),
    run: jest.fn(async () => ({ changes: 0 })),
    runTransaction: jest.fn(async (fn) => fn()),
    _client: jest.fn(),
};
jest.mock('../../src/config/database', () => mockDb);

const AdminPermissionModel = require('../../src/models/AdminPermissionModel');
const AdminScopeModel = require('../../src/models/AdminScopeModel');
const AccessLedgerService = require('../../src/services/AccessLedgerService');
const MfaService = require('../../src/services/MfaService');

const lastSql = () =>
    String(mockDb.all.mock.calls[mockDb.all.mock.calls.length - 1][0]).replace(/\s+/g, ' ');

describe('Lot C — a revoked grant confers nothing', () => {
    test('findSlugsByAdminId filters revoked AND expired rows', async () => {
        mockDb.all.mockResolvedValueOnce([{ permission: 'manage_cycles' }]);
        const slugs = await AdminPermissionModel.findSlugsByAdminId(631);
        expect(slugs).toEqual(['manage_cycles']);
        const sql = lastSql();
        expect(sql).toMatch(/revoked_at IS NULL/);
        expect(sql).toMatch(/expires_at IS NULL OR expires_at > now\(\)/);
    });

    test('getExpiryForAdmin ignores revoked rows', async () => {
        mockDb.get.mockResolvedValueOnce({ expiresAt: null });
        await AdminPermissionModel.getExpiryForAdmin(631);
        expect(String(mockDb.get.mock.calls.pop()[0])).toMatch(/revoked_at IS NULL/);
    });

    test('the scope read that feeds authority excludes revoked rows', async () => {
        await AdminScopeModel.findByAdminId(631);
        expect(lastSql()).toMatch(/FROM admin_scopes WHERE admin_id = \? AND revoked_at IS NULL/);
    });

    test('the review read (findAllByAdminId) keeps them — restoring needs to see them', async () => {
        await AdminScopeModel.findAllByAdminId(631);
        expect(lastSql()).not.toMatch(/revoked_at/);
    });

    test('resolveAdminScope — the RBAC reach resolver — filters revoked and expired', () => {
        const src = require('fs').readFileSync(
            require.resolve('../../src/utils/adminScope'),
            'utf8'
        );
        const query = src.slice(src.indexOf('FROM admin_scopes'), src.indexOf('[Number(user.id)]'));
        expect(query).toMatch(/revoked_at IS NULL/);
        expect(query).toMatch(/expires_at IS NULL OR expires_at > now\(\)/);
    });
});

describe('Lot C — "Désactiver" flags, "Réactiver" restores (never a DELETE)', () => {
    test('revokeAllForAdmin sets revoked_at + the reason on the LIVE rows only', async () => {
        mockDb.all.mockResolvedValueOnce([{ permission: 'manage_cycles' }]);
        const rows = await AdminPermissionModel.revokeAllForAdmin(631, '  Congé longue durée  ');
        expect(rows).toHaveLength(1);
        const [sql, params] = mockDb.all.mock.calls.pop();
        expect(String(sql).replace(/\s+/g, ' ')).toMatch(
            /UPDATE admin_permissions SET revoked_at = now\(\), revoke_reason = \? WHERE admin_id = \? AND revoked_at IS NULL RETURNING \*/
        );
        expect(params[0]).toBe('Congé longue durée'); // trimmed: the CHECK constraint refuses blank
        expect(String(sql)).not.toMatch(/DELETE/);
    });

    test('restoreAllForAdmin clears the flags of the rows that were revoked', async () => {
        await AdminScopeModel.restoreAllForAdmin(631);
        const sql = lastSql();
        expect(sql).toMatch(
            /UPDATE admin_scopes SET revoked_at = NULL, revoke_reason = NULL WHERE admin_id = \? AND revoked_at IS NOT NULL/
        );
    });

    test('the deactivate path flags rows — it never deletes a grant or a scope', () => {
        const src = require('fs').readFileSync(
            require.resolve('../../src/controllers/AdminController'),
            'utf8'
        );
        const body = src.slice(
            src.indexOf('async function _deactivateAdmin'),
            src.indexOf('async function _reactivateAdmin')
        );
        expect(body).toMatch(/AdminPermissionModel\.revokeAllForAdmin/);
        expect(body).toMatch(/AdminScopeModel\.revokeAllForAdmin/);
        expect(body).not.toMatch(/deleteByAdminId|DELETE FROM/);
        const back = src.slice(
            src.indexOf('async function _reactivateAdmin'),
            src.indexOf('function _fold')
        );
        expect(back).toMatch(/restoreAllForAdmin/);
        expect(back).toMatch(/forcePasswordChange: true/);
    });
});

describe('Lot C — expiry state says "expired", never "never provisioned" (L1-04)', () => {
    test('a past-only expiry is reported as expired with its date', async () => {
        mockDb.get.mockResolvedValueOnce({
            nextExpiry: null,
            lastExpired: '2026-09-01T00:00:00.000Z',
            liveCount: 0,
        });
        const s = await AdminPermissionModel.getExpiryStateForAdmin(631);
        expect(s).toEqual({
            expiresAt: null,
            lastExpiredAt: '2026-09-01T00:00:00.000Z',
            expired: true,
        });
    });

    test('a live bounded delegation is not "expired"', async () => {
        mockDb.get.mockResolvedValueOnce({
            nextExpiry: '2026-12-01T00:00:00.000Z',
            lastExpired: null,
            liveCount: 3,
        });
        const s = await AdminPermissionModel.getExpiryStateForAdmin(631);
        expect(s.expired).toBe(false);
        expect(s.expiresAt).toBe('2026-12-01T00:00:00.000Z');
    });

    test('an account that never had a bounded grant is neither expired nor dated', async () => {
        mockDb.get.mockResolvedValueOnce({ nextExpiry: null, lastExpired: null, liveCount: 2 });
        expect(await AdminPermissionModel.getExpiryStateForAdmin(631)).toEqual({
            expiresAt: null,
            lastExpiredAt: null,
            expired: false,
        });
    });
});

describe('Lot C — the ledger records the two new transitions with their provenance', () => {
    test('deactivated / reactivated are part of the closed vocabulary', () => {
        expect(AccessLedgerService.CHANGE_TYPES).toEqual(
            expect.arrayContaining(['deactivated', 'reactivated'])
        );
        expect(AccessLedgerService.LOG_ACTIONS.deactivated).toBe('ACCESS_DEACTIVATED');
        expect(AccessLedgerService.LOG_ACTIONS.reactivated).toBe('ACCESS_REACTIVATED');
    });

    test('source defaults to "ledger" and only accepts the two known values', async () => {
        mockDb.run.mockResolvedValue({ lastID: 1 });
        // record() also mirrors a line into system_logs, so pick the event insert.
        const sourceOfLastEvent = () => {
            const call = mockDb.run.mock.calls
                .filter((c) => /INSERT INTO admin_access_events/.test(String(c[0])))
                .pop();
            return call[1][call[1].length - 1];
        };
        await AccessLedgerService.record({
            adminId: 631,
            changeType: 'revoke',
            slug: 'manage_cycles',
            reason: 'r',
        });
        expect(sourceOfLastEvent()).toBe('ledger');
        await AccessLedgerService.record({
            adminId: 631,
            changeType: 'grant',
            slug: 'manage_cycles',
            source: 'invented',
        });
        expect(sourceOfLastEvent()).toBe('ledger');
        await AccessLedgerService.record({
            adminId: 631,
            changeType: 'grant',
            slug: 'manage_cycles',
            source: 'backfill',
        });
        expect(sourceOfLastEvent()).toBe('backfill');
    });

    test('an unknown change type is dropped, never written', async () => {
        const err = jest.spyOn(console, 'error').mockImplementation(() => {});
        mockDb.run.mockClear();
        const r = await AccessLedgerService.record({ adminId: 631, changeType: 'deleted' });
        expect(r).toEqual({ ok: false, skipped: 'invalid-change-type' });
        expect(mockDb.run).not.toHaveBeenCalled();
        err.mockRestore();
    });
});

describe('Lot C — MFA reset is a table operation, authority stays with the caller', () => {
    test('adminReset removes the secret, the backup codes and the used-code trail', async () => {
        mockDb.get.mockResolvedValueOnce({ ok: 1 });
        mockDb.run.mockResolvedValue({ changes: 8 });
        const r = await MfaService.adminReset({ userType: 'admin', userId: 631 });
        expect(r.hadSecret).toBe(true);
        expect(r.backupCodesRemoved).toBe(8);
        const tables = mockDb.run.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' '));
        expect(tables.some((s) => /DELETE FROM mfa_backup_codes/.test(s))).toBe(true);
        expect(tables.some((s) => /DELETE FROM mfa_secrets/.test(s))).toBe(true);
        expect(tables.some((s) => /DELETE FROM mfa_used_codes/.test(s))).toBe(true);
    });

    test('it reports honestly when there was no secret to remove', async () => {
        mockDb.get.mockResolvedValueOnce(null);
        mockDb.run.mockResolvedValue({ changes: 0 });
        expect(await MfaService.adminReset({ userType: 'admin', userId: 42 })).toEqual({
            hadSecret: false,
            backupCodesRemoved: 0,
        });
    });
});
