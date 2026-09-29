'use strict';

/**
 * MyAccessController — « Mon accès » (GET /mon-acces).
 *
 * The counterpart to the explanatory 403: instead of discovering a missing right
 * by hitting a wall, an admin can read their own access in one page —
 *   « Mon périmètre »  : the org scope they were assigned, in plain French, with
 *                        the resolved names, how many employees it covers, and
 *                        when (if ever) it expires;
 *   « Mes capacités »  : the whole catalogue by group, marking what they hold
 *                        and what they do not.
 *
 * Strictly self-service: every query is keyed on req.user.id. Nothing about any
 * other account is read here.
 */

const db = require('../config/database');
const RBACService = require('../services/RBACService');
const AdminPermissionModel = require('../models/AdminPermissionModel');
const { PERMISSIONS, GROUPS } = require('../config/permissions');

// Catalogue group name → the existing `admin:permgroup.*` dictionary key (the
// catalogue itself is English-only; the FR/EN wording already lives in locales).
const GROUP_KEY = {
    'People & Assessments': 'people_assessments',
    Configuration: 'configuration',
    Data: 'data',
    Governance: 'governance',
    'Talent Continuity & Learning': 'continuity_learning',
    'Operational Compliance': 'operational_compliance',
};

class MyAccessController {
    async page(req, res) {
        // Admins only. A manager/employee has no scope-and-capability model to
        // show — they are governed by their reporting line — so bounce them home.
        if (!req.user || req.user.userType !== 'admin') {
            req.flash(
                'error',
                req.t
                    ? req.t('admin:acc_admins_only', {
                          defaultValue: 'Cette page est réservée aux comptes administrateurs.',
                      })
                    : 'Cette page est réservée aux comptes administrateurs.'
            );
            return res.redirect('/employee/dashboard');
        }

        const t = (key, fallback) => (req.t ? req.t(key, { defaultValue: fallback }) : fallback);
        const isSuper = req.user.role === 'superadmin';
        const now = Date.now();

        // ---- « Mon périmètre » -------------------------------------------------
        // Every scope row (expired ones INCLUDED, flagged) with its resolved name
        // and its parent chain — department/service names legitimately repeat
        // across sites, so the bare name would be ambiguous.
        let scopes = [];
        if (!isSuper) {
            try {
                scopes = await db.all(
                    `SELECT acs.scope_type,
                            acs.expires_at,
                            COALESCE(s.name, d.name, sv.name, c.name, rg.name) AS scope_name,
                            COALESCE(ds.name, svs.name)               AS parent_site,
                            svd.name                                  AS parent_department
                       FROM admin_scopes acs
                       LEFT JOIN sites       s   ON acs.scope_type = 'site'       AND acs.site_id       = s.id
                       LEFT JOIN departments d   ON acs.scope_type = 'department' AND acs.department_id = d.id
                       LEFT JOIN sites       ds  ON d.site_id = ds.id
                       LEFT JOIN services    sv  ON acs.scope_type = 'service'    AND acs.service_id    = sv.id
                       LEFT JOIN departments svd ON sv.department_id = svd.id
                       LEFT JOIN sites       svs ON svd.site_id = svs.id
                       LEFT JOIN countries   c   ON acs.scope_type = 'country'    AND acs.country_id    = c.id
                       LEFT JOIN regions     rg  ON acs.scope_type = 'region'     AND acs.region_id     = rg.id
                      WHERE acs.admin_id = ? AND acs.revoked_at IS NULL
                      ORDER BY acs.scope_type`,
                    [req.user.id]
                );
            } catch (_) {
                scopes = [];
            }
        }

        scopes = scopes.map((s) => ({
            scopeType: s.scopeType,
            name: s.scopeName || t('admin:acc_scope_unknown', '(supprimé)'),
            parentSite: s.parentSite || null,
            parentDepartment: s.parentDepartment || null,
            expiresAt: s.expiresAt || null,
            expired: Boolean(s.expiresAt && new Date(s.expiresAt).getTime() <= now),
        }));

        // Employees covered: superadmin = the whole active population; otherwise
        // the union of the still-effective scopes (country expanded to its sites,
        // mirroring rbacMiddleware so the number matches what they actually see).
        let employeeCount = 0;
        try {
            if (isSuper) {
                const r = await db.get(
                    'SELECT COUNT(*) AS n FROM employees WHERE COALESCE(is_active, true) = true'
                );
                employeeCount = Number((r && (r.n ?? Object.values(r)[0])) || 0);
            } else {
                const live = await db.all(
                    `SELECT scope_type, site_id, department_id, service_id, country_id, region_id
                       FROM admin_scopes
                      WHERE admin_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
                    [req.user.id]
                );
                const siteIds = [];
                const deptIds = [];
                const svcIds = [];
                const countryIds = [];
                const regionIds = [];
                live.forEach((s) => {
                    if (s.scopeType === 'site' && s.siteId) siteIds.push(Number(s.siteId));
                    if (s.scopeType === 'department' && s.departmentId)
                        deptIds.push(Number(s.departmentId));
                    if (s.scopeType === 'service' && s.serviceId) svcIds.push(Number(s.serviceId));
                    if (s.scopeType === 'country' && s.countryId)
                        countryIds.push(Number(s.countryId));
                    if (s.scopeType === 'region' && s.regionId) regionIds.push(Number(s.regionId));
                });
                // Region sits above country: its countries' sites count too.
                if (regionIds.length) {
                    const rows = await db.all(
                        `SELECT id FROM countries WHERE region_id IN (${regionIds.map(() => '?').join(',')})`,
                        regionIds
                    );
                    rows.forEach((r) => countryIds.push(Number(r.id)));
                }
                if (countryIds.length) {
                    const rows = await db.all(
                        `SELECT id FROM sites WHERE country_id IN (${countryIds.map(() => '?').join(',')})`,
                        countryIds
                    );
                    rows.forEach((r) => siteIds.push(Number(r.id)));
                }
                const clauses = [];
                const params = [];
                if (siteIds.length) {
                    clauses.push(`e.site_id IN (${siteIds.map(() => '?').join(',')})`);
                    params.push(...siteIds);
                }
                if (deptIds.length) {
                    clauses.push(`e.department_id IN (${deptIds.map(() => '?').join(',')})`);
                    params.push(...deptIds);
                }
                if (svcIds.length) {
                    clauses.push(`e.service_id IN (${svcIds.map(() => '?').join(',')})`);
                    params.push(...svcIds);
                }
                if (clauses.length) {
                    const r = await db.get(
                        `SELECT COUNT(DISTINCT e.id) AS n FROM employees e
                          WHERE COALESCE(e.is_active, true) = true AND (${clauses.join(' OR ')})`,
                        params
                    );
                    employeeCount = Number((r && (r.n ?? Object.values(r)[0])) || 0);
                }
            }
        } catch (_) {
            employeeCount = 0;
        }

        // Expiry of the delegation itself: the earliest of the scope expiry and
        // the permission-grant expiry (a time-bound delegation sets both).
        let expiresAt = null;
        try {
            const permExpiry = isSuper
                ? null
                : await AdminPermissionModel.getExpiryForAdmin(req.user.id);
            const candidates = scopes
                .filter((s) => s.expiresAt && !s.expired)
                .map((s) => new Date(s.expiresAt).getTime());
            if (permExpiry) candidates.push(new Date(permExpiry).getTime());
            if (candidates.length) expiresAt = new Date(Math.min(...candidates));
        } catch (_) {
            expiresAt = null;
        }

        // ---- « Mes capacités » -------------------------------------------------
        // The whole catalogue, grouped, with held / not-held per slug. `granted`
        // vs `held` differ for a Viewer holding a stored write grant: it is on the
        // record but can never be exercised — worth saying out loud.
        const stored = Array.isArray(req.user.permissions) ? req.user.permissions : [];
        const capabilityGroups = GROUPS.map((g) => {
            const items = PERMISSIONS.filter((p) => p.group === g).map((p) => {
                const held = RBACService.hasPermission(req.user, p.slug);
                const granted = isSuper || stored.includes(p.slug);
                return {
                    slug: p.slug,
                    // Translated label/description with the English catalogue string
                    // as defaultValue — a newly added slug degrades to English rather
                    // than printing a raw i18n key on the French-first UI.
                    label: t(`admin:perm.${p.slug}.label`, p.label),
                    description: t(`admin:perm.${p.slug}.desc`, p.description),
                    write: Boolean(p.write),
                    held,
                    // Stored but neutralised by the read-only Viewer role.
                    neutralised: granted && !held,
                };
            });
            return {
                group: g,
                label: GROUP_KEY[g] ? t(`admin:permgroup.${GROUP_KEY[g]}`, g) : g,
                items,
                heldCount: items.filter((i) => i.held).length,
            };
        }).filter((g) => g.items.length);

        const heldTotal = capabilityGroups.reduce((n, g) => n + g.heldCount, 0);
        const catalogueTotal = PERMISSIONS.length;

        return res.render('pages/account/my-access', {
            title: t('admin:acc_page_title', 'Mon accès'),
            isSuper,
            roleKey: req.user.role,
            scopes,
            employeeCount,
            expiresAt,
            capabilityGroups,
            heldTotal,
            catalogueTotal,
        });
    }
}

module.exports = new MyAccessController();
