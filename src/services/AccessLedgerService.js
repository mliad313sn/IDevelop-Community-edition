'use strict';

/**
 * AccessLedgerService — the provenance trail for admin access.
 *
 * `admin_permissions` and `admin_scopes` answer "what can this account do RIGHT
 * NOW". They cannot answer the questions an access review actually asks: who
 * granted this, on whose authority, for what stated reason, and until when. This
 * service writes one append-only row per access transition into
 * `admin_access_events` (migration 69) and mirrors a one-line summary into the
 * hash-chained system_logs audit, so the change is both queryable per-account and
 * tamper-evident in the global chain.
 *
 * BEST-EFFORT BY CONTRACT. Recording provenance must never be the reason a
 * legitimate grant fails: every method swallows its own errors and returns a
 * result object instead of throwing (the same discipline LogService follows).
 * Callers therefore never need a try/catch around `record`.
 *
 * NOTE ON AUTHORITY: nothing in this table is ever consulted to decide whether an
 * action is allowed. It is evidence, not permission. Authorization stays with
 * admin_permissions + admin_scopes via RBACService.
 */

const db = require('../config/database');
const LogService = require('./LogService');

/** The closed vocabulary of access transitions. */
const CHANGE_TYPES = Object.freeze([
    'grant', // a permission slug was added to the account
    'revoke', // a permission slug was removed
    'profile_applied', // a named access profile was provisioned onto the account
    'scope_added', // a site/department/service/country/region scope was attached
    'scope_removed', // a scope was detached
    'expiry_extended', // a time-bound grant's validity window was pushed out
    'deactivated', // the whole account was switched off (rows kept, flagged revoked)
    'reactivated', // the account was switched back on and its perimeter restored
]);
const CHANGE_TYPE_SET = new Set(CHANGE_TYPES);

/** Where an event came from: written live, or reconstructed by migration 110. */
const SOURCES = Object.freeze(['ledger', 'backfill']);

/** system_logs action names, one per change type — greppable in the audit view. */
const LOG_ACTIONS = Object.freeze({
    grant: 'ACCESS_GRANT',
    revoke: 'ACCESS_REVOKE',
    profile_applied: 'ACCESS_PROFILE_APPLIED',
    scope_added: 'ACCESS_SCOPE_ADDED',
    scope_removed: 'ACCESS_SCOPE_REMOVED',
    expiry_extended: 'ACCESS_EXPIRY_EXTENDED',
    deactivated: 'ACCESS_DEACTIVATED',
    reactivated: 'ACCESS_REACTIVATED',
});

const MAX_LIMIT = 500;

function toIntOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : null;
}

function toTextOrNull(v) {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s === '' ? null : s;
}

class AccessLedgerService {
    /**
     * Append one access transition.
     *
     * @param {Object}  e
     * @param {number}  e.adminId        subject of the change (the account whose access moved)
     * @param {string}  e.changeType     one of CHANGE_TYPES
     * @param {string} [e.slug]          permission slug, for grant/revoke
     * @param {string} [e.scopeType]     'site'|'department'|'service'|'country'|'region', for scope_*
     * @param {number} [e.scopeId]       id of that scope row's target
     * @param {string} [e.profileKey]    named profile, for profile_applied
     * @param {Date|string} [e.effectiveTo] when this access stops counting (null = permanent)
     * @param {number} [e.actorAdminId]  who made the change (null = system/automated backfill)
     * @param {string} [e.reason]        free-text justification recorded with the change
     * @param {string} [e.source]        'ledger' (default) | 'backfill'
     * @returns {Promise<{ok:boolean, id?:number, skipped?:string}>} never rejects
     */
    async record(e = {}) {
        try {
            const adminId = toIntOrNull(e.adminId);
            const changeType = toTextOrNull(e.changeType);

            // Fail QUIETLY but visibly: a malformed ledger call is a bug in the
            // caller, not a reason to abort the access change it accompanies.
            if (adminId == null) {
                console.error('[AccessLedger] record() called without adminId — event dropped');
                return { ok: false, skipped: 'missing-admin-id' };
            }
            if (!changeType || !CHANGE_TYPE_SET.has(changeType)) {
                console.error(`[AccessLedger] unknown changeType "${changeType}" — event dropped`);
                return { ok: false, skipped: 'invalid-change-type' };
            }

            const row = {
                slug: toTextOrNull(e.slug),
                scopeType: toTextOrNull(e.scopeType),
                scopeId: toIntOrNull(e.scopeId),
                profileKey: toTextOrNull(e.profileKey),
                effectiveTo: e.effectiveTo || null,
                actorAdminId: toIntOrNull(e.actorAdminId),
                reason: toTextOrNull(e.reason),
                source: SOURCES.includes(e.source) ? e.source : 'ledger',
            };

            // Native snake_case SQL: `admin_access_events` is a new table and is not
            // in the compat layer's TABLE_MAP, so a camelCase spelling would NOT be
            // rewritten (the v3.22.5 password-reset gotcha).
            const res = await db.run(
                `INSERT INTO admin_access_events
                    (admin_id, change_type, slug, scope_type, scope_id,
                     profile_key, effective_to, actor_admin_id, reason, source)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    adminId,
                    changeType,
                    row.slug,
                    row.scopeType,
                    row.scopeId,
                    row.profileKey,
                    row.effectiveTo,
                    row.actorAdminId,
                    row.reason,
                    row.source,
                ]
            );

            // Mirror a summary into the hash-chained audit so the change is
            // tamper-evident globally, not only in its own table.
            await LogService.log({
                adminId: row.actorAdminId,
                action: LOG_ACTIONS[changeType] || 'ACCESS_CHANGE',
                entityType: 'admin',
                entityId: adminId,
                category: 'security',
                details: {
                    changeType,
                    subjectAdminId: adminId,
                    slug: row.slug,
                    scopeType: row.scopeType,
                    scopeId: row.scopeId,
                    profileKey: row.profileKey,
                    effectiveTo: row.effectiveTo ? new Date(row.effectiveTo).toISOString() : null,
                    reason: row.reason,
                },
            });

            return { ok: true, id: res && res.lastID != null ? res.lastID : undefined };
        } catch (error) {
            // Never propagate: provenance is important, but losing it must not
            // roll back or block the access change the caller just performed.
            console.error(
                '[AccessLedger] failed to record access event:',
                (error && error.message) || error
            );
            return { ok: false, skipped: 'error' };
        }
    }

    /**
     * The access history of one account, newest first.
     * @param {number} adminId
     * @param {number} [limit=50] capped at 500
     * @returns {Promise<Array>} camelCased rows; [] on any failure (never rejects)
     */
    async history(adminId, limit = 50) {
        try {
            const id = toIntOrNull(adminId);
            if (id == null) return [];
            let n = toIntOrNull(limit);
            if (n == null || n <= 0) n = 50;
            if (n > MAX_LIMIT) n = MAX_LIMIT;

            // LIMIT is an inlined integer (already coerced above), never a string.
            return await db.all(
                `SELECT e.id,
                        e.admin_id,
                        e.change_type,
                        e.slug,
                        e.scope_type,
                        e.scope_id,
                        e.profile_key,
                        e.effective_from,
                        e.effective_to,
                        e.actor_admin_id,
                        e.reason,
                        e.source,
                        e.created_at,
                        act.username AS actor_username
                   FROM admin_access_events e
                   LEFT JOIN admins act ON act.id = e.actor_admin_id
                  WHERE e.admin_id = ?
                  ORDER BY e.created_at DESC, e.id DESC
                  LIMIT ${n}`,
                [id]
            );
        } catch (error) {
            console.error(
                '[AccessLedger] failed to read access history:',
                (error && error.message) || error
            );
            return [];
        }
    }
}

const instance = new AccessLedgerService();
// Expose the closed vocabularies on the singleton so callers can validate a
// changeType before calling record (and so a test can pin the list).
instance.CHANGE_TYPES = CHANGE_TYPES;
instance.LOG_ACTIONS = LOG_ACTIONS;
instance.SOURCES = SOURCES;

module.exports = instance;
