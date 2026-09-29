'use strict';

/**
 * AccessReviewService — the periodic privileged-access review a security/procurement
 * review expects: one row per admin account with role, scope, granted permissions,
 * MFA-enrolment, last sign-in, lock state, status, plus an attestation action that
 * records "reviewer confirmed this access is still appropriate" into the immutable
 * audit log — and reads it back, so the screen can prove completeness.
 *
 * All of this data already exists (admins, admin_scopes, admin_permissions,
 * mfa_secrets, login_attempts, system_logs) — this assembles it in ONE aggregate
 * query (no N+1).
 *
 * The review does not just list access: it NAMES the exceptions a reviewer must
 * act on. The most common real defect in this deployment is not over-broad access
 * but POWERLESS access — an account carrying a scope with zero capability rows, so
 * the holder can reach nothing while the org believes the work is delegated.
 */
const db = require('../config/database');
const LogService = require('./LogService');
const accessProfiles = require('../config/accessProfiles');

const STALE_DAYS = 90;
const EXPIRING_DAYS = 30;
const DECISIONS = Object.freeze(['appropriate', 'revoke']);

/**
 * Which named bundle does this live grant set actually match? (config/accessProfiles.js)
 *
 * `admins.access_profile` records what the account was PROVISIONED from; the grants
 * it produced can be edited afterwards. Deriving the match from the live slugs is
 * therefore how the report tells "provisioned as X and still is" apart from
 * "provisioned as X, since edited" (drift) — and how a legacy account provisioned
 * before the ledger existed still gets a name instead of "Personnalisé".
 * Neither value is ever consulted for authorization; that stays with the grant rows.
 *
 * @param {string[]} slugs granted slugs (as stored, un-expanded)
 * @returns {string|null} profile key, or null when the set matches no bundle
 */
function matchAccessProfile(slugs) {
    const set = new Set(slugs || []);
    if (set.size === 0) return null;
    for (const p of accessProfiles.ACCESS_PROFILES) {
        if (p.slugs.length !== set.size) continue;
        if (p.slugs.every((s) => set.has(s))) return p.key;
    }
    return null;
}

/**
 * `admins.access_profile` arrives with migration 69. Probe for it ONCE per process
 * so both this report and the admin list keep rendering on a database where that
 * migration has not been applied yet (the profile then falls back to derivation).
 */
let _profileColumnPromise = null;
function accessProfileExpr() {
    if (!_profileColumnPromise) {
        _profileColumnPromise = db
            .get(
                `SELECT 1 AS present
                    FROM information_schema.columns
                   WHERE table_schema = 'public'
                     AND table_name = 'admins'
                     AND column_name = 'access_profile'`
            )
            .then((r) => (r ? 'a.access_profile' : 'NULL::text'))
            .catch(() => 'NULL::text');
    }
    return _profileColumnPromise;
}

class AccessReviewService {
    /** @returns {Promise<{rows:Array, summary:Object}>} */
    async buildReport() {
        const profileExpr = await accessProfileExpr();
        // The lock rule is the login guard's own: same threshold, same window.
        const { lockoutPolicy } = require('../middleware/rateLimiter');
        const policy = await lockoutPolicy();
        // Raw SQL (native snake_case): sub-selects keep it to a single round-trip.
        // Expired AND revoked rows are excluded from the live counts (the RBAC
        // read path excludes them too) and reported separately.
        const rows = await db.all(
            `
            SELECT ${profileExpr} AS access_profile,
                   a.id,
                   a.username,
                   a.email,
                   a.role,
                   a.is_active,
                   a.locked_until,
                   a.created_at,
                   a.auth_provider,
                   a.external_id,
                   a.deactivated_at,
                   a.deactivation_reason,
                   (SELECT COUNT(*) FROM admin_permissions ap
                      WHERE ap.admin_id = a.id AND ap.revoked_at IS NULL
                        AND (ap.expires_at IS NULL OR ap.expires_at > now())) AS perm_count,
                   (SELECT string_agg(ap.permission, ', ' ORDER BY ap.permission) FROM admin_permissions ap
                      WHERE ap.admin_id = a.id AND ap.revoked_at IS NULL
                        AND (ap.expires_at IS NULL OR ap.expires_at > now())) AS permissions,
                   (SELECT COUNT(*) FROM admin_scopes acs
                      WHERE acs.admin_id = a.id AND acs.revoked_at IS NULL
                        AND (acs.expires_at IS NULL OR acs.expires_at > now())) AS scope_count,
                   LEAST(
                       (SELECT MIN(ap.expires_at) FROM admin_permissions ap
                          WHERE ap.admin_id = a.id AND ap.revoked_at IS NULL AND ap.expires_at > now()),
                       (SELECT MIN(acs.expires_at) FROM admin_scopes acs
                          WHERE acs.admin_id = a.id AND acs.revoked_at IS NULL AND acs.expires_at > now())
                   ) AS soonest_expires_at,
                   GREATEST(
                       (SELECT MAX(ap.expires_at) FROM admin_permissions ap
                          WHERE ap.admin_id = a.id AND ap.revoked_at IS NULL AND ap.expires_at <= now()),
                       (SELECT MAX(acs.expires_at) FROM admin_scopes acs
                          WHERE acs.admin_id = a.id AND acs.revoked_at IS NULL AND acs.expires_at <= now())
                   ) AS last_expired_at,
                   EXISTS (SELECT 1 FROM mfa_secrets m
                             WHERE m.user_type = 'admin' AND m.user_id = a.id
                               AND m.confirmed_at IS NOT NULL) AS mfa_enrolled,
                   (SELECT MAX(sl.created_at) FROM system_logs sl WHERE sl.admin_id = a.id) AS last_activity,
                   GREATEST(
                       (SELECT MAX(sl.created_at) FROM system_logs sl
                          WHERE sl.admin_id = a.id AND sl.action = 'LOGIN_SUCCESS'),
                       (SELECT MAX(la.attempted_at) FROM login_attempts la
                          WHERE lower(la.username::text) = lower(a.username::text) AND la.successful = true)
                   ) AS last_login_at,
                   (SELECT COUNT(*) FROM login_attempts la
                      WHERE lower(la.username::text) = lower(a.username::text) AND la.successful = false
                        AND la.attempted_at > now() - (? * interval '1 minute')) AS failed_attempts,
                   (SELECT COUNT(*)
                      FROM admin_scopes acs
                      LEFT JOIN sites       s   ON acs.scope_type = 'site'       AND acs.site_id       = s.id
                      LEFT JOIN departments d   ON acs.scope_type = 'department' AND acs.department_id = d.id
                      LEFT JOIN sites       ds  ON d.site_id = ds.id
                      LEFT JOIN services    sv  ON acs.scope_type = 'service'    AND acs.service_id    = sv.id
                      LEFT JOIN departments svd ON sv.department_id = svd.id
                      LEFT JOIN sites       svs ON svd.site_id = svs.id
                     WHERE acs.admin_id = a.id AND acs.revoked_at IS NULL
                       AND (acs.expires_at IS NULL OR acs.expires_at > now())
                       AND COALESCE(s.is_active, ds.is_active, svs.is_active, true) = false) AS inactive_unit_scopes,
                   (SELECT string_agg(DISTINCT COALESCE(s.name, d.name, sv.name, c.name, rg.name), ', ')
                      FROM admin_scopes acs
                      LEFT JOIN sites       s  ON acs.scope_type = 'site'       AND acs.site_id       = s.id
                      LEFT JOIN departments d  ON acs.scope_type = 'department' AND acs.department_id = d.id
                      LEFT JOIN services    sv ON acs.scope_type = 'service'    AND acs.service_id    = sv.id
                      LEFT JOIN countries   c  ON acs.scope_type = 'country'    AND acs.country_id    = c.id
                      LEFT JOIN regions     rg ON acs.scope_type = 'region'     AND acs.region_id     = rg.id
                     WHERE acs.admin_id = a.id AND acs.revoked_at IS NULL
                       AND (acs.expires_at IS NULL OR acs.expires_at > now())) AS scope_summary,
                   (SELECT json_build_object('at', sl.created_at, 'by', act.username, 'decision', sl.details->>'decision')
                      FROM system_logs sl
                      LEFT JOIN admins act ON act.id = sl.admin_id
                     WHERE sl.action = 'ACCESS_REVIEW_ATTEST' AND sl.entity_type = 'admin' AND sl.entity_id = a.id
                     ORDER BY sl.created_at DESC
                     LIMIT 1) AS last_attestation
              FROM admins a
             ORDER BY (a.role = 'superadmin') DESC, a.role, a.username
        `,
            [policy.lockoutMinutes]
        );

        const now = Date.now();
        const staleMs = STALE_DAYS * 24 * 60 * 60 * 1000;
        const expiringMs = EXPIRING_DAYS * 24 * 60 * 60 * 1000;
        const quarterStart = (() => {
            const d = new Date();
            d.setMonth(Math.floor(d.getMonth() / 3) * 3, 1);
            d.setHours(0, 0, 0, 0);
            return d.getTime();
        })();
        const enriched = rows.map((r) => {
            const superadmin = r.role === 'superadmin';
            const last = r.lastActivity ? new Date(r.lastActivity).getTime() : null;
            const stale = last == null || now - last > staleMs;
            // Locked = the same count-in-window rule the login guard applies
            // (the legacy locked_until timestamp is honoured too).
            const failed = Number(r.failedAttempts || 0);
            const locked =
                failed >= policy.maxAttempts ||
                Boolean(r.lockedUntil && new Date(r.lockedUntil).getTime() > now);
            const permCount = superadmin ? null : Number(r.permCount || 0); // null → "all"
            const scopeCount = superadmin ? null : Number(r.scopeCount || 0); // null → org-wide
            const expiresAt = r.soonestExpiresAt ? new Date(r.soonestExpiresAt) : null;
            const lastExpiredAt = r.lastExpiredAt ? new Date(r.lastExpiredAt) : null;
            const expiringSoon = Boolean(expiresAt && expiresAt.getTime() - now <= expiringMs);
            // Nothing live any more but something WAS granted: "Expiré le …", not
            // "never provisioned".
            const expired = Boolean(!superadmin && !expiresAt && lastExpiredAt && permCount === 0);

            // --- The named exceptions a reviewer must act on -----------------
            // 1) scoped but powerless: has a perimeter, holds ZERO capability →
            //    the delegation exists on paper only. This is the single most
            //    common defect here (admin_permissions was empty for everyone).
            const scopedButPowerless = !superadmin && permCount === 0 && scopeCount > 0 && !expired;
            const noMfa = !r.mfaEnrolled;
            const siteInactive = Number(r.inactiveUnitScopes || 0) > 0;
            const permissionSlugs = superadmin
                ? []
                : String(r.permissions || '')
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean);

            const storedProfile = accessProfiles.isProfileKey(r.accessProfile)
                ? r.accessProfile
                : null;
            const derivedProfile = superadmin ? null : matchAccessProfile(permissionSlugs);

            const att =
                r.lastAttestation && typeof r.lastAttestation === 'object'
                    ? r.lastAttestation
                    : null;
            const attestedAt = att && att.at ? new Date(att.at) : null;

            return {
                ...r,
                superadmin,
                accessProfile: superadmin ? null : storedProfile || derivedProfile,
                // "Provisioned as X, but the grants no longer match X" — a review
                // signal, never an authorization input.
                accessProfileDrift: Boolean(
                    !superadmin && storedProfile && derivedProfile !== storedProfile
                ),
                // NULL for a superadmin = organization-wide. The literal string is
                // deliberately NOT baked in here: the UI is French-first, so the
                // wording comes from the locale at render time (admin:tri_scope_org).
                scopeSummary: superadmin ? null : r.scopeSummary || '—',
                orgWide: superadmin,
                permCount,
                scopeCount,
                permissionSlugs,
                expiresAt: expiresAt ? expiresAt.toISOString() : null,
                lastExpiredAt: lastExpiredAt ? lastExpiredAt.toISOString() : null,
                lastLoginAt: r.lastLoginAt ? new Date(r.lastLoginAt).toISOString() : null,
                mfaEnrolled: Boolean(r.mfaEnrolled),
                stale,
                locked: Boolean(locked),
                failedAttempts: failed,
                // Last attestation (date, reviewer, decision) — the evidence an
                // auditor asks for; null = never attested.
                attestedAt: attestedAt ? attestedAt.toISOString() : null,
                attestedBy: att ? att.by || null : null,
                attestDecision: att ? att.decision || null : null,
                reviewedThisQuarter: Boolean(attestedAt && attestedAt.getTime() >= quarterStart),
                // Named exceptions (replace the former single opaque `flag`).
                scopedButPowerless,
                noMfa,
                expiringSoon,
                expired,
                siteInactive,
                exceptions: [
                    scopedButPowerless ? 'scopedButPowerless' : null,
                    noMfa ? 'noMfa' : null,
                    expiringSoon ? 'expiringSoon' : null,
                    expired ? 'expired' : null,
                    locked ? 'locked' : null,
                    siteInactive ? 'siteInactive' : null,
                    stale ? 'stale' : null,
                ].filter(Boolean),
            };
        });

        const active = enriched.filter((r) => r.isActive);
        const summary = {
            total: enriched.length,
            superadmins: enriched.filter((r) => r.superadmin).length,
            scopedButPowerless: active.filter((r) => r.scopedButPowerless).length,
            withoutMfa: active.filter((r) => r.noMfa).length,
            expiringSoon: active.filter((r) => r.expiringSoon).length,
            expired: active.filter((r) => r.expired).length,
            locked: active.filter((r) => r.locked).length,
            siteInactive: active.filter((r) => r.siteInactive).length,
            stale: active.filter((r) => r.stale).length,
            inactive: enriched.filter((r) => !r.isActive).length,
            // "N of M reviewed this quarter" — completeness of the campaign.
            reviewTotal: active.length,
            reviewedThisQuarter: active.filter((r) => r.reviewedThisQuarter).length,
            staleDays: STALE_DAYS,
            expiringDays: EXPIRING_DAYS,
            lockoutMinutes: policy.lockoutMinutes,
        };
        return { rows: enriched, summary };
    }

    /**
     * Record an attestation that a reviewer confirmed an admin's access as of now.
     * This is an append-only audit event (the system_logs hash-chain makes it
     * tamper-evident) — the review evidence a SOC2/ISO auditor asks for.
     * `decision` is closed: 'appropriate' | 'revoke' (anything else is refused).
     */
    async attest(reviewer, targetAdminId, decision = 'appropriate', note = null) {
        if (!DECISIONS.includes(decision)) throw new Error('Unknown review decision');
        const target = await db.get('SELECT id, username, role FROM admins WHERE id = ?', [
            targetAdminId,
        ]);
        if (!target) throw new Error('Admin not found');
        await LogService.log({
            adminId: reviewer && reviewer.id ? reviewer.id : null,
            action: 'ACCESS_REVIEW_ATTEST',
            entityType: 'admin',
            entityId: targetAdminId,
            details: {
                target: target.username,
                targetRole: target.role,
                decision, // 'appropriate' | 'revoke'
                note: note || null,
                reviewedBy: reviewer && reviewer.username ? reviewer.username : null,
            },
        });
        return { ok: true, target: target.username, decision };
    }
}

const instance = new AccessReviewService();
// Shared with AdminController.index so the admin list derives the profile with
// exactly the same rule as the review (one definition, two surfaces).
instance.matchAccessProfile = matchAccessProfile;
instance.accessProfileExpr = accessProfileExpr;
instance.STALE_DAYS = STALE_DAYS;
instance.EXPIRING_DAYS = EXPIRING_DAYS;
instance.DECISIONS = DECISIONS;

module.exports = instance;
