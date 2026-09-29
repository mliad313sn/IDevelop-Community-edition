'use strict';
/**
 * Unit tests for the per-client API key service (IDevelop — Wave 1).
 * DB-free: the database module is mocked so these run fast in CI.
 */
jest.mock('../../src/config/database', () => ({
    get: jest.fn(),
    all: jest.fn(() => Promise.resolve([])),
    run: jest.fn(() => Promise.resolve()),
}));

const crypto = require('crypto');
const db = require('../../src/config/database');
const ApiKeyService = require('../../src/services/ApiKeyService');

describe('ApiKeyService', () => {
    beforeEach(() => {
        db.get.mockReset();
        db.run.mockReset();
        db.all.mockReset();
        db.run.mockResolvedValue();
        db.all.mockResolvedValue([]);
    });

    test('hashKey is a deterministic SHA-256 hex digest', () => {
        const h = ApiKeyService.hashKey('abc');
        expect(h).toBe(crypto.createHash('sha256').update('abc').digest('hex'));
        expect(h).toMatch(/^[0-9a-f]{64}$/);
        expect(ApiKeyService.hashKey('abc')).toBe(ApiKeyService.hashKey('abc'));
        expect(ApiKeyService.hashKey('abc')).not.toBe(ApiKeyService.hashKey('abd'));
    });

    test('validate() returns the principal for a live key and looks up by hash', async () => {
        db.get.mockResolvedValue({
            id: '7',
            label: 'powerbi',
            scope: 'powerbi.read',
            ownerAdminId: '3',
            expiresAt: null,
        });
        const p = await ApiKeyService.validate('rawkey');
        // Per-profile keys carry the owning admin (clearance) + optional expiry.
        expect(p).toEqual({
            id: 7,
            label: 'powerbi',
            scope: 'powerbi.read',
            ownerAdminId: 3,
            expiresAt: null,
        });
        expect(db.get).toHaveBeenCalledWith(expect.stringContaining('FROM api_keys'), [
            ApiKeyService.hashKey('rawkey'),
        ]);
        expect(db.run).toHaveBeenCalled(); // last_used_at touch
    });

    test('validate() resolves an ownerless key to a null owner (full-org/system)', async () => {
        db.get.mockResolvedValue({
            id: '9',
            label: 'system',
            scope: 'powerbi.read',
            ownerAdminId: null,
            expiresAt: null,
        });
        const p = await ApiKeyService.validate('rawkey');
        expect(p.ownerAdminId).toBeNull();
    });

    test('validate() returns null for empty or unknown keys', async () => {
        expect(await ApiKeyService.validate('')).toBeNull();
        expect(await ApiKeyService.validate(null)).toBeNull();
        db.get.mockResolvedValue(undefined);
        expect(await ApiKeyService.validate('nope')).toBeNull();
    });

    test('generate() returns a one-time raw token but stores only the hash', async () => {
        db.get.mockResolvedValue({ id: '12' });
        const k = await ApiKeyService.generate({
            label: 'svc',
            scope: 'powerbi.read',
            createdBy: 1,
        });
        expect(k.id).toBe(12);
        expect(k.key).toMatch(/^ak_[0-9a-f]{48}$/);
        const insertParams = db.get.mock.calls[0][1];
        expect(insertParams).toContain(ApiKeyService.hashKey(k.key)); // hash is persisted
        expect(insertParams).not.toContain(k.key); // raw token is NOT
    });

    test('generate() requires label and createdBy', async () => {
        await expect(ApiKeyService.generate({ createdBy: 1 })).rejects.toThrow(/label/);
        await expect(ApiKeyService.generate({ label: 'x' })).rejects.toThrow(/createdBy/);
    });

    // --- de-authorization: a key must not outlive its owner --------------------
    describe('an owned key dies with its owner', () => {
        test('validate() joins admins and demands an ACTIVE owner', async () => {
            db.get.mockResolvedValue(undefined);
            await ApiKeyService.validate('rawkey');
            const sql = db.get.mock.calls[0][0].replace(/\s+/g, ' ');
            expect(sql).toContain('LEFT JOIN admins a ON a.id = k.owner_admin_id');
            // Ownerless keys stay valid; owned keys require is_active.
            expect(sql).toContain('k.owner_admin_id IS NULL OR COALESCE(a.is_active, true) = true');
            // The pre-existing revoked/expired conditions must not have been lost.
            expect(sql).toContain('k.revoked_at IS NULL');
            expect(sql).toContain('k.expires_at IS NULL OR k.expires_at > now()');
        });

        test('revokeByOwner() revokes every live key of one admin and reports the count', async () => {
            db.all.mockResolvedValue([{ id: '1' }, { id: '2' }]);
            expect(await ApiKeyService.revokeByOwner(87)).toBe(2);
            const [sql, params] = db.all.mock.calls[0];
            expect(sql.replace(/\s+/g, ' ')).toContain(
                'UPDATE api_keys SET revoked_at = now() WHERE owner_admin_id = ?'
            );
            expect(sql).toContain('revoked_at IS NULL'); // idempotent
            expect(params).toEqual([87]);
        });

        test('revokeByOwner() is a no-op for a missing/invalid owner id (never a mass revoke)', async () => {
            expect(await ApiKeyService.revokeByOwner(null)).toBe(0);
            expect(await ApiKeyService.revokeByOwner(undefined)).toBe(0);
            expect(await ApiKeyService.revokeByOwner('abc')).toBe(0);
            expect(await ApiKeyService.revokeByOwner(0)).toBe(0);
            expect(db.all).not.toHaveBeenCalled();
        });
    });
});
