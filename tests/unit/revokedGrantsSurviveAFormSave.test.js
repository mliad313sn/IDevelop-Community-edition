'use strict';
/**
 * CODE-REVIEW-2026-09-17 [IMPORTANT/security]: « Sauvegarder le formulaire
 * d'un administrateur désactivé efface "révoqué + motif" et ré-arme ses
 * droits, hors transaction ».
 *
 * Real, on both counts.
 *
 *  1. `setForAdmin` called `deleteByAdminId`, which deleted EVERY
 *     admin_permissions row for the admin — including the ones "Désactiver"
 *     had flagged with revoked_at + revoke_reason — and then re-inserted live
 *     rows. So merely SAVING a deactivated admin's edit form, boxes untouched,
 *     erased the revocation, dropped the reason, and put the capability back
 *     in force. `findSlugsByAdminId` — the authority read — then reported a
 *     live slug for an inactive account. A deactivation undone by a save that
 *     nobody would read as a grant.
 *
 *     The file's own comment already claimed this could not happen ("an
 *     account is deactivated by flagging its rows, never by deleting them"),
 *     which was true of every caller except the one that mattered.
 *
 *  2. DELETE then N INSERTs with nothing holding them together: a failure in
 *     between left the admin with fewer capabilities than either the old set
 *     or the new one, silently.
 *
 * PROVEN BY EXECUTION on the dev database in a rolled-back transaction
 * (scratchpad/probe-revoked-grants.js, 8/8): grant → revokeAllForAdmin →
 * save the same slug → the revocation, the reason and the empty in-force set
 * all survive. Mutation — deleting every row again — reddens exactly those
 * three.
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(async (fn) => fn()),
};
jest.mock('../../src/config/database', () => mockDb);

const Perms = require('../../src/models/AdminPermissionModel');

const ADMIN = 702;
const ranSql = () => mockDb.run.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.runTransaction.mockImplementation(async (fn) => fn());
    mockDb.run.mockResolvedValue({ changes: 1 });
    mockDb.get.mockResolvedValue(null);
    mockDb.all.mockResolvedValue([]);
});

describe('a form save never resurrects a revoked grant', () => {
    test('the delete is scoped to LIVE rows only', async () => {
        await Perms.setForAdmin(ADMIN, ['view_employees'], null, { silent: true });
        const del = ranSql().filter((s) => /DELETE FROM admin_permissions/i.test(s));
        expect(del).toHaveLength(1);
        expect(del[0]).toMatch(/revoked_at IS NULL/i);
    });

    test('a slug that is currently REVOKED is not re-inserted', async () => {
        mockDb.all.mockImplementation(async (sql) =>
            /revoked_at IS NOT NULL/i.test(sql) ? [{ permission: 'view_employees' }] : []
        );
        await Perms.setForAdmin(ADMIN, ['view_employees', 'export_data'], null, { silent: true });

        const inserts = mockDb.run.mock.calls.filter((c) =>
            /INSERT INTO admin_permissions/i.test(String(c[0]))
        );
        const slugs = inserts.map((c) => c[1][1]);
        // The revoked one stays revoked — restoring it is "Réactiver"'s job,
        // which is deliberate and audited. The other is granted normally.
        expect(slugs).not.toContain('view_employees');
        expect(slugs).toContain('export_data');
    });

    test('with nothing revoked, every requested slug is still granted', async () => {
        // The guard must not quietly stop granting on a healthy account.
        const out = await Perms.setForAdmin(ADMIN, ['view_employees', 'export_data'], null, {
            silent: true,
        });
        const slugs = mockDb.run.mock.calls
            .filter((c) => /INSERT INTO admin_permissions/i.test(String(c[0])))
            .map((c) => c[1][1]);
        expect(slugs.sort()).toEqual(['export_data', 'view_employees']);
        expect(out.sort()).toEqual(['export_data', 'view_employees']);
    });
});

describe('the replacement is atomic', () => {
    test('delete and inserts run inside ONE transaction', async () => {
        await Perms.setForAdmin(ADMIN, ['view_employees'], null, { silent: true });
        expect(mockDb.runTransaction).toHaveBeenCalledTimes(1);
    });

    test('a failed insert takes the delete with it', async () => {
        // The real guarantee: the old set survives a partial failure rather
        // than leaving the admin with neither set.
        mockDb.runTransaction.mockImplementation(async (fn) => {
            try {
                return await fn();
            } catch (e) {
                throw new Error('ROLLED_BACK:' + e.message);
            }
        });
        mockDb.run.mockImplementation(async (sql) => {
            if (/INSERT INTO admin_permissions/i.test(String(sql))) throw new Error('boom');
            return { changes: 1 };
        });
        await expect(
            Perms.setForAdmin(ADMIN, ['view_employees'], null, { silent: true })
        ).rejects.toThrow(/ROLLED_BACK/);
    });
});
