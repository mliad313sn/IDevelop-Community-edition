'use strict';
/**
 * Per-client API keys (IDevelop — Wave 1).
 *
 * Keys are high-entropy random tokens; only their SHA-256 hash is stored
 * (`api_keys.key_hash`), so a DB leak never exposes a usable key. Validation is
 * an indexed hash lookup of a non-revoked row. Each key is individually
 * revocable (set `revoked_at`) and carries a `scope`. The raw token is shown to
 * the issuer exactly once at creation.
 *
 * @module services/ApiKeyService
 */
const crypto = require('crypto');
const db = require('../config/database');

/** Deterministic SHA-256 hex of a raw key (safe: keys are high-entropy, not passwords). */
function hashKey(raw) {
    return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

/**
 * Validate a presented raw key. Returns the key's principal info or null.
 * Touches last_used_at on success (best-effort, non-blocking).
 *
 * DE-AUTHORIZATION: an OWNED key runs AS its owning admin, so it must die with
 * that admin. `auth.js deserializeUser` already kills a live browser session the
 * instant `admins.is_active` flips false, but the key path had no equivalent
 * test — a deactivated (or soft-deleted, which is the same UPDATE) owner's key
 * kept returning org-wide HR data for as long as the token existed. The JOIN
 * below closes that: a key whose owner is inactive no longer resolves at all, so
 * it is indistinguishable from a revoked key. Ownerless (system) keys are
 * unaffected — they never borrowed anyone's clearance.
 *
 * @param {string} rawKey
 * @returns {Promise<{id:number,label:string,scope:string,ownerAdminId:number|null,expiresAt:string|null}|null>}
 */
async function validate(rawKey) {
    if (!rawKey || typeof rawKey !== 'string') return null;
    const row = await db.get(
        `SELECT k.id, k.label, k.scope, k.owner_admin_id, k.expires_at
           FROM api_keys k
           LEFT JOIN admins a ON a.id = k.owner_admin_id
          WHERE k.key_hash = ? AND k.revoked_at IS NULL
            AND (k.expires_at IS NULL OR k.expires_at > now())
            AND (k.owner_admin_id IS NULL OR COALESCE(a.is_active, true) = true)`,
        [hashKey(rawKey)]
    );
    if (!row) return null;
    db.run('UPDATE api_keys SET last_used_at = now() WHERE id = ?', [row.id]).catch(() => {});
    return {
        id: Number(row.id),
        label: row.label,
        scope: row.scope,
        // The admin whose clearance this key inherits (null = full-org/system).
        ownerAdminId: row.ownerAdminId != null ? Number(row.ownerAdminId) : null,
        expiresAt: row.expiresAt || null,
    };
}

/**
 * Audit row for a key event. A key is a clearance-scoped data
 * egress to Power BI: who issued or revoked it, for which profile, with which
 * scope and expiry, has to be in the tamper-evident trail. Best-effort like
 * every LogService call; `req` carries the actor and the request facets.
 */
async function audit(action, req, keyId, details) {
    try {
        await require('./LogService').log({
            adminId: req && req.user ? req.user.id : null,
            actorRef: req && req.user ? `${req.user.userType || 'admin'}:${req.user.id}` : null,
            action,
            entityType: 'api_key',
            entityId: keyId,
            category: 'security',
            severity: 'info',
            details,
            ipAddress: req && req.ip ? req.ip : null,
            userAgent: req && req.get ? req.get('user-agent') : null,
            requestId: req && req.id ? req.id : null,
        });
    } catch {
        /* never block the key operation */
    }
}

/**
 * Mint a new key. The raw token is returned ONCE (never stored).
 * @param {{label:string, scope?:string, createdBy:number, ownerAdminId?:number, expiresAt?:string}} opts
 * @param {object} [req]  the issuing request (audit actor / ip / request id)
 */
async function generate(
    { label, scope = 'powerbi.read', createdBy, ownerAdminId = null, expiresAt = null },
    req = null
) {
    if (!label) throw new Error('label is required');
    if (!createdBy) throw new Error('createdBy (admin id) is required');
    const raw = 'ak_' + crypto.randomBytes(24).toString('hex');
    const row = await db.get(
        'INSERT INTO api_keys(label, key_hash, scope, created_by, owner_admin_id, expires_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
        [label, hashKey(raw), scope, createdBy, ownerAdminId, expiresAt]
    );
    const id = Number(row.id);
    await audit(
        'API_KEY_CREATED',
        req || { user: { id: createdBy, userType: 'admin' } },
        id,
        `API key #${id} "${label}" created: scope=${scope}, profile=${ownerAdminId != null ? 'admin ' + ownerAdminId : 'full organisation (system)'}, expires=${expiresAt || 'never'}`
    );
    return { id, label, scope, ownerAdminId, expiresAt, key: raw };
}

/** Revoke a key by id (idempotent). Audited only when a live key was actually revoked. */
async function revoke(id, req = null) {
    const r = await db.run(
        'UPDATE api_keys SET revoked_at = now() WHERE id = ? AND revoked_at IS NULL',
        [id]
    );
    if (r && r.changes) await audit('API_KEY_REVOKED', req, Number(id), `API key #${id} revoked`);
    return r && r.changes ? r.changes : 0;
}

/**
 * Revoke EVERY live key owned by one admin (idempotent). Called when that admin
 * is deactivated or soft-deleted so the de-authorization is durable rather than
 * only enforced at validate time: the keys show as revoked in /admin/api-keys
 * and stay dead even if the account is later re-activated for a different person.
 * @param {number} adminId
 * @returns {Promise<number>} how many keys were revoked by this call
 */
async function revokeByOwner(adminId) {
    const id = Number(adminId);
    if (!Number.isFinite(id) || id <= 0) return 0;
    const rows = await db.all(
        'UPDATE api_keys SET revoked_at = now() WHERE owner_admin_id = ? AND revoked_at IS NULL RETURNING id',
        [id]
    );
    return Array.isArray(rows) ? rows.length : 0;
}

/** List keys (metadata only — never the hash or raw token). */
async function list() {
    const rows = await db.all(
        `SELECT k.id, k.label, k.scope, k.created_by, k.created_at, k.last_used_at,
                k.revoked_at, k.owner_admin_id, k.expires_at,
                o.username AS owner_username, o.role AS owner_role
           FROM api_keys k
           LEFT JOIN admins o ON o.id = k.owner_admin_id
          ORDER BY k.id DESC`
    );
    const now = Date.now();
    return rows.map((r) => ({
        id: Number(r.id),
        label: r.label,
        scope: r.scope,
        createdBy: r.createdBy != null ? Number(r.createdBy) : null,
        createdAt: r.createdAt,
        lastUsedAt: r.lastUsedAt,
        revokedAt: r.revokedAt,
        ownerAdminId: r.ownerAdminId != null ? Number(r.ownerAdminId) : null,
        ownerUsername: r.ownerUsername || null,
        ownerRole: r.ownerRole || null,
        expiresAt: r.expiresAt || null,
        expired: r.expiresAt ? new Date(r.expiresAt).getTime() <= now : false,
        active: !r.revokedAt && !(r.expiresAt && new Date(r.expiresAt).getTime() <= now),
    }));
}

module.exports = { hashKey, validate, generate, revoke, revokeByOwner, list };
