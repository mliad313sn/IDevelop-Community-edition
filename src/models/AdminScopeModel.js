const BaseModel = require('./BaseModel');
const db = require('../config/database');
const AccessLedgerService = require('../services/AccessLedgerService');

/**
 * An admin's SCOPE — the slice of the organisation their permissions apply to.
 * Scope and capability are independent axes: a scope with no grants is a
 * powerless account (the state 25 localadmins and 7 viewers were left in), and a
 * grant with no scope reaches nothing. Both axes are therefore recorded in the
 * same access ledger (`admin_access_events`, migration 69) so a review can
 * reconstruct exactly when an account's reach changed and who changed it.
 *
 * Since migration 110 a scope row can be REVOKED (revoked_at + reason) by
 * "Désactiver" and restored by "Réactiver": a revoked row confers nothing and
 * is excluded from every read that decides authority (`findByAdminId`).
 *
 * Ledger writes are best-effort and never throw into the caller.
 */
class AdminScopeModel extends BaseModel {
    constructor() {
        super('adminScopes');
    }

    /** The scope rows that still COUNT (not revoked). Expiry is judged by the caller. */
    async findByAdminId(adminId) {
        return await db.all(
            'SELECT * FROM admin_scopes WHERE admin_id = ? AND revoked_at IS NULL ORDER BY id',
            [adminId]
        );
    }

    /** Every scope row of the account, revoked ones included (review / restore). */
    async findAllByAdminId(adminId) {
        return await db.all('SELECT * FROM admin_scopes WHERE admin_id = ? ORDER BY id', [adminId]);
    }

    /**
     * Attach a scope. `opts` carries provenance for the ledger and is optional,
     * so the existing single-argument callers behave exactly as before.
     * @param {Object} [opts] {actorAdminId, reason, profileKey, silent}
     */
    async create(data, opts = {}) {
        const row = await super.create(data);
        if (!opts || !opts.silent) {
            await AccessLedgerService.record({
                adminId: (row && row.adminId) || (data && data.adminId),
                changeType: 'scope_added',
                scopeType: (row && row.scopeType) || (data && data.scopeType),
                scopeId: this._scopeTargetId(row || data),
                effectiveTo: (row && row.expiresAt) || (data && data.expiresAt) || null,
                actorAdminId: opts.actorAdminId,
                reason: opts.reason,
                profileKey: opts.profileKey,
            });
        }
        return row;
    }

    /**
     * Detach ONE scope row (the operator removed it from the form). This is the
     * diff-based counterpart of `create`: an unchanged edit no longer rewrites
     * every row, only the rows that actually changed are touched, and
     * each removal is one ledger event.
     * @param {Object} row     a scope row (needs id, adminId, scopeType, …Id)
     * @param {Object} [opts]  {actorAdminId, reason}
     */
    async removeOne(row, opts = {}) {
        if (!row || !row.id) return 0;
        const res = await db.run('DELETE FROM admin_scopes WHERE id = ?', [row.id]);
        await AccessLedgerService.record({
            adminId: row.adminId,
            changeType: 'scope_removed',
            scopeType: row.scopeType,
            scopeId: this._scopeTargetId(row),
            actorAdminId: opts.actorAdminId,
            reason: opts.reason,
        });
        return (res && res.changes) || 0;
    }

    /**
     * Detach every scope from an admin. Records one `scope_removed` event per row
     * that actually existed, so a "replace the scopes" edit reads as removals then
     * additions rather than an unexplained gap.
     * @param {Object} [opts] {actorAdminId, reason, silent}
     */
    async deleteByAdminId(adminId, opts = {}) {
        const existing = opts && opts.silent ? [] : await this._safeExisting(adminId);
        const res = await db.run('DELETE FROM adminScopes WHERE adminId = ?', [adminId]);
        for (const s of existing) {
            await AccessLedgerService.record({
                adminId,
                changeType: 'scope_removed',
                scopeType: s.scopeType,
                scopeId: this._scopeTargetId(s),
                actorAdminId: opts.actorAdminId,
                reason: opts.reason,
            });
        }
        return res;
    }

    /**
     * "Désactiver": flag every live scope row as revoked WITH the reason. The
     * rows stay (rule 3: a state plus a reason, never a delete) so "Réactiver"
     * can give the perimeter back. Ledger events are the caller's (it has the
     * actor). @returns the rows that were revoked.
     */
    async revokeAllForAdmin(adminId, reason) {
        return await db.all(
            `UPDATE admin_scopes SET revoked_at = now(), revoke_reason = ?
              WHERE admin_id = ? AND revoked_at IS NULL
              RETURNING *`,
            [String(reason || '').trim(), adminId]
        );
    }

    /** "Réactiver": the inverse of revokeAllForAdmin. @returns the rows restored. */
    async restoreAllForAdmin(adminId) {
        return await db.all(
            `UPDATE admin_scopes SET revoked_at = NULL, revoke_reason = NULL
              WHERE admin_id = ? AND revoked_at IS NOT NULL
              RETURNING *`,
            [adminId]
        );
    }

    /**
     * Re-stamp `expires_at` on every scope row of this admin (null = permanent).
     * Paired with `AdminPermissionModel.setExpiryForAdmin` inside ONE transaction
     * by the "Prolonger de 12 mois" re-certification action: an admin whose
     * capability was renewed but whose scope stayed expired would hold rights
     * over nobody, which reads as a broken account rather than a revoked one.
     *
     * Rows already past their expiry are re-stamped too — renewing a lapsed
     * delegation is the whole point of the button.
     *
     * Ledger events are emitted by the caller (one `expiry_extended` per admin),
     * not per row, so a four-scope admin does not produce four identical events.
     *
     * @returns {Promise<number>} number of scope rows re-stamped
     */
    async setExpiryForAdmin(adminId, expiresAt = null) {
        const r = await db.run('UPDATE admin_scopes SET expires_at = ? WHERE admin_id = ?', [
            expiresAt || null,
            adminId,
        ]);
        return (r && r.changes) || 0;
    }

    /** The id the scope row actually points at, whichever axis it uses. */
    _scopeTargetId(s) {
        if (!s) return null;
        return s.siteId || s.departmentId || s.serviceId || s.countryId || s.regionId || null;
    }

    /** `type:targetId` — the identity of a scope row for diffing form vs DB. */
    scopeKey(s) {
        return `${s.scopeType}:${this._scopeTargetId(s)}`;
    }

    async _safeExisting(adminId) {
        try {
            return await this.findByAdminId(adminId);
        } catch (e) {
            console.error('[AdminScopeModel] could not snapshot scopes:', (e && e.message) || e);
            return [];
        }
    }

    async findEmployeesInScope(adminId) {
        // Get all scopes for this admin
        const scopes = await this.findByAdminId(adminId);

        if (scopes.length === 0) {
            return [];
        }

        const conditions = [];
        const params = [];

        scopes.forEach((scope) => {
            if (scope.scopeType === 'site') {
                conditions.push('e.siteId = ?');
                params.push(scope.siteId);
            } else if (scope.scopeType === 'department') {
                conditions.push('e.departmentId = ?');
                params.push(scope.departmentId);
            } else if (scope.scopeType === 'service') {
                conditions.push('e.serviceId = ?');
                params.push(scope.serviceId);
            }
        });

        if (conditions.length === 0) {
            return [];
        }

        const sql = `
            SELECT DISTINCT e.*
            FROM employees e
            WHERE (${conditions.join(' OR ')})
        `;

        return await db.all(sql, params);
    }
}

module.exports = new AdminScopeModel();
