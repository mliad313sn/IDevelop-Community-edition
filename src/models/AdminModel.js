'use strict';

const BaseModel = require('./BaseModel');
const db = require('../config/database');
// THE "this clearance is live" rule, defined once (see the module header): the
// authority read below, GovernanceService and the orphan worklist / Setup
// checklist all consume this same predicate so they cannot diverge again.
const { liveAdminScopeSql } = require('../utils/reviewerGapSql');

class AdminModel extends BaseModel {
    static tableNamePg = 'admins';
    static columnMap = {
        passwordHash: 'password_hash',
        isActive: 'is_active',
        passwordChangedAt: 'password_changed_at',
        forcePasswordChange: 'force_password_change',
        lockedUntil: 'locked_until',
        workspacePrefs: 'workspace_prefs',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
        deactivatedAt: 'deactivated_at',
        deactivatedBy: 'deactivated_by',
        deactivationReason: 'deactivation_reason',
    };

    constructor() {
        super('admins');
    }

    async findByUsername(username) {
        return await this.findOne({ username });
    }

    async findByEmail(email) {
        return await this.findOne({ email });
    }

    /**
     * The admin with the scopes that CONFER AUTHORITY right now — expired and
     * revoked rows excluded. This is what deserializeUser puts on req.user and
     * what every RBACService.canAccess* check reads, so it must never widen:
     * a row revoked by "Désactiver" (migration 110) confers nothing even if the
     * account is switched back on by hand.
     */
    async findWithScopes(adminId) {
        const admin = await this.findById(adminId);
        if (!admin) return null;

        const scopes = await db.all(
            `
            SELECT acs.*,
                   CASE
                       WHEN acs.scope_type = 'site'       THEN s.name
                       WHEN acs.scope_type = 'department' THEN d.name
                       WHEN acs.scope_type = 'service'    THEN sv.name
                       WHEN acs.scope_type = 'country'    THEN c.name
                       WHEN acs.scope_type = 'region'     THEN rg.name
                   END as "scopeName"
            FROM admin_scopes acs
            LEFT JOIN sites       s  ON acs.scope_type = 'site'       AND acs.site_id       = s.id
            LEFT JOIN departments d  ON acs.scope_type = 'department' AND acs.department_id = d.id
            LEFT JOIN services    sv ON acs.scope_type = 'service'    AND acs.service_id    = sv.id
            LEFT JOIN countries   c  ON acs.scope_type = 'country'    AND acs.country_id    = c.id
            LEFT JOIN regions     rg ON acs.scope_type = 'region'     AND acs.region_id     = rg.id
            WHERE acs.admin_id = ?
              AND ${liveAdminScopeSql('acs')}
        `,
            [adminId]
        );
        return { ...admin, scopes };
    }

    /**
     * The admin with EVERY scope row for the edit form: expired
     * rows come back flagged `expired` instead of vanishing (a plain re-save used
     * to delete them silently), revoked rows flagged `revoked`, and a scope on a
     * deactivated site — or whose parent site is deactivated — flagged
     * `unitInactive` so the operator is told to re-scope instead of losing the
     * row. NEVER an authority read: use findWithScopes for that.
     */
    async findWithScopeHistory(adminId) {
        const admin = await this.findById(adminId);
        if (!admin) return null;

        const rows = await db.all(
            `
            SELECT acs.*,
                   CASE
                       WHEN acs.scope_type = 'site'       THEN s.name
                       WHEN acs.scope_type = 'department' THEN d.name
                       WHEN acs.scope_type = 'service'    THEN sv.name
                       WHEN acs.scope_type = 'country'    THEN c.name
                       WHEN acs.scope_type = 'region'     THEN rg.name
                   END AS "scopeName",
                   (acs.expires_at IS NOT NULL AND acs.expires_at <= now()) AS "expired",
                   (acs.revoked_at IS NOT NULL)                              AS "revoked",
                   (COALESCE(s.is_active, ds.is_active, svs.is_active, true) = false) AS "unitInactive"
            FROM admin_scopes acs
            LEFT JOIN sites       s   ON acs.scope_type = 'site'       AND acs.site_id       = s.id
            LEFT JOIN departments d   ON acs.scope_type = 'department' AND acs.department_id = d.id
            LEFT JOIN sites       ds  ON d.site_id = ds.id
            LEFT JOIN services    sv  ON acs.scope_type = 'service'    AND acs.service_id    = sv.id
            LEFT JOIN departments svd ON sv.department_id = svd.id
            LEFT JOIN sites       svs ON svd.site_id = svs.id
            LEFT JOIN countries   c   ON acs.scope_type = 'country'    AND acs.country_id    = c.id
            LEFT JOIN regions     rg  ON acs.scope_type = 'region'     AND acs.region_id     = rg.id
            WHERE acs.admin_id = ?
            ORDER BY acs.revoked_at NULLS FIRST, acs.scope_type, acs.id
        `,
            [adminId]
        );
        return { ...admin, scopes: rows };
    }

    // --- Fail closed on the retired role tiers --------------------------------
    // The Postgres `admin_role` enum still carries regional_admin / country_admin /
    // site_admin / hr_bp from an early tiered design that was never built. They are
    // NOT inert: code paths used to grant real power on the role NAME alone, with
    // zero rows in admin_permissions — i.e. outside `_assignableSlugs` and outside
    // every access review. Those branches are now catalogue-driven, and no account
    // may be created or moved into one of the dead tiers. (The enum values stay:
    // dropping a PG enum label in place is unsafe. Tier is expressed by
    // profile x scope instead.)
    static SUPPORTED_ROLES = new Set(['superadmin', 'localadmin', 'viewer']);

    _assertRole(data) {
        if (!data || data.role === undefined || data.role === null) return;
        if (!AdminModel.SUPPORTED_ROLES.has(String(data.role))) {
            throw new Error(
                `Unsupported admin role "${data.role}". Use superadmin, localadmin or viewer — ` +
                    'scope and access profile express seniority, not the role name.'
            );
        }
    }

    async create(data) {
        this._assertRole(data);
        return super.create(data);
    }

    async update(id, data) {
        this._assertRole(data);
        return super.update(id, data);
    }
}

module.exports = new AdminModel();
