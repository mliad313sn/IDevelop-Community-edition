'use strict';

const db = require('../config/database');
const { resolveAdminScope } = require('../utils/adminScope');
const { PERMISSIONS, BY_SLUG } = require('../config/permissions');

/**
 * DelegationService — who holds what authority, over whom, from whom, until when.
 *
 * WHY A DEDICATED VIEW
 *   The admin form at /admins/:id shows scopes and permissions as EDIT CONTROLS,
 *   which answers "what shall I grant this person?" It cannot answer the two
 *   questions governance actually asks:
 *
 *     · for an ADMINISTRATOR — what can they really do, and over how many people?
 *     · for a SITE or COUNTRY — who has authority over my people?
 *
 *   The second one has no answer anywhere in the product today, and it is the one
 *   a country manager asks when something has been changed on their staff.
 *
 *   Both are computed from the SAME resolver the enforcement path uses
 *   (utils/adminScope), so this screen cannot drift from reality — a delegation
 *   report derived independently would eventually disagree with the system it
 *   describes, which is worse than no report.
 *
 * LOCALISATION: nothing here is a sentence. Flags are `{level, key,
 * params}` and capabilities carry an `origin` code; the view translates
 * `admin:deleg_flag_<key>` / `admin:deleg_origin_<origin>` in the session
 * language, so an English session never reads French service strings.
 */
class DelegationService {
    /**
     * One row per admin: identity, role, scope, reach, capabilities, expiry.
     * `reach` is the number of employees they can actually act on — the honest
     * measure of a delegation, and often a surprise to whoever granted it.
     */
    async buildBreakdown({ viewer } = {}) {
        const admins = await db.all(`
            SELECT a.id, a.username, a.email, a.role,
                   COALESCE(a.is_active, true) AS "isActive",
                   a.created_at AS "createdAt",
                   a.deactivation_reason AS "deactivationReason"
              FROM admins a
             ORDER BY CASE a.role WHEN 'superadmin' THEN 0 WHEN 'localadmin' THEN 1 ELSE 2 END,
                      a.username`);

        // Grants with expiry. `admin_permissions` records WHAT was granted but not
        // BY WHOM — provenance lives in the `admin_access_events` ledger, so it is
        // joined from there (most recent grant event per admin+slug). The ledger
        // may legitimately be empty for grants made before it existed, in which
        // case the origin is reported as UNKNOWN rather than invented; an event
        // reconstructed by migration 110 is reported as a backfill.
        const grants = await db
            .all(
                `
            SELECT ap.admin_id AS "adminId", ap.permission, ap.expires_at AS "expiresAt",
                   ap.created_at AS "grantedAt",
                   ev.actor_admin_id AS "grantedBy",
                   g.username AS "grantedByName",
                   ev.reason AS "grantReason",
                   ev.source AS "eventSource"
              FROM admin_permissions ap
              LEFT JOIN LATERAL (
                    SELECT e.actor_admin_id, e.reason, e.source
                      FROM admin_access_events e
                     WHERE e.admin_id = ap.admin_id
                       AND e.slug = ap.permission
                       AND e.change_type = 'grant'
                     ORDER BY e.created_at DESC
                     LIMIT 1
              ) ev ON true
              LEFT JOIN admins g ON g.id = ev.actor_admin_id
             WHERE ap.revoked_at IS NULL`
            )
            .catch(() => []);

        const scopeRows = await db
            .all(
                `
            SELECT admin_id AS "adminId", scope_type AS "scopeType", expires_at AS "expiresAt"
              FROM admin_scopes WHERE revoked_at IS NULL`
            )
            .catch(() => []);

        const byAdmin = (list) =>
            list.reduce((m, r) => {
                (m[Number(r.adminId)] = m[Number(r.adminId)] || []).push(r);
                return m;
            }, {});
        const grantsBy = byAdmin(grants);
        const scopesBy = byAdmin(scopeRows);

        const now = Date.now();
        const rows = [];
        for (const a of admins) {
            const user = { id: Number(a.id), userType: 'admin', role: a.role };
            let scope;
            try {
                scope = await resolveAdminScope(user, { withLabels: true });
            } catch (_) {
                scope = null;
            }

            const held = (grantsBy[Number(a.id)] || []).filter(
                (g) => !g.expiresAt || new Date(g.expiresAt).getTime() > now
            );
            const expiringGrants = (grantsBy[Number(a.id)] || []).filter(
                (g) => g.expiresAt && new Date(g.expiresAt).getTime() > now
            );
            const expiredGrants = (grantsBy[Number(a.id)] || []).filter(
                (g) => g.expiresAt && new Date(g.expiresAt).getTime() <= now
            );
            const expiredScopes = (scopesBy[Number(a.id)] || []).filter(
                (s) => s.expiresAt && new Date(s.expiresAt).getTime() <= now
            );

            const isSuper = a.role === 'superadmin';
            rows.push({
                id: Number(a.id),
                username: a.username,
                email: a.email,
                role: a.role,
                isActive: a.isActive !== false,
                unrestricted: isSuper,
                // null reach = unrestricted; a number = exactly how many people.
                reach: isSuper ? null : scope ? scope.employeeIds.length : 0,
                sites: isSuper ? null : scope ? scope.siteIds.length : 0,
                scopeSummary: isSuper
                    ? [{ type: 'all', label: null, labelKey: 'admin:tri_scope_org' }]
                    : scope
                      ? scope.scopeSummary
                      : [],
                capabilities: isSuper
                    ? null
                    : held.map((g) => ({
                          slug: g.permission,
                          label:
                              (BY_SLUG[g.permission] && BY_SLUG[g.permission].label) ||
                              g.permission,
                          grantedBy: g.grantedByName || null,
                          grantedAt: g.grantedAt || null,
                          expiresAt: g.expiresAt || null,
                          // 'ledger' = recorded live · 'backfill' = reconstructed by
                          // migration 110 · 'unknown' = predates the ledger, no evidence.
                          origin:
                              g.grantedBy == null
                                  ? 'unknown'
                                  : g.eventSource === 'backfill'
                                    ? 'backfill'
                                    : 'ledger',
                      })),
                capabilityCount: isSuper ? PERMISSIONS.length : held.length,
                expiringCount: expiringGrants.length,
                // Signals worth surfacing rather than leaving for someone to notice.
                flags: this._flags({
                    isSuper,
                    active: a.isActive !== false,
                    reach: isSuper ? null : scope ? scope.employeeIds.length : 0,
                    capCount: held.length,
                    unknownScopeTypes: scope ? scope.unknownScopeTypes : [],
                    expiredGrants: expiredGrants.length,
                    expiredScopes: expiredScopes.length,
                    deactivationReason: a.deactivationReason || null,
                }),
            });
        }
        return rows;
    }

    /**
     * Findings a governance reviewer should not have to derive by eye. Each flag
     * is a KEY plus params; the wording lives in locales (admin:deleg_flag_<key>).
     */
    _flags({
        isSuper,
        active,
        reach,
        capCount,
        unknownScopeTypes,
        expiredGrants,
        expiredScopes,
        deactivationReason,
    }) {
        const f = [];
        if (!active)
            f.push({
                level: 'muted',
                key: 'inactive',
                params: { reason: deactivationReason || '' },
            });
        if (isSuper) {
            f.push({ level: 'warn', key: 'super', params: {} });
            return f;
        }
        // The two shapes that mean a delegation does not work as intended.
        if (capCount === 0 && reach > 0) f.push({ level: 'warn', key: 'scope_no_cap', params: {} });
        if (capCount > 0 && reach === 0) f.push({ level: 'warn', key: 'cap_no_scope', params: {} });
        if (expiredGrants)
            f.push({ level: 'muted', key: 'expired_grants', params: { n: expiredGrants } });
        if (expiredScopes)
            f.push({ level: 'muted', key: 'expired_scopes', params: { n: expiredScopes } });
        if (unknownScopeTypes && unknownScopeTypes.length) {
            f.push({
                level: 'danger',
                key: 'unknown_scope',
                params: { types: unknownScopeTypes.join(', ') },
            });
        }
        return f;
    }

    /**
     * The inverse question, which the product could not answer at all:
     * for each country and site, WHO holds authority over the people there?
     * This is what a country manager asks after an unexpected change to their staff.
     */
    async buildCoverage() {
        const units = await db.all(`
            SELECT c.id AS "countryId", c.name AS "countryName",
                   s.id AS "siteId", s.name AS "siteName",
                   COUNT(e.id)::int AS "headcount"
              FROM countries c
              JOIN sites s     ON s.country_id = c.id
              LEFT JOIN employees e ON e.site_id = s.id AND e.is_active = true
             GROUP BY c.id, c.name, s.id, s.name
             ORDER BY c.name, s.name`);

        const admins = await db.all(
            'SELECT id, username, role FROM admins WHERE COALESCE(is_active, true) = true'
        );

        // Resolve each admin once, then invert — cheaper and consistent.
        const reachBySite = new Map();
        for (const a of admins) {
            if (a.role === 'superadmin') continue; // implicit everywhere; listing them adds noise
            let scope;
            try {
                scope = await resolveAdminScope({
                    id: Number(a.id),
                    userType: 'admin',
                    role: a.role,
                });
            } catch (_) {
                continue;
            }
            for (const sid of scope.siteIds || []) {
                if (!reachBySite.has(sid)) reachBySite.set(sid, []);
                reachBySite.get(sid).push({ id: Number(a.id), username: a.username, role: a.role });
            }
        }

        const byCountry = new Map();
        for (const u of units) {
            const key = Number(u.countryId);
            if (!byCountry.has(key))
                byCountry.set(key, { countryName: u.countryName, sites: [], headcount: 0 });
            const entry = byCountry.get(key);
            const holders = reachBySite.get(Number(u.siteId)) || [];
            entry.sites.push({
                siteId: Number(u.siteId),
                siteName: u.siteName,
                headcount: u.headcount,
                holders,
                // A site with people and no delegate is a governance gap: nobody
                // local can act on them, so every request escalates to a SuperAdmin.
                uncovered: holders.length === 0 && u.headcount > 0,
            });
            entry.headcount += u.headcount;
        }
        return [...byCountry.values()];
    }
}

module.exports = new DelegationService();
