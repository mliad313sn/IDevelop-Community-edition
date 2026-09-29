'use strict';

const db = require('../config/database');
const { isValidSlug } = require('../config/permissions');
const AccessLedgerService = require('../services/AccessLedgerService');

/**
 * Per-admin granular permission grants (admin_permissions table). SuperAdmins
 * are never stored here — they hold everything implicitly. Slugs are validated
 * against the catalog before insert so a stale/typo'd grant can never land.
 *
 * Every capability change made through `setForAdmin` is mirrored into the access
 * ledger (`admin_access_events`, migration 69) as a diff — one `grant` per slug
 * added, one `revoke` per slug removed, one `expiry_extended` when only the
 * validity window moved. The ledger write is best-effort and never throws, so a
 * legitimate grant can never fail because provenance could not be recorded.
 *
 * Since migration 110 a grant row can be REVOKED in place (revoked_at + reason)
 * by "Désactiver": it confers nothing while flagged and is restored by
 * "Réactiver". Every authority read here filters `revoked_at IS NULL`.
 */
class AdminPermissionModel {
    /** @returns {Promise<string[]>} the permission slugs currently in force for this
     *  admin — expired grants (expires_at in the past) and revoked rows are excluded. */
    async findSlugsByAdminId(adminId) {
        const rows = await db.all(
            `SELECT permission FROM admin_permissions
              WHERE admin_id = ? AND revoked_at IS NULL
                AND (expires_at IS NULL OR expires_at > now())`,
            [adminId]
        );
        return rows.map((r) => r.permission);
    }

    async deleteByAdminId(adminId) {
        // Deliberately ledger-free: this is the primitive `setForAdmin` uses
        // internally (recording here would emit a spurious revoke+grant pair for
        // every UNCHANGED slug). Since it has no other caller: an account
        // is deactivated by flagging its rows (revokeAllForAdmin), never by
        // deleting them.
        return await db.run('DELETE FROM adminPermissions WHERE adminId = ?', [adminId]);
    }

    /** The soonest expiry across an admin's still-valid grants (or null = permanent),
     *  used to pre-fill the "access expires on" field on the edit form. */
    async getExpiryForAdmin(adminId) {
        const row = await db.get(
            'SELECT MIN(expires_at) AS expires_at FROM admin_permissions WHERE admin_id = ? AND revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at > now()',
            [adminId]
        );
        return row && row.expiresAt ? row.expiresAt : null;
    }

    /**
     * Expiry as the edit form must present it: the soonest FUTURE expiry
     * when the delegation is alive, otherwise the LAST PAST one — so an expired
     * account shows "Expiré le …" instead of defaulting to "permanent", which a
     * plain re-save would then have silently minted.
     * @returns {Promise<{expiresAt: string|null, lastExpiredAt: string|null, expired: boolean}>}
     */
    async getExpiryStateForAdmin(adminId) {
        const row = await db.get(
            `SELECT MIN(expires_at) FILTER (WHERE expires_at > now())  AS next_expiry,
                    MAX(expires_at) FILTER (WHERE expires_at <= now()) AS last_expired,
                    COUNT(*) FILTER (WHERE expires_at IS NULL OR expires_at > now()) AS live_count
               FROM admin_permissions
              WHERE admin_id = ? AND revoked_at IS NULL`,
            [adminId]
        );
        const next = row && row.nextExpiry ? row.nextExpiry : null;
        const last = row && row.lastExpired ? row.lastExpired : null;
        const live = row ? Number(row.liveCount || 0) : 0;
        return { expiresAt: next, lastExpiredAt: last, expired: Boolean(!live && last) };
    }

    /**
     * Re-stamp `expires_at` on EVERY grant row of this admin — the write half of
     * the "Prolonger de 12 mois" re-certification button. Rows whose expiry has
     * already lapsed are re-stamped too: renewing a delegation that ran out is
     * exactly what the button is for, and the reviewer is looking at the grant
     * list on the same page while they press it.
     *
     * Pass `null` to make the grants permanent. Call inside `db.runTransaction`
     * together with `AdminScopeModel.setExpiryForAdmin` so capability and scope
     * can never end up with different end dates.
     *
     * @returns {Promise<number>} number of grant rows re-stamped
     */
    async setExpiryForAdmin(adminId, expiresAt = null) {
        const r = await db.run('UPDATE admin_permissions SET expires_at = ? WHERE admin_id = ?', [
            expiresAt || null,
            adminId,
        ]);
        return (r && r.changes) || 0;
    }

    /**
     * "Désactiver": flag every live grant as revoked WITH the reason (rows kept
     * for "Réactiver"). Ledger `revoke` events are the caller's, which knows the
     * actor. @returns the rows revoked.
     */
    async revokeAllForAdmin(adminId, reason) {
        return await db.all(
            `UPDATE admin_permissions SET revoked_at = now(), revoke_reason = ?
              WHERE admin_id = ? AND revoked_at IS NULL
              RETURNING *`,
            [String(reason || '').trim(), adminId]
        );
    }

    /** "Réactiver": clear the revocation flags. @returns the rows restored. */
    async restoreAllForAdmin(adminId) {
        return await db.all(
            `UPDATE admin_permissions SET revoked_at = NULL, revoke_reason = NULL
              WHERE admin_id = ? AND revoked_at IS NOT NULL
              RETURNING *`,
            [adminId]
        );
    }

    /**
     * Replace the admin's grants with exactly `slugs` (deduped + catalog-validated).
     * Optional `expiresAt` (Date | ISO string | null) makes the whole grant set
     * time-bound — after that instant the grants stop counting (temporary delegation).
     *
     * @param {Object} [opts] provenance for the access ledger — all optional so the
     *   existing 3-arg callers are byte-for-byte unchanged in behaviour.
     * @param {number} [opts.actorAdminId] who is making the change
     * @param {string} [opts.reason]       stated justification
     * @param {string} [opts.profileKey]   the named access profile this came from
     * @param {boolean}[opts.silent]       skip ledger writes (bulk/system paths)
     */
    async setForAdmin(adminId, slugs = [], expiresAt = null, opts = {}) {
        const clean = [...new Set((slugs || []).filter((s) => isValidSlug(s)))];

        // Snapshot the previous state BEFORE the delete so the ledger records a
        // real diff rather than "everything revoked, everything granted".
        const before = opts && opts.silent ? [] : await this._snapshot(adminId);
        const exp = expiresAt || null;

        // ONE transaction. This was a DELETE followed by N INSERTs with nothing
        // holding them together: a failure between them left the admin with
        // fewer capabilities than either the old set or the new one, silently.
        await db.runTransaction(async () => {
            // Delete only the LIVE rows.
            //
            // It used to delete EVERY row for the admin, including the ones
            // "Désactiver" had flagged with revoked_at + revoke_reason, and then
            // re-insert live ones. So merely saving a deactivated admin's edit
            // form with the boxes untouched erased the revocation, dropped the
            // reason, and put the capability back in force — findSlugsByAdminId
            // then reported a live slug for an inactive account. Deactivation
            // was undone by a save nobody read as a grant.
            await db.run(
                'DELETE FROM admin_permissions WHERE admin_id = ? AND revoked_at IS NULL',
                [adminId]
            );

            // A REVOKED grant stays revoked. Re-arming it is "Réactiver"'s job,
            // which is deliberate and audited; a form save is not. This also
            // respects admin_permissions_unique (admin_id, permission) — the
            // revoked row still occupies that pair.
            const revoked = await db.all(
                'SELECT permission FROM admin_permissions WHERE admin_id = ? AND revoked_at IS NOT NULL',
                [adminId]
            );
            const held = new Set((revoked || []).map((r) => r.permission));

            for (const slug of clean) {
                if (held.has(slug)) continue;
                await db.run(
                    'INSERT INTO admin_permissions (admin_id, permission, expires_at) VALUES (?, ?, ?)',
                    [adminId, slug, exp]
                );
            }
        });

        if (!opts || !opts.silent) await this._recordDiff(adminId, before, clean, exp, opts || {});
        return clean;
    }

    /** Previous LIVE grants incl. expiry, keyed by slug. Best-effort: [] on failure. */
    async _snapshot(adminId) {
        try {
            return await db.all(
                'SELECT permission, expires_at FROM admin_permissions WHERE admin_id = ? AND revoked_at IS NULL',
                [adminId]
            );
        } catch (e) {
            console.error(
                '[AdminPermissionModel] could not snapshot grants:',
                (e && e.message) || e
            );
            return [];
        }
    }

    /**
     * Emit one ledger event per actual capability change. Never throws.
     * - slug in `after` but not `before`  → grant
     * - slug in `before` but not `after`  → revoke
     * - slug in both, expiry moved later  → expiry_extended
     */
    async _recordDiff(adminId, before, after, expiresAt, opts) {
        try {
            const prev = new Map((before || []).map((r) => [r.permission, r.expiresAt || null]));
            const next = new Set(after || []);
            const common = {
                adminId,
                actorAdminId: opts.actorAdminId,
                reason: opts.reason,
                profileKey: opts.profileKey,
            };
            const newExp = expiresAt ? new Date(expiresAt).getTime() : null;

            for (const slug of next) {
                if (!prev.has(slug)) {
                    await AccessLedgerService.record({
                        ...common,
                        changeType: 'grant',
                        slug,
                        effectiveTo: expiresAt || null,
                    });
                    continue;
                }
                const oldRaw = prev.get(slug);
                const oldExp = oldRaw ? new Date(oldRaw).getTime() : null;
                // Permanent → permanent is a no-op; anything that pushes the window
                // out (incl. permanent-ising a time-bound grant) is an extension.
                const extended = oldExp !== null && (newExp === null || newExp > oldExp);
                if (extended) {
                    await AccessLedgerService.record({
                        ...common,
                        changeType: 'expiry_extended',
                        slug,
                        effectiveTo: expiresAt || null,
                    });
                }
            }
            for (const slug of prev.keys()) {
                if (!next.has(slug)) {
                    await AccessLedgerService.record({ ...common, changeType: 'revoke', slug });
                }
            }
        } catch (e) {
            console.error(
                '[AdminPermissionModel] could not record access diff:',
                (e && e.message) || e
            );
        }
    }
}

module.exports = new AdminPermissionModel();
