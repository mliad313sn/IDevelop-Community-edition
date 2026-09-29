const SiteModel = require('../models/SiteModel');
const DepartmentModel = require('../models/DepartmentModel');
const ServiceModel = require('../models/ServiceModel');
const RBACService = require('../services/RBACService');
const LogService = require('../services/LogService');
const db = require('../config/database');
const {
    siteValidation,
    departmentValidation,
    serviceValidation,
    keepDraft,
} = require('../utils/validators');

/**
 * Where to land after a write. A unit can be acted on from the unified hub
 * (/organization?tab=…) or from the stand-alone list page, and bouncing the
 * admin to the other one loses their place. The form posts `from=hub|page`;
 * both destinations are literals here, so this can never become an open
 * redirect (CWE-601) whatever the client sends.
 */
const ORG_RETURN = {
    site: { page: '/organization/sites', hub: '/organization?tab=sites' },
    department: { page: '/organization/departments', hub: '/organization?tab=departments' },
    service: { page: '/organization/services', hub: '/organization?tab=services' },
};
function backTo(req, kind) {
    return String(req.body.from || '') === 'hub' ? ORG_RETURN[kind].hub : ORG_RETURN[kind].page;
}

const EMP_UNIT_COLUMN = { site: 'site_id', department: 'department_id', service: 'service_id' };

/** Does the caller govern this country — directly, or through its region? */
async function canReachCountry(user, countryId) {
    if (RBACService.isSuperAdmin(user)) return true;
    if (!countryId) return false;
    if (await RBACService.canAccessCountry(user, countryId)) return true;
    const hit = await db.get(
        `SELECT 1 AS ok
           FROM countries c
           JOIN admin_scopes a ON a.region_id = c.region_id
          WHERE c.id = ? AND a.admin_id = ? AND a.scope_type = 'region'
            AND a.revoked_at IS NULL
            AND (a.expires_at IS NULL OR a.expires_at > now())
          LIMIT 1`,
        [Number(countryId), Number(user.id)]
    );
    return !!hit;
}

/**
 * 3.23.17 (A-6): may the caller RE-PARENT this unit to `rawParent`? The unit
 * itself was already scope-checked; re-parenting also writes into the
 * DESTINATION (another site / department / country), so that must be governed
 * too — and, for a site leaving a country, the ORIGIN as well. An unchanged
 * parent is always allowed (a plain rename). SuperAdmin is unrestricted.
 * FAILS CLOSED on an unknown kind or a missing unit.
 */
async function parentMoveAllowed(user, kind, id, rawParent) {
    if (RBACService.isSuperAdmin(user)) return true;
    const next = rawParent ? parseInt(rawParent, 10) || null : null;
    if (kind === 'site') {
        const cur = await SiteModel.findById(id);
        if (!cur) return false;
        const curC = cur.countryId != null ? Number(cur.countryId) : null;
        if (curC === next) return true;
        if (next && !(await canReachCountry(user, next))) return false;
        if (curC && !(await canReachCountry(user, curC))) return false;
        return true;
    }
    if (kind === 'department') {
        const cur = await DepartmentModel.findById(id);
        if (!cur) return false;
        if (next && Number(cur.siteId) === next) return true;
        return !!next && (await RBACService.canAccessSite(user, next));
    }
    if (kind === 'service') {
        const cur = await ServiceModel.findById(id);
        if (!cur) return false;
        if (next && Number(cur.departmentId) === next) return true;
        return !!next && (await RBACService.canAccessDepartment(user, next));
    }
    return false;
}

/**
 * Active employees still attached to one org unit. This is the amputation guard:
 * deactivating a unit hides it from every dropdown, cascade and report filter, so
 * anybody still attached becomes un-editable and effectively invisible. Callers
 * refuse the deactivation while this is > 0.
 */
async function attachedEmployeeCount(kind, id) {
    const col = EMP_UNIT_COLUMN[kind];
    if (!col) return 0;
    const row = await db.get(
        `SELECT COUNT(*)::int AS n FROM employees WHERE ${col} = ? AND is_active = true`,
        [id]
    );
    return Number(row && row.n ? row.n : 0);
}

/**
 * Headcount + child-unit counts for the WHOLE tree in 6 grouped queries (never one
 * per row). Feeds two things: the disabled/enabled state of each Deactivate button
 * and the confirmation dialog's "here is exactly what disappears" sentence.
 */
async function orgCounters() {
    const toMap = (rows) => new Map(rows.map((r) => [Number(r.k), Number(r.n)]));
    const [empBySite, empByDept, empBySvc, deptsBySite, svcsBySite, svcsByDept] = (
        await Promise.all([
            db.all(
                `SELECT site_id AS k, COUNT(*)::int AS n FROM employees
                  WHERE is_active = true AND site_id IS NOT NULL GROUP BY site_id`
            ),
            db.all(
                `SELECT department_id AS k, COUNT(*)::int AS n FROM employees
                  WHERE is_active = true AND department_id IS NOT NULL GROUP BY department_id`
            ),
            db.all(
                `SELECT service_id AS k, COUNT(*)::int AS n FROM employees
                  WHERE is_active = true AND service_id IS NOT NULL GROUP BY service_id`
            ),
            db.all(
                `SELECT site_id AS k, COUNT(*)::int AS n FROM departments
                  WHERE is_active = true GROUP BY site_id`
            ),
            db.all(
                `SELECT d.site_id AS k, COUNT(*)::int AS n
                   FROM services sv INNER JOIN departments d ON d.id = sv.department_id
                  WHERE sv.is_active = true AND d.is_active = true GROUP BY d.site_id`
            ),
            db.all(
                `SELECT department_id AS k, COUNT(*)::int AS n FROM services
                  WHERE is_active = true GROUP BY department_id`
            ),
        ])
    ).map(toMap);
    return { empBySite, empByDept, empBySvc, deptsBySite, svcsBySite, svcsByDept };
}

/** Attach empCount/deptCount/svcCount so the views can render the guard inline. */
function decorateUnits(counters, { sites = [], departments = [], services = [] }) {
    sites.forEach((s) => {
        const id = Number(s.id);
        s.empCount = counters.empBySite.get(id) || 0;
        s.deptCount = counters.deptsBySite.get(id) || 0;
        s.svcCount = counters.svcsBySite.get(id) || 0;
    });
    departments.forEach((d) => {
        const id = Number(d.id);
        d.empCount = counters.empByDept.get(id) || 0;
        d.svcCount = counters.svcsByDept.get(id) || 0;
    });
    services.forEach((s) => {
        s.empCount = counters.empBySvc.get(Number(s.id)) || 0;
    });
}

const isActiveRow = (u) => !(u.isActive === false || u.isActive === 0);

/**
 * The deactivated units of the org tree, scoped to what the caller may manage.
 * Without this list a deactivation is irreversible from the UI: the unit vanishes
 * from every list and there is no way back. Each row also carries the number of
 * people still attached (stranded) and whether its PARENT is still active — a
 * child cannot usefully come back under a hidden parent.
 */
async function deactivatedUnits(user, counters) {
    const sites = await db.all(
        'SELECT id, name, code FROM sites WHERE is_active = false ORDER BY name'
    );
    const departments = await db.all(
        `SELECT d.id, d.name, d.code, d.site_id, st.name AS site_name, st.is_active AS site_active
           FROM departments d INNER JOIN sites st ON st.id = d.site_id
          WHERE d.is_active = false
          ORDER BY st.name, d.name`
    );
    const services = await db.all(
        `SELECT sv.id, sv.name, sv.code, sv.department_id,
                d.name AS department_name, d.is_active AS department_active,
                st.name AS site_name, st.is_active AS site_active
           FROM services sv
           INNER JOIN departments d ON d.id = sv.department_id
           INNER JOIN sites st ON st.id = d.site_id
          WHERE sv.is_active = false
          ORDER BY st.name, d.name, sv.name`
    );

    // A scoped local admin only sees — and may only restore — units inside their scope.
    const keep = async (rows, can) => {
        const ok = await Promise.all(rows.map((r) => can(r)));
        return rows.filter((_, i) => ok[i]);
    };
    const scopedSites = await keep(sites, (r) => RBACService.canAccessSite(user, Number(r.id)));
    const scopedDepartments = await keep(departments, (r) =>
        RBACService.canAccessDepartment(user, Number(r.id))
    );
    const scopedServices = await keep(services, (r) =>
        RBACService.canAccessService(user, Number(r.id))
    );

    decorateUnits(counters, {
        sites: scopedSites,
        departments: scopedDepartments,
        services: scopedServices,
    });
    return { sites: scopedSites, departments: scopedDepartments, services: scopedServices };
}

const EMPTY_DEACTIVATED = { sites: [], departments: [], services: [] };

class OrganizationController {
    // Unified Organization Index
    async index(req, res) {
        try {
            const canManageOrg = RBACService.hasPermission(req.user, 'manage_organization');
            const allSitesInScope = await RBACService.getFilteredSites(req.user);
            const departments = await RBACService.getFilteredDepartments(req.user);
            const services = await RBACService.getFilteredServices(req.user);
            // getFilteredSites returns every row (no is_active filter): a deactivated
            // site used to sit in this table looking perfectly normal. Split it out.
            const sites = allSitesInScope.filter(isActiveRow);

            // Attach each site's operating country for the hub's Sites tab.
            const cmap = new Map(
                (await db.all('SELECT id, name FROM countries')).map((c) => [Number(c.id), c.name])
            );
            sites.forEach((s) => {
                s.countryName = cmap.get(Number(s.countryId ?? s.country_id)) || null;
            });

            const counters = await orgCounters();
            decorateUnits(counters, { sites, departments, services });
            const deactivated = canManageOrg
                ? await deactivatedUnits(req.user, counters)
                : EMPTY_DEACTIVATED;

            // Get all sites for dropdowns
            const allSites = await SiteModel.findAll({ isActive: 1 }, 'name ASC');
            const allDepartments = await DepartmentModel.findWithSite();

            // Get Employees (filtered by RBAC)
            const employees = await RBACService.getFilteredEmployees(req.user);

            res.render('pages/organization/index', {
                title: req.t ? req.t('chrome:pt_organization') : 'Organization',
                sites,
                departments,
                services,
                employees,
                allSites,
                allDepartments,
                canManageOrg,
                deactivated,
                activeTab: req.query.tab || 'sites',
            });
        } catch (error) {
            console.error('Organization index error:', error);
            req.flash(
                'error',
                req.t ? req.t('flash:org_load_error') : 'Error loading organization data'
            );
            res.redirect('/dashboard');
        }
    }

    // Sites
    async sitesIndex(req, res) {
        try {
            const canManageOrg = RBACService.hasPermission(req.user, 'manage_organization');
            const sites = (await RBACService.getFilteredSites(req.user)).filter(isActiveRow);
            // The country each site OPERATES in — drives the Local Content report's
            // "national vs expatriate" classification. Provide the full country list for
            // the site dropdown and attach each site's country name for display.
            const countries = await db.all(
                `SELECT c.id, c.name, c.code, r.name AS region_name
                   FROM countries c LEFT JOIN regions r ON r.id = c.region_id
                  ORDER BY r.name NULLS FIRST, c.name`
            );
            const cmap = new Map(countries.map((c) => [Number(c.id), c.name]));
            sites.forEach((s) => {
                s.countryName = cmap.get(Number(s.countryId ?? s.country_id)) || null;
            });

            const counters = await orgCounters();
            decorateUnits(counters, { sites });
            const deactivated = canManageOrg
                ? await deactivatedUnits(req.user, counters)
                : EMPTY_DEACTIVATED;

            res.render('pages/organization/sites', {
                title: req.t ? req.t('chrome:pt_sites') : 'Sites',
                sites,
                countries,
                canManageOrg,
                deactivated,
            });
        } catch (error) {
            console.error('Sites index error:', error);
            req.flash('error', req.t ? req.t('flash:site_list_load_error') : 'Error loading sites');
            res.redirect('/dashboard');
        }
    }

    /**
     * Create a country (with its region) so sites can be assigned an operating country.
     * Upserts the region by name (regions.region_id/code are NOT NULL), then the country.
     * manage_organization / SuperAdmin only.
     */
    async countriesCreate(req, res) {
        try {
            if (!RBACService.hasPermission(req.user, 'manage_organization')) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:site_create_superadmin')
                        : 'Only SuperAdmins can manage geography'
                );
                return res.redirect('/organization/sites');
            }
            const name = String(req.body.name || '').trim();
            if (!name) {
                req.flash(
                    'error',
                    req.t ? req.t('flash:country_name_required') : 'Country name is required'
                );
                return res.redirect('/organization/sites');
            }
            const code = (String(req.body.code || '').trim() || name.slice(0, 3))
                .toUpperCase()
                .slice(0, 8);
            const regionName = String(req.body.regionName || '').trim() || 'Global';

            let region = await db.get('SELECT id FROM regions WHERE lower(name) = lower(?)', [
                regionName,
            ]);
            if (!region) {
                await db.run('INSERT INTO regions (code, name) VALUES (?, ?)', [
                    regionName.slice(0, 8).toUpperCase(),
                    regionName,
                ]);
                region = await db.get('SELECT id FROM regions WHERE lower(name) = lower(?)', [
                    regionName,
                ]);
            }
            const existing = await db.get('SELECT id FROM countries WHERE lower(name) = lower(?)', [
                name,
            ]);
            if (existing) {
                req.flash(
                    'error',
                    req.t ? req.t('flash:country_exists') : `Country "${name}" already exists`
                );
                return res.redirect('/organization/sites');
            }
            await db.run('INSERT INTO countries (code, name, region_id) VALUES (?, ?, ?)', [
                code,
                name,
                region.id,
            ]);

            await LogService.log({
                adminId: req.user.id,
                action: 'COUNTRY_CREATED',
                entityType: 'country',
                details: `Created country: ${name} [${code}] in region ${regionName}`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
            req.flash(
                'success',
                req.t ? req.t('flash:country_created', { name }) : `Country "${name}" added.`
            );
            res.redirect('/organization/sites');
        } catch (error) {
            console.error('Country create error:', error);
            req.flash(
                'error',
                req.t ? req.t('flash:country_create_error') : 'Error creating country'
            );
            res.redirect('/organization/sites');
        }
    }

    async sitesCreate(req, res) {
        try {
            if (!RBACService.hasPermission(req.user, 'manage_organization')) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:site_create_superadmin')
                        : 'Only SuperAdmins can create sites'
                );
                return res.redirect('/organization/sites');
            }

            await SiteModel.create({
                name: req.body.name.trim(),
                code: req.body.code?.trim() || null,
                description: req.body.description?.trim() || null,
                countryId: req.body.countryId ? Number(req.body.countryId) : null,
                isActive: 1,
            });

            await LogService.log({
                adminId: req.user.id,
                action: 'SITE_CREATED',
                entityType: 'site',
                details: `Created site: ${req.body.name}`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            req.flash('success', req.t ? req.t('flash:site_created') : 'Site created successfully');
            res.redirect(backTo(req, 'site'));
        } catch (error) {
            console.error('Site create error:', error);
            req.flash('error', req.t ? req.t('flash:site_create_error') : 'Error creating site');
            res.redirect(keepDraft(req, backTo(req, 'site')));
        }
    }

    async sitesUpdate(req, res) {
        try {
            const { id } = req.params;
            const canManage = await RBACService.canAccessSite(req.user, parseInt(id));
            if (!canManage) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:site_update_denied')
                        : 'You do not have permission to update this site'
                );
                return res.redirect('/organization/sites');
            }

            // Reactivation — the way back from a deactivated site. Posted by the
            // "Unités désactivées" panel, which re-sends the unit's own name so the
            // shared siteValidation still passes; nothing else is touched.
            if (String(req.body.reactivate) === '1') {
                const site = await SiteModel.findById(id);
                if (!site) {
                    req.flash(
                        'error',
                        req.t ? req.t('admin:org_unit_not_found') : 'Unit not found'
                    );
                    return res.redirect(backTo(req, 'site'));
                }
                await SiteModel.update(id, { isActive: 1 });
                await LogService.log({
                    adminId: req.user.id,
                    action: 'SITE_REACTIVATED',
                    entityType: 'site',
                    entityId: id,
                    details: `Reactivated site: ${site.name}`,
                    ipAddress: req.ip,
                    userAgent: req.get('user-agent'),
                });
                req.flash(
                    'success',
                    req.t
                        ? req.t('admin:org_site_reactivated', { name: site.name })
                        : `Site "${site.name}" is active again.`
                );
                return res.redirect(backTo(req, 'site'));
            }

            // 3.23.17 (A-6): moving a site to another country moves it (and its
            // people) into another delegate's perimeter. A non-SuperAdmin may
            // change it only between countries they themselves govern.
            if (!(await parentMoveAllowed(req.user, 'site', id, req.body.countryId))) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:site_update_denied')
                        : 'You do not have permission to update this site'
                );
                return res.redirect(backTo(req, 'site'));
            }

            await SiteModel.update(id, {
                name: req.body.name.trim(),
                code: req.body.code?.trim() || null,
                description: req.body.description?.trim() || null,
                countryId: req.body.countryId ? Number(req.body.countryId) : null,
            });

            await LogService.log({
                adminId: req.user.id,
                action: 'SITE_UPDATED',
                entityType: 'site',
                entityId: id,
                details: `Updated site: ${req.body.name}`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            req.flash('success', req.t ? req.t('flash:site_updated') : 'Site updated successfully');
            res.redirect(backTo(req, 'site'));
        } catch (error) {
            console.error('Site update error:', error);
            req.flash('error', req.t ? req.t('flash:site_update_error') : 'Error updating site');
            res.redirect(keepDraft(req, backTo(req, 'site')));
        }
    }

    /**
     * Deactivate a site. NOT a delete: the row survives with is_active = false and
     * can be restored from the "Unités désactivées" panel. Refused outright while
     * active employees are still attached — hiding their site strands them (they
     * drop out of every filter and their edit form can no longer resolve the unit).
     */
    async sitesDelete(req, res) {
        try {
            const { id } = req.params;
            if (!RBACService.hasPermission(req.user, 'manage_organization')) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:site_delete_superadmin')
                        : 'Only SuperAdmins can delete sites'
                );
                return res.redirect('/organization/sites');
            }
            // 3.23.17 (A-6): the capability is not the perimeter — a delegate
            // holding manage_organization may deactivate only a site they govern.
            if (!(await RBACService.canAccessSite(req.user, parseInt(id, 10)))) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:site_update_denied')
                        : 'You do not have permission to update this site'
                );
                return res.redirect('/organization/sites');
            }

            const attached = await attachedEmployeeCount('site', parseInt(id));
            if (attached > 0) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('admin:org_deactivate_blocked', { count: attached })
                        : `Cannot deactivate: ${attached} active employee(s) are still attached. Move them to another unit first.`
                );
                return res.redirect(backTo(req, 'site'));
            }

            const site = await SiteModel.findById(id);
            await SiteModel.update(id, { isActive: 0 });

            await LogService.log({
                adminId: req.user.id,
                action: 'SITE_DEACTIVATED',
                entityType: 'site',
                entityId: id,
                details: `Deactivated site: ${site ? site.name : id} (reversible)`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            req.flash(
                'success',
                req.t
                    ? req.t('admin:org_site_deactivated', { name: site ? site.name : id })
                    : 'Site deactivated — restore it from "Deactivated units".'
            );
            res.redirect(backTo(req, 'site'));
        } catch (error) {
            console.error('Site delete error:', error);
            req.flash('error', req.t ? req.t('flash:site_delete_error') : 'Error deleting site');
            res.redirect('/organization/sites');
        }
    }

    // Departments
    async departmentsIndex(req, res) {
        try {
            const canManageOrg = RBACService.hasPermission(req.user, 'manage_organization');
            const departments = await RBACService.getFilteredDepartments(req.user);

            const sites = await SiteModel.findAll({ isActive: 1 }, 'name ASC');

            const counters = await orgCounters();
            decorateUnits(counters, { departments });
            const deactivated = canManageOrg
                ? await deactivatedUnits(req.user, counters)
                : EMPTY_DEACTIVATED;

            res.render('pages/organization/departments', {
                title: req.t ? req.t('chrome:pt_departments') : 'Departments',
                departments,
                sites,
                canManageOrg,
                deactivated,
            });
        } catch (error) {
            console.error('Departments index error:', error);
            req.flash(
                'error',
                req.t ? req.t('flash:dept_list_load_error') : 'Error loading departments'
            );
            res.redirect('/dashboard');
        }
    }

    async departmentsCreate(req, res) {
        try {
            const siteId = parseInt(req.body.siteId);
            const canManage = await RBACService.canAccessSite(req.user, siteId);
            if (!canManage) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:dept_create_denied')
                        : 'You do not have permission to create departments in this site'
                );
                return res.redirect('/organization/departments');
            }

            await DepartmentModel.create({
                siteId: parseInt(req.body.siteId),
                name: req.body.name.trim(),
                code: req.body.code?.trim() || null,
                description: req.body.description?.trim() || null,
                isActive: 1,
            });

            await LogService.log({
                adminId: req.user.id,
                action: 'DEPARTMENT_CREATED',
                entityType: 'department',
                details: `Created department: ${req.body.name}`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            req.flash(
                'success',
                req.t ? req.t('flash:dept_created') : 'Department created successfully'
            );
            res.redirect(backTo(req, 'department'));
        } catch (error) {
            console.error('Department create error:', error);
            req.flash(
                'error',
                req.t ? req.t('flash:dept_create_error') : 'Error creating department'
            );
            res.redirect(keepDraft(req, backTo(req, 'department')));
        }
    }

    async departmentsUpdate(req, res) {
        try {
            const { id } = req.params;
            const canManage = await RBACService.canAccessDepartment(req.user, parseInt(id));
            if (!canManage) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:dept_update_denied')
                        : 'You do not have permission to update this department'
                );
                return res.redirect('/organization/departments');
            }

            // Reactivation — see sitesUpdate. A department cannot usefully come back
            // under a still-deactivated site (the site join would keep hiding it), so
            // that case is refused with an explicit "reactivate the site first".
            if (String(req.body.reactivate) === '1') {
                const dept = await DepartmentModel.findById(id);
                if (!dept) {
                    req.flash(
                        'error',
                        req.t ? req.t('admin:org_unit_not_found') : 'Unit not found'
                    );
                    return res.redirect(backTo(req, 'department'));
                }
                const parent = await SiteModel.findById(dept.siteId);
                if (!parent || !isActiveRow(parent)) {
                    req.flash(
                        'error',
                        req.t
                            ? req.t('admin:org_reactivate_parent_inactive', {
                                  parent: parent ? parent.name : '?',
                              })
                            : 'Reactivate the parent site first.'
                    );
                    return res.redirect(backTo(req, 'department'));
                }
                await DepartmentModel.update(id, { isActive: 1 });
                await LogService.log({
                    adminId: req.user.id,
                    action: 'DEPARTMENT_REACTIVATED',
                    entityType: 'department',
                    entityId: id,
                    details: `Reactivated department: ${dept.name}`,
                    ipAddress: req.ip,
                    userAgent: req.get('user-agent'),
                });
                req.flash(
                    'success',
                    req.t
                        ? req.t('admin:org_department_reactivated', { name: dept.name })
                        : `Department "${dept.name}" is active again.`
                );
                return res.redirect(backTo(req, 'department'));
            }

            // 3.23.17 (A-6): the department may only be re-parented to a site
            // the caller governs (it used to accept any body.siteId).
            if (!(await parentMoveAllowed(req.user, 'department', id, req.body.siteId))) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:dept_update_denied')
                        : 'You do not have permission to update this department'
                );
                return res.redirect(backTo(req, 'department'));
            }

            await DepartmentModel.update(id, {
                siteId: parseInt(req.body.siteId),
                name: req.body.name.trim(),
                code: req.body.code?.trim() || null,
                description: req.body.description?.trim() || null,
            });

            await LogService.log({
                adminId: req.user.id,
                action: 'DEPARTMENT_UPDATED',
                entityType: 'department',
                entityId: id,
                details: `Updated department: ${req.body.name}`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            req.flash(
                'success',
                req.t ? req.t('flash:dept_updated') : 'Department updated successfully'
            );
            res.redirect(backTo(req, 'department'));
        } catch (error) {
            console.error('Department update error:', error);
            req.flash(
                'error',
                req.t ? req.t('flash:dept_update_error') : 'Error updating department'
            );
            res.redirect(keepDraft(req, backTo(req, 'department')));
        }
    }

    /** Deactivate a department — reversible, and refused while people are attached. */
    async departmentsDelete(req, res) {
        try {
            const { id } = req.params;
            const canManage = await RBACService.canAccessDepartment(req.user, parseInt(id));
            if (!canManage) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:dept_delete_denied')
                        : 'You do not have permission to delete this department'
                );
                return res.redirect('/organization/departments');
            }

            const attached = await attachedEmployeeCount('department', parseInt(id));
            if (attached > 0) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('admin:org_deactivate_blocked', { count: attached })
                        : `Cannot deactivate: ${attached} active employee(s) are still attached. Move them to another unit first.`
                );
                return res.redirect(backTo(req, 'department'));
            }

            const dept = await DepartmentModel.findById(id);
            await DepartmentModel.update(id, { isActive: 0 });

            await LogService.log({
                adminId: req.user.id,
                action: 'DEPARTMENT_DEACTIVATED',
                entityType: 'department',
                entityId: id,
                details: `Deactivated department: ${dept ? dept.name : id} (reversible)`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            req.flash(
                'success',
                req.t
                    ? req.t('admin:org_department_deactivated', { name: dept ? dept.name : id })
                    : 'Department deactivated — restore it from "Deactivated units".'
            );
            res.redirect(backTo(req, 'department'));
        } catch (error) {
            console.error('Department delete error:', error);
            req.flash(
                'error',
                req.t ? req.t('flash:dept_delete_error') : 'Error deleting department'
            );
            res.redirect('/organization/departments');
        }
    }

    // Services
    async servicesIndex(req, res) {
        try {
            const canManageOrg = RBACService.hasPermission(req.user, 'manage_organization');
            const services = await RBACService.getFilteredServices(req.user);

            const departments = await DepartmentModel.findWithSite();

            const counters = await orgCounters();
            decorateUnits(counters, { services });
            const deactivated = canManageOrg
                ? await deactivatedUnits(req.user, counters)
                : EMPTY_DEACTIVATED;

            res.render('pages/organization/services', {
                title: req.t ? req.t('chrome:pt_services') : 'Services',
                services,
                departments,
                canManageOrg,
                deactivated,
            });
        } catch (error) {
            console.error('Services index error:', error);
            req.flash(
                'error',
                req.t ? req.t('flash:svc_list_load_error') : 'Error loading services'
            );
            res.redirect('/dashboard');
        }
    }

    async servicesCreate(req, res) {
        try {
            const departmentId = parseInt(req.body.departmentId);
            const canManage = await RBACService.canAccessDepartment(req.user, departmentId);
            if (!canManage) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:svc_create_denied')
                        : 'You do not have permission to create services in this department'
                );
                return res.redirect('/organization/services');
            }

            await ServiceModel.create({
                departmentId: parseInt(req.body.departmentId),
                name: req.body.name.trim(),
                code: req.body.code?.trim() || null,
                description: req.body.description?.trim() || null,
                isActive: 1,
            });

            await LogService.log({
                adminId: req.user.id,
                action: 'SERVICE_CREATED',
                entityType: 'service',
                details: `Created service: ${req.body.name}`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            req.flash(
                'success',
                req.t ? req.t('flash:svc_created') : 'Service created successfully'
            );
            res.redirect(backTo(req, 'service'));
        } catch (error) {
            console.error('Service create error:', error);
            req.flash('error', req.t ? req.t('flash:svc_create_error') : 'Error creating service');
            res.redirect(keepDraft(req, backTo(req, 'service')));
        }
    }

    async servicesUpdate(req, res) {
        try {
            const { id } = req.params;
            const canManage = await RBACService.canAccessService(req.user, parseInt(id));
            if (!canManage) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:svc_update_denied')
                        : 'You do not have permission to update this service'
                );
                return res.redirect('/organization/services');
            }

            // Reactivation — see sitesUpdate. Refused while the parent department (or
            // its site) is still deactivated, which would keep the service invisible.
            if (String(req.body.reactivate) === '1') {
                const svc = await ServiceModel.findById(id);
                if (!svc) {
                    req.flash(
                        'error',
                        req.t ? req.t('admin:org_unit_not_found') : 'Unit not found'
                    );
                    return res.redirect(backTo(req, 'service'));
                }
                const parent = await DepartmentModel.findById(svc.departmentId);
                const grandParent = parent ? await SiteModel.findById(parent.siteId) : null;
                if (!parent || !isActiveRow(parent) || !grandParent || !isActiveRow(grandParent)) {
                    const blocking =
                        parent && !isActiveRow(parent)
                            ? parent.name
                            : grandParent
                              ? grandParent.name
                              : '?';
                    req.flash(
                        'error',
                        req.t
                            ? req.t('admin:org_reactivate_parent_inactive', { parent: blocking })
                            : 'Reactivate the parent unit first.'
                    );
                    return res.redirect(backTo(req, 'service'));
                }
                await ServiceModel.update(id, { isActive: 1 });
                await LogService.log({
                    adminId: req.user.id,
                    action: 'SERVICE_REACTIVATED',
                    entityType: 'service',
                    entityId: id,
                    details: `Reactivated service: ${svc.name}`,
                    ipAddress: req.ip,
                    userAgent: req.get('user-agent'),
                });
                req.flash(
                    'success',
                    req.t
                        ? req.t('admin:org_service_reactivated', { name: svc.name })
                        : `Service "${svc.name}" is active again.`
                );
                return res.redirect(backTo(req, 'service'));
            }

            // 3.23.17 (A-6): re-parenting moves the service (and its people) —
            // the DESTINATION must be in scope too, not only the service itself.
            if (!(await parentMoveAllowed(req.user, 'service', id, req.body.departmentId))) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:svc_update_denied')
                        : 'You do not have permission to update this service'
                );
                return res.redirect(backTo(req, 'service'));
            }

            await ServiceModel.update(id, {
                departmentId: parseInt(req.body.departmentId),
                name: req.body.name.trim(),
                code: req.body.code?.trim() || null,
                description: req.body.description?.trim() || null,
            });

            await LogService.log({
                adminId: req.user.id,
                action: 'SERVICE_UPDATED',
                entityType: 'service',
                entityId: id,
                details: `Updated service: ${req.body.name}`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            req.flash(
                'success',
                req.t ? req.t('flash:svc_updated') : 'Service updated successfully'
            );
            res.redirect(backTo(req, 'service'));
        } catch (error) {
            console.error('Service update error:', error);
            req.flash('error', req.t ? req.t('flash:svc_update_error') : 'Error updating service');
            res.redirect(keepDraft(req, backTo(req, 'service')));
        }
    }

    /** Deactivate a service — reversible, and refused while people are attached. */
    async servicesDelete(req, res) {
        try {
            const { id } = req.params;
            const canManage = await RBACService.canAccessService(req.user, parseInt(id));
            if (!canManage) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:svc_delete_denied')
                        : 'You do not have permission to delete this service'
                );
                return res.redirect('/organization/services');
            }

            const attached = await attachedEmployeeCount('service', parseInt(id));
            if (attached > 0) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('admin:org_deactivate_blocked', { count: attached })
                        : `Cannot deactivate: ${attached} active employee(s) are still attached. Move them to another unit first.`
                );
                return res.redirect(backTo(req, 'service'));
            }

            const svc = await ServiceModel.findById(id);
            await ServiceModel.update(id, { isActive: 0 });

            await LogService.log({
                adminId: req.user.id,
                action: 'SERVICE_DEACTIVATED',
                entityType: 'service',
                entityId: id,
                details: `Deactivated service: ${svc ? svc.name : id} (reversible)`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            req.flash(
                'success',
                req.t
                    ? req.t('admin:org_service_deactivated', { name: svc ? svc.name : id })
                    : 'Service deactivated — restore it from "Deactivated units".'
            );
            res.redirect(backTo(req, 'service'));
        } catch (error) {
            console.error('Service delete error:', error);
            req.flash('error', req.t ? req.t('flash:svc_delete_error') : 'Error deleting service');
            res.redirect('/organization/services');
        }
    }
}

module.exports = new OrganizationController();
