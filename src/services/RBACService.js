const AdminModel = require('../models/AdminModel');
const AdminScopeModel = require('../models/AdminScopeModel');
const AdminPermissionModel = require('../models/AdminPermissionModel');
const EmployeeModel = require('../models/EmployeeModel');
const SiteModel = require('../models/SiteModel');
const DepartmentModel = require('../models/DepartmentModel');
const ServiceModel = require('../models/ServiceModel');
const { ALL_SLUGS, isWrite } = require('../config/permissions');
const db = require('../config/database');

class RBACService {
    async getAdminWithScopes(adminId) {
        return await AdminModel.findWithScopes(adminId);
    }

    isSuperAdmin(user) {
        return user && user.userType === 'admin' && user.role === 'superadmin';
    }

    isLocalAdmin(user) {
        return user && user.userType === 'admin' && user.role === 'localadmin';
    }

    isViewer(user) {
        return user && user.userType === 'admin' && user.role === 'viewer';
    }

    // ---- Granular permissions -------------------------------------------------
    // A SuperAdmin implicitly holds every permission. A Viewer can only exercise
    // read-type permissions even if a write grant was stored. Local admins hold
    // exactly the slugs granted to them (loaded onto req.user at login).

    /** Resolve the effective permission slugs for a user (async-safe). */
    async getPermissions(user) {
        if (!user || user.userType !== 'admin') return [];
        if (this.isSuperAdmin(user)) return [...ALL_SLUGS];
        let slugs = Array.isArray(user.permissions) ? user.permissions : null;
        if (!slugs) slugs = await AdminPermissionModel.findSlugsByAdminId(user.id);
        return this._effective(user, slugs);
    }

    /** Synchronous check used by route guards / views; relies on user.permissions. */
    hasPermission(user, slug) {
        if (!user || user.userType !== 'admin') return false;
        if (this.isSuperAdmin(user)) return true;
        if (this.isViewer(user) && isWrite(slug)) return false;
        const slugs = Array.isArray(user.permissions) ? user.permissions : [];
        return slugs.includes(slug);
    }

    /** Alias for readability in views/controllers. */
    can(user, slug) {
        return this.hasPermission(user, slug);
    }

    /**
     * Admin ids who effectively HOLD a permission slug — for fan-out notification
     * audiences (approvers, HR dispute arbitrators, onboarding reviewers). HR/etc.
     * can be a SuperAdmin OR a scoped local admin depending on clearance, so this
     * unions: superadmins (implicit — never in admin_permissions) + admins with a
     * non-expired granular grant. Viewers are excluded for write-type slugs
     * (mirrors hasPermission). Best-effort caller should catch/`.filter(Boolean)`.
     */
    async adminsWithPermission(slug) {
        const excludeViewer = isWrite(slug);
        const rows = await db.all(
            `SELECT a.id
               FROM admins a
              WHERE COALESCE(a.is_active, true) = true
                ${excludeViewer ? "AND a.role <> 'viewer'" : ''}
                AND (a.role = 'superadmin'
                     OR EXISTS (SELECT 1 FROM admin_permissions ap
                                 WHERE ap.admin_id = a.id
                                   AND ap.permission = ?
                                   AND (ap.expires_at IS NULL OR ap.expires_at > now())))`,
            [slug]
        );
        return rows.map((r) => Number(r.id)).filter(Boolean);
    }

    /**
     * Coarse gate for the Data Management module's controller methods. The
     * per-route guards already enforce the exact export/import/admin grant; this
     * just lets the (redundant, defense-in-depth) in-controller check pass for
     * any data-capable admin instead of SuperAdmin-only.
     */
    canUseDataManagement(user) {
        return (
            this.isSuperAdmin(user) ||
            this.hasPermission(user, 'export_data') ||
            this.hasPermission(user, 'import_data') ||
            this.hasPermission(user, 'manage_admins')
        );
    }

    /** Drop write grants that a Viewer cannot exercise. */
    _effective(user, slugs) {
        if (this.isViewer(user)) return (slugs || []).filter((s) => !isWrite(s));
        return slugs || [];
    }

    /**
     * READ access to one employee's record: everything canAccessEmployeeData
     * grants, PLUS — for an admin account — the people it is DIRECTLY named
     * manager of (employees.manager_type = 'admin'), even outside its org
     * scopes. Read only: every write path keeps canAccessEmployeeData, so a
     * designation never lets an admin edit, move or re-link someone outside
     * its scopes. Not the designated person's sub-tree (see GovernanceService
     * .lineAuthorityEmployeeIds): the same population the SA-review console lists.
     */
    async canViewEmployee(user, employeeOrId) {
        const employee =
            employeeOrId && typeof employeeOrId === 'object'
                ? employeeOrId
                : await EmployeeModel.findById(employeeOrId);
        if (!employee) return false;
        if (await this.canAccessEmployeeData(user, employee)) return true;
        if (!user || user.userType !== 'admin') return false;
        const designated = await require('./GovernanceService').adminDesignatedEmployeeIds(user.id);
        return designated.includes(Number(employee.id));
    }

    async canAccessEmployee(admin, employeeId) {
        if (this.isSuperAdmin(admin)) {
            return true;
        }

        const employee = await EmployeeModel.findById(employeeId);
        if (!employee) {
            return false;
        }

        return await this.canAccessEmployeeData(admin, employee);
    }

    async canAccessEmployeeData(user, employee) {
        // Handle employee and manager users (can access their own data or their subordinates)
        if (user.userType === 'employee' || user.userType === 'manager') {
            // Employees/Managers can access their own data
            if (user.id === employee.id) {
                return true;
            }
            // Managers can access everyone in their governed sub-tree — resolved by
            // findGovernedIds (supervisor_id OR manager_id, recursive), the SAME
            // definition every talent module (PIP/IDP/coaching/9-box) uses. Using
            // the narrower findSubordinates (direct reports only) here meant a
            // manager could open a person's PIP/IDP but was 403'd on their plain
            // profile/timeline — an inconsistent, confusing gap.
            if (user.userType === 'manager') {
                const governed = await EmployeeModel.findGovernedIds(user.id);
                return governed.some((gid) => Number(gid) === Number(employee.id));
            }
            // Regular employees can only access their own data
            return false;
        }

        // Handle admin users
        if (this.isSuperAdmin(user)) {
            return true;
        }

        const adminWithScopes = await this.getAdminWithScopes(user.id);
        if (!adminWithScopes || !adminWithScopes.scopes || adminWithScopes.scopes.length === 0) {
            return false;
        }

        // Compare loosely on purpose: scope ids and employee ids arrive as strings
        // on some query paths and numbers on others, and a strict mismatch here
        // silently DENIES a legitimate admin.
        const same = (a, b) => a != null && b != null && String(a) === String(b);

        let hasCountryScope = false;
        let hasRegionScope = false;
        for (const scope of adminWithScopes.scopes) {
            if (scope.scopeType === 'site' && same(scope.siteId, employee.siteId)) {
                return true;
            }
            if (
                scope.scopeType === 'department' &&
                same(scope.departmentId, employee.departmentId)
            ) {
                return true;
            }
            if (scope.scopeType === 'service' && same(scope.serviceId, employee.serviceId)) {
                return true;
            }
            if (scope.scopeType === 'country') hasCountryScope = true;
            if (scope.scopeType === 'region') hasRegionScope = true;
        }

        // Country scope: the employee is in scope if their site is in that country.
        if (hasCountryScope && employee.siteId) {
            const site = await SiteModel.findById(employee.siteId);
            if (site && site.countryId && (await this.canAccessCountry(user, site.countryId))) {
                return true;
            }
        }

        // Region scope was absent here, so a region-scoped admin could LIST people
        // and then be refused on opening any one of them — the list and the record
        // disagreeing about the same authority. Region sits above country.
        if (hasRegionScope && employee.siteId) {
            const inRegion = await db.get(
                `SELECT 1 AS ok
                   FROM sites s
                   JOIN countries c   ON c.id = s.country_id
                   JOIN admin_scopes a ON a.region_id = c.region_id
                  WHERE s.id = ? AND a.admin_id = ? AND a.scope_type = 'region'
                    AND a.revoked_at IS NULL
                    AND (a.expires_at IS NULL OR a.expires_at > now())
                  LIMIT 1`,
                [employee.siteId, user.id]
            );
            if (inRegion) return true;
        }

        return false;
    }

    // A country-scoped admin governs every site (and thus dept/service/employee)
    // in that country. Country is the widest org-unit scope tier.
    async canAccessCountry(admin, countryId) {
        if (this.isSuperAdmin(admin)) return true;
        const adminWithScopes = await this.getAdminWithScopes(admin.id);
        if (!adminWithScopes || !adminWithScopes.scopes) return false;
        return adminWithScopes.scopes.some(
            (scope) =>
                scope.scopeType === 'country' && String(scope.countryId) === String(countryId)
        );
    }

    async canAccessSite(admin, siteId) {
        if (this.isSuperAdmin(admin)) {
            return true;
        }

        const adminWithScopes = await this.getAdminWithScopes(admin.id);
        if (!adminWithScopes || !adminWithScopes.scopes) {
            return false;
        }

        // Loose comparison on purpose: scope ids arrive as strings on some query
        // paths and callers pass parseInt'd numbers, and a strict mismatch here
        // silently DENIES an admin their own site.
        const direct = adminWithScopes.scopes.some(
            (scope) => scope.scopeType === 'site' && String(scope.siteId) === String(siteId)
        );
        if (direct) return true;

        // Inherit downward: country covers its sites, region covers its countries'
        // sites. Region was absent, so a region-scoped admin was refused a site
        // they unambiguously govern — while the employee LIST showed them its
        // people. The two answers disagreed about the same authority.
        const site = await SiteModel.findById(siteId);
        if (!site) return false;

        if (adminWithScopes.scopes.some((s) => s.scopeType === 'country')) {
            if (site.countryId && (await this.canAccessCountry(admin, site.countryId))) return true;
        }
        if (adminWithScopes.scopes.some((s) => s.scopeType === 'region') && site.countryId) {
            const hit = await db.get(
                `SELECT 1 AS ok
                   FROM countries c
                   JOIN admin_scopes a ON a.region_id = c.region_id
                  WHERE c.id = ? AND a.admin_id = ? AND a.scope_type = 'region'
                    AND a.revoked_at IS NULL
                    AND (a.expires_at IS NULL OR a.expires_at > now())
                  LIMIT 1`,
                [site.countryId, admin.id]
            );
            if (hit) return true;
        }
        return false;
    }

    async canAccessDepartment(admin, departmentId) {
        if (this.isSuperAdmin(admin)) {
            return true;
        }

        const adminWithScopes = await this.getAdminWithScopes(admin.id);
        if (!adminWithScopes || !adminWithScopes.scopes) {
            return false;
        }

        // Check direct department access
        const hasDirectAccess = adminWithScopes.scopes.some(
            (scope) =>
                scope.scopeType === 'department' &&
                String(scope.departmentId) === String(departmentId)
        );

        if (hasDirectAccess) {
            return true;
        }

        // Check if department belongs to a site the admin has access to
        const department = await DepartmentModel.findById(departmentId);
        if (department) {
            return await this.canAccessSite(admin, department.siteId);
        }

        return false;
    }

    async canAccessService(admin, serviceId) {
        if (this.isSuperAdmin(admin)) {
            return true;
        }

        const adminWithScopes = await this.getAdminWithScopes(admin.id);
        if (!adminWithScopes || !adminWithScopes.scopes) {
            return false;
        }

        // Check direct service access
        const hasDirectAccess = adminWithScopes.scopes.some(
            (scope) =>
                scope.scopeType === 'service' && String(scope.serviceId) === String(serviceId)
        );

        if (hasDirectAccess) {
            return true;
        }

        // Check if service belongs to a department the admin has access to
        const service = await ServiceModel.findById(serviceId);
        if (service) {
            return await this.canAccessDepartment(admin, service.departmentId);
        }

        return false;
    }

    // getEmployeeFilter deprecated - moved logic to EmployeeModel.findByScopesAndFilters

    async getFilteredEmployees(admin, additionalConditions = {}) {
        // Super admin → everyone.
        if (this.isSuperAdmin(admin)) {
            return await EmployeeModel.findByScopesAndFilters(null, additionalConditions);
        }

        // Manager / supervisor (non-admin) → only the people they govern.
        if (admin && (admin.userType === 'manager' || admin.userType === 'employee')) {
            return await EmployeeModel.findGoverned(admin.id);
        }

        // Local admin / viewer → employees within their assigned scope.
        const adminWithScopes = await this.getAdminWithScopes(admin.id);
        if (!adminWithScopes || !adminWithScopes.scopes || adminWithScopes.scopes.length === 0) {
            return []; // No scopes found for local admin = no access
        }
        return await EmployeeModel.findByScopesAndFilters(
            adminWithScopes.scopes,
            additionalConditions
        );
    }

    /**
     * SQL scope fragment for list/queue queries that JOIN the employees table.
     * Returns { clause, params } to append to a WHERE that already has a base
     * predicate. Enforces clearance uniformly:
     *   - super admin           → no restriction
     *   - local admin / viewer  → employees within their admin scope (or none)
     *   - manager / supervisor  → only their own reports
     * @param {object} user
     * @param {object} [opts]
     * @param {string} [opts.empAlias='e'] alias of the joined employees table
     */
    async scopeFilter(user, { empAlias = 'e', includeInactive = false } = {}) {
        if (this.isSuperAdmin(user)) return { clause: '', params: [] };
        // `= ANY(?)` with a single array parameter (node-pg maps JS arrays to PG
        // arrays) instead of an N-placeholder IN-list: the SQL template stays
        // IDENTICAL regardless of scope size, so the driver's translation memo
        // cache actually hits on the hottest dashboard/queue queries.
        if (user && user.userType === 'admin') {
            // Active staff by default (the model's default); `includeInactive`
            // is for clearance-only uses that must keep leavers addressable
            // (SCIM re-enable, the audit trail).
            const employees = await this.getFilteredEmployees(
                user,
                includeInactive ? { includeInactive: true } : {}
            );
            const ids = new Set(employees.map((e) => Number(e.id)));
            // UNION with the reporting line of the PERSON behind the account.
            // An administration account carries a clearance; it does not cancel
            // the hierarchy of the human holding it. A supervisor signed in on
            // their own admin account used to get their clearance INSTEAD OF
            // their team — an empty review console, HTTP 200, no message. The
            // list must be scoped by the same authority the per-object guard
            // (SelfAssessmentWorkflowService.resolveAuthority) resolves, or the
            // console lists one population and authorises another.
            for (const id of await require('./GovernanceService').lineAuthorityEmployeeIds(user)) {
                ids.add(Number(id));
            }
            if (!ids.size) return { clause: ' AND 1=0', params: [] };
            return { clause: ` AND ${empAlias}.id = ANY(?)`, params: [[...ids]] };
        }
        // manager / supervisor / employee: their full reporting sub-tree
        const ids = await EmployeeModel.findGovernedIds(user.id);
        if (!ids.length) return { clause: ' AND 1=0', params: [] };
        return { clause: ` AND ${empAlias}.id = ANY(?)`, params: [ids] };
    }

    // ── Org units the caller may see ─────────────────────────────────────────
    // All three delegate to utils/adminScope, the ONE expansion of admin_scopes.
    // They used to filter on `scopeType === 'site'` (and equivalents), which meant
    // a COUNTRY- or REGION-scoped admin got an EMPTY list — measured: an admin
    // over Côte d'Ivoire could list all 57 of their employees but received 0 sites
    // and 0 departments, so every dropdown and filter was blank and the employee
    // edit form could not render the site their own people already held.
    async getFilteredSites(admin) {
        if (this.isSuperAdmin(admin)) {
            return await SiteModel.findAll();
        }
        const { resolveAdminScope } = require('../utils/adminScope');
        const scope = await resolveAdminScope(admin);
        if (scope.unrestricted) return await SiteModel.findAll();
        if (!scope.siteIds.length) return [];
        return await SiteModel.findByIds(scope.siteIds);
    }

    async getFilteredDepartments(admin) {
        if (this.isSuperAdmin(admin)) {
            return await DepartmentModel.findWithSite();
        }
        const { resolveAdminScope } = require('../utils/adminScope');
        const scope = await resolveAdminScope(admin);
        if (scope.unrestricted) return await DepartmentModel.findWithSite();
        if (!scope.departmentIds.length) return [];
        return await DepartmentModel.findWithSite(null, scope.departmentIds);
    }

    async getFilteredServices(admin) {
        if (this.isSuperAdmin(admin)) {
            return await ServiceModel.findWithDepartment();
        }
        const { resolveAdminScope } = require('../utils/adminScope');
        const scope = await resolveAdminScope(admin);
        if (scope.unrestricted) return await ServiceModel.findWithDepartment();
        if (!scope.serviceIds.length) return [];
        return await ServiceModel.findWithDepartment(null, scope.serviceIds);
    }
}

module.exports = new RBACService();
