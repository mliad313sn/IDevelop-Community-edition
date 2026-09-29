const EmployeeModel = require('../models/EmployeeModel');
const SiteModel = require('../models/SiteModel');
const DepartmentModel = require('../models/DepartmentModel');
const ServiceModel = require('../models/ServiceModel');
const RoleModel = require('../models/RoleModel');
const AdminModel = require('../models/AdminModel');
const RBACService = require('../services/RBACService');
const LogService = require('../services/LogService');
const EmployeeAuthService = require('../services/EmployeeAuthService');
const passwordValidator = require('../utils/passwordValidator');
const { employeeValidation, keepDraft } = require('../utils/validators');
const { parsePage, buildPager, sortClause, sortLinks } = require('../utils/listTools');
const { bc } = require('../utils/breadcrumbLabel');

/**
 * Parse the polymorphic Manager select value ("employee:<id>" | "admin:<id>" | "").
 * The manager may be another employee OR an admin account.
 * Returns { managerId, managerType, error }.
 */
async function resolveManagerSelection(rawValue, selfId) {
    if (!rawValue) return { managerId: null, managerType: null };
    const [type, idStr] = String(rawValue).split(':');
    const id = parseInt(idStr, 10);
    if ((type !== 'employee' && type !== 'admin') || !Number.isInteger(id)) {
        return { error: 'Invalid manager selection' };
    }
    if (type === 'employee') {
        if (selfId && id === parseInt(selfId, 10))
            return { error: 'Employee cannot be their own manager' };
        const m = await EmployeeModel.findById(id);
        // An INACTIVE (leaver) or VOIDED record cannot review anyone: the form
        // accepted one here while the dedicated /supervisor endpoint refused it,
        // leaving the person governed by a login that no longer exists.
        if (!m || !m.isActive || m.cancelledAt) return { error: 'Invalid manager selected' };
        // A→B→A loops were writable (only self-reference is schema-guarded).
        if (selfId && (await EmployeeModel.wouldCreateReportingCycle(selfId, id))) {
            return { error: 'Invalid manager selected: this would create a reporting loop' };
        }
    } else {
        const a = await AdminModel.findById(id);
        if (!a || a.isActive === false) return { error: 'Invalid admin manager selected' };
    }
    return { managerId: id, managerType: type };
}

/**
 * A manager-user may assign as supervisor only THEMSELVES or someone within
 * their own governed span — never an arbitrary employee from another line.
 */
async function managerCanAssignSupervisor(managerUserId, supervisorId) {
    if (Number(supervisorId) === Number(managerUserId)) return true;
    const governed = await EmployeeModel.findGovernedIds(managerUserId);
    return governed.some((gid) => Number(gid) === Number(supervisorId));
}

/**
 * May this admin place an employee at this site/department/service?
 *
 * Guards BOTH create and update. Two distinct defects made this necessary:
 *
 *  · create checked the three ids with OR — `!site && !dept && !service` — so a
 *    service-scoped admin could submit any siteId and departmentId as long as the
 *    service was theirs, planting a record in another delegate's population and
 *    producing an internally inconsistent placement.
 *
 *  · update did not check the destination AT ALL. It authorised against the
 *    employee's CURRENT placement and then wrote whatever site/department/service
 *    the form submitted. A site-scoped admin could move an in-scope employee into
 *    any other site — mutating a population they do not govern and, because scope
 *    is derived from placement, permanently pushing that person out of their own
 *    reach. create validated; update did not. An asymmetric pair like that is an
 *    omission, not a design.
 *
 * Checked against the AUTHORITY sets (departmentIds / serviceIds), never against
 * the navigable `siteIds` — that one deliberately includes the parent site of a
 * scoped department so dropdowns can render, and using it here would let a
 * department-scoped admin place people into sibling departments of the same site.
 *
 * Also verifies the trio is internally consistent, so a valid-looking combination
 * of ids that do not actually nest cannot be stored.
 *
 * @returns {Promise<string|null>} an error message, or null when allowed.
 */
async function destinationPlacementError(user, { siteId, departmentId, serviceId }, t) {
    const msg = (key, fallback) => (t ? t(key) : fallback);

    const sId = parseInt(siteId, 10);
    const dId = parseInt(departmentId, 10);
    const vId = parseInt(serviceId, 10);
    if (!sId || !dId || !vId) {
        return msg('flash:emp_place_incomplete', 'Site, department and service are all required.');
    }

    // The org units must actually nest: service → department → site.
    const dept = await DepartmentModel.findById(dId);
    const svc = await ServiceModel.findById(vId);
    if (!dept || String(dept.siteId) !== String(sId)) {
        return msg(
            'flash:emp_place_inconsistent',
            'That department does not belong to the selected site.'
        );
    }
    if (!svc || String(svc.departmentId) !== String(dId)) {
        return msg(
            'flash:emp_place_inconsistent',
            'That service does not belong to the selected department.'
        );
    }

    if (RBACService.isSuperAdmin(user)) return null;

    const { resolveAdminScope } = require('../utils/adminScope');
    const scope = await resolveAdminScope(user);
    if (scope.unrestricted) return null;

    const has = (list, id) => Array.isArray(list) && list.some((x) => String(x) === String(id));
    // Service containment implies the department and site, given the nesting
    // check above — but assert the department too so a future change to the
    // resolver cannot quietly widen this.
    if (!has(scope.departmentIds, dId) || !has(scope.serviceIds, vId)) {
        return msg(
            'flash:emp_create_scope_denied',
            'Cette affectation est hors de votre périmètre. / That placement is outside your scope.'
        );
    }
    return null;
}

class EmployeeController {
    async index(req, res) {
        try {
            // User-selectable page size (validated against an allowlist so a crafted
            // ?perPage=999999 can't ask the DB for the whole table). Default 50 so a
            // multi-site org shows more than one site on page 1 — the list is ordered
            // by site, and a small page let a large site (the HQ) fill the first pages
            // and look like a site filter.
            const PER_PAGE_OPTIONS = [20, 50, 100, 200];
            const { page, perPage, offset } = parsePage(req.query, {
                perPageOptions: PER_PAGE_OPTIONS,
                defaultPerPage: 50,
            });
            const limit = perPage;
            // Server-side sort. Default = site-grouped roster (separator rows);
            // any explicit column sort renders FLAT so the separators can't break it.
            const sort = sortClause(req.query, EmployeeModel.SORT_COLUMNS, 'site');
            const grouped = !req.query.sort || !EmployeeModel.SORT_COLUMNS[req.query.sort];

            const search = req.query.search ? req.query.search.trim() : null;
            const roleId = req.query.roleId ? parseInt(req.query.roleId) : null;
            const siteId = req.query.siteId ? parseInt(req.query.siteId) : null;
            // the directory filters mirror the org structure.
            // departmentId was accepted by the model and silently ignored here.
            const departmentId = req.query.departmentId
                ? parseInt(req.query.departmentId, 10) || null
                : null;
            const serviceId = req.query.serviceId
                ? parseInt(req.query.serviceId, 10) || null
                : null;
            const supervisorId = req.query.supervisorId
                ? parseInt(req.query.supervisorId, 10) || null
                : null;
            const wantsCsv = req.path.endsWith('/export.csv') || req.query.export === 'csv';

            // LEAVERS ARE HIDDEN BY DEFAULT.
            //
            // A person processed as a leaver is deactivated (is_active = false), and
            // they used to keep appearing here indistinguishably from current staff:
            // a manager's own sub-tree already excluded them (findGovernedIds filters
            // is_active), so superadmins and local admins were the only ones still
            // seeing them — an accident, not a design.
            //
            // `?status=` deliberately keeps them REACHABLE: hiding a leaver with no
            // way to list one would make reactivating an account impossible from the
            // UI. Whenever they are shown the row is marked (see the view).
            const STATUSES = ['active', 'inactive', 'all'];
            const status = STATUSES.includes(req.query.status) ? req.query.status : 'active';

            const filters = {};
            if (status === 'active') filters.isActive = true;
            else if (status === 'inactive') filters.isActive = false;
            if (search) filters.search = search;
            if (roleId) filters.roleId = roleId;
            if (siteId) filters.siteId = siteId;
            if (departmentId) filters.departmentId = departmentId;
            if (serviceId) filters.serviceId = serviceId;
            if (supervisorId) filters.supervisorId = supervisorId;
            // ?missingReviewer=1 → the governance-gap worklist (no supervisor
            // AND no manager): these people cannot complete the review workflow.
            if (req.query.missingReviewer === '1') filters.missingReviewer = true;

            // Resolve the caller's scope, then paginate in SQL (was: load every
            // governed employee and slice in JS — heavy at 4000-user scale).
            let scopes = null,
                employeeIds = null,
                alsoEmployeeIds = null;
            if (RBACService.isSuperAdmin(req.user)) {
                scopes = null; // no restriction
            } else if (req.user.userType === 'manager' || req.user.userType === 'employee') {
                employeeIds = await EmployeeModel.findGovernedIds(req.user.id);
            } else {
                const aws = await RBACService.getAdminWithScopes(req.user.id);
                scopes = (aws && aws.scopes) || [];
                // The people this admin account is named manager of, even outside
                // its scopes — the SA-review console already lists them.
                alsoEmployeeIds =
                    await require('../services/GovernanceService').adminDesignatedEmployeeIds(
                        req.user.id
                    );
            }
            // CSV of the filtered set: same scope, same filters, no page.
            if (wantsCsv) {
                const { csvResponse } = require('../utils/listTools');
                const { rows: all } = await EmployeeModel.findPageWithOrg({
                    scopes,
                    employeeIds,
                    alsoEmployeeIds,
                    filters,
                    limit: 20000,
                    offset: 0,
                    orderBy: grouped ? null : `${sort.key}:${sort.dir}`,
                });
                const acc = await EmployeeModel.accountStates(
                    all.map((e) => e.id),
                    require('./InvitationController').lockoutPolicy()
                );
                const camp = await EmployeeModel.campaignStates(all.map((e) => e.id));
                const t = (k) => (req.t ? req.t(k) : k);
                const headers = [
                    'employee_number',
                    'name',
                    'role',
                    'site',
                    'department',
                    'service',
                    'supervisor',
                    'email',
                    'username',
                    'state',
                    'last_login_at',
                    'campaign',
                    'record_status',
                ].map((k) => t(`admin:emp_csv_${k}`));
                const rows = all.map((e) => {
                    const a = acc.get(Number(e.id)) || {};
                    const c = camp.get(Number(e.id));
                    // this column wrote « MORENO, Daniel » while the
                    // supervisor column of the SAME row (EmployeeModel, first || ' ' || last),
                    // the screen this export promises to mirror (employees/index.ejs) and the
                    // campaign export (CycleService) all write « Daniel MORENO ».
                    // One convention: given name, then family name.
                    return [
                        e.employeeNumber,
                        `${e.firstName} ${e.lastName}`,
                        e.roleName,
                        e.siteName,
                        e.departmentName,
                        e.serviceName,
                        e.supervisorName || '',
                        e.email || '',
                        e.username || '',
                        a.state ? t(`admin:acc_state_${a.state}`) : '',
                        a.lastLoginAt
                            ? new Date(a.lastLoginAt).toISOString().slice(0, 16).replace('T', ' ')
                            : '',
                        c
                            ? `${c.cycleCode || c.cycleId}: ${t(`admin:emp_campaign_${c.state}`)}`
                            : '',
                        e.erasedAt
                            ? t('admin:emp_erased_badge')
                            : e.cancelledAt
                              ? t('admin:emp_voided_badge')
                              : e.isActive === false
                                ? t('admin:emp_inactive_badge')
                                : t('admin:emp_record_active'),
                    ];
                });
                await LogService.log({
                    adminId: req.user.userType === 'admin' ? req.user.id : null,
                    actorRef: `${req.user.userType || 'admin'}:${req.user.id}`,
                    action: 'EMPLOYEES_EXPORTED',
                    entityType: 'employee',
                    details: `Employee directory exported: ${rows.length} row(s) (site ${siteId || 'all'}, department ${departmentId || 'all'}, status ${status})`,
                    ipAddress: req.ip,
                    userAgent: req.get('user-agent'),
                });
                return csvResponse(
                    res,
                    `employees-${new Date().toISOString().slice(0, 10)}.csv`,
                    headers,
                    rows
                );
            }

            const { rows: paginatedEmployees, total } = await EmployeeModel.findPageWithOrg({
                scopes,
                employeeIds,
                alsoEmployeeIds,
                filters,
                limit,
                offset,
                orderBy: grouped ? null : `${sort.key}:${sort.dir}`,
            });
            // Account + campaign columns: one query each for the
            // page's ids; the chip rules are the Accounts console's (EmployeeModel).
            const pageIds = paginatedEmployees.map((e) => Number(e.id));
            const accountStates = await EmployeeModel.accountStates(
                pageIds,
                require('./InvitationController').lockoutPolicy()
            );
            const campaignStates = await EmployeeModel.campaignStates(pageIds);

            // Sites for the filter dropdown, restricted to the caller's scope so a
            // scoped admin can't enumerate sites they can't see. (The query above
            // already AND-enforces scope; this just keeps the dropdown honest.)
            let sites;
            if (RBACService.isSuperAdmin(req.user)) {
                sites = await SiteModel.findAll({ isActive: 1 }, 'name ASC');
            } else if (req.user.userType === 'manager' || req.user.userType === 'employee') {
                // A manager's span rarely covers every site: offering all nine
                // and answering "0 collaborateurs" was a dead end.
                const spanSites = await require('../config/database').all(
                    `SELECT DISTINCT s.id, s.name FROM employees e JOIN sites s ON s.id = e.site_id
                      WHERE e.id = ANY(?) ORDER BY s.name`,
                    [employeeIds || []]
                );
                sites = spanSites;
            } else {
                // Through the shared resolver: reading the raw scope rows and
                // filtering on 'site' left a COUNTRY- or REGION-scoped admin with an
                // empty site filter on their own employee list — the same defect
                // that emptied the edit form.
                sites = await RBACService.getFilteredSites(req.user);
            }

            // Inline "set supervisor" control (manager-users only): the candidate
            // pool is themselves + everyone they govern — the same rule the
            // /employees/:id/supervisor endpoint enforces.
            let supervisorCandidates = null;
            if (req.user.userType === 'manager') {
                const governed = await EmployeeModel.findGoverned(req.user.id);
                const seen = new Set();
                supervisorCandidates = [
                    {
                        id: Number(req.user.id),
                        name:
                            `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || 'Me',
                    },
                    ...governed
                        .filter((e) => e.isActive)
                        .map((e) => ({ id: Number(e.id), name: `${e.firstName} ${e.lastName}` })),
                ]
                    .filter((c) => (seen.has(c.id) ? false : seen.add(c.id)))
                    .sort((a, b) => a.name.localeCompare(b.name));
            }

            // Org filter options (cascade from the chosen site / department), scoped.
            const isSuperUser = RBACService.isSuperAdmin(req.user);
            const isManagerUser =
                req.user.userType === 'manager' || req.user.userType === 'employee';
            let departments = isSuperUser
                ? await DepartmentModel.findWithSite()
                : isManagerUser
                  ? []
                  : await RBACService.getFilteredDepartments(req.user);
            let services = isSuperUser
                ? await ServiceModel.findWithDepartment()
                : isManagerUser
                  ? []
                  : await RBACService.getFilteredServices(req.user);
            if (isManagerUser) {
                // Managers: the units present in their span only.
                const dbx = require('../config/database');
                departments = await dbx.all(
                    `SELECT DISTINCT d.id, d.name, d.site_id FROM employees e JOIN departments d ON d.id = e.department_id WHERE e.id = ANY(?) ORDER BY d.name`,
                    [employeeIds || []]
                );
                services = await dbx.all(
                    `SELECT DISTINCT sv.id, sv.name, sv.department_id FROM employees e JOIN services sv ON sv.id = e.service_id WHERE e.id = ANY(?) ORDER BY sv.name`,
                    [employeeIds || []]
                );
            }
            if (siteId)
                departments = departments.filter((d) => String(d.siteId) === String(siteId));
            if (departmentId)
                services = services.filter((s) => String(s.departmentId) === String(departmentId));
            else if (siteId) {
                const okDepts = new Set(departments.map((d) => String(d.id)));
                services = services.filter((s) => okDepts.has(String(s.departmentId)));
            }
            const roles = await RoleModel.findAll({ isActive: 1 }, 'name ASC');
            const supervisors = await EmployeeModel.supervisorOptions({ scopes, employeeIds });
            const filtersActive = !!(
                search ||
                roleId ||
                siteId ||
                departmentId ||
                serviceId ||
                supervisorId ||
                status !== 'active' ||
                req.query.missingReviewer === '1'
            );

            res.render('pages/employees/index', {
                title: req.t ? req.t('chrome:pt_employees') : 'Employees',
                employees: paginatedEmployees,
                accountStates,
                campaignStates,
                currentPage: page,
                totalPages: Math.ceil(total / limit),
                total,
                search,
                roleId,
                sites,
                siteId,
                departments,
                departmentId,
                services,
                serviceId,
                roles,
                supervisors,
                supervisorId,
                filtersActive,
                isManagerUser,
                canSeeAccounts:
                    req.user.userType === 'admin' &&
                    (isSuperUser || RBACService.hasPermission(req.user, 'reset_employee_password')),
                perPage,
                perPageOptions: PER_PAGE_OPTIONS,
                supervisorCandidates,
                status,
                statusOptions: STATUSES,
                // pager links carry EVERY current query param (status, site, search, perPage…).
                pager: buildPager(req.query, { page, total, perPage, basePath: '/employees' }),
                sort,
                sortCols: sortLinks(req.query, EmployeeModel.SORT_COLUMNS, grouped ? null : sort, {
                    basePath: '/employees',
                }),
                grouped,
            });
        } catch (error) {
            console.error('Employee index error:', error);
            req.flash(
                'error',
                req.t ? req.t('flash:emp_list_load_error') : 'Error loading employees'
            );
            res.redirect('/dashboard');
        }
    }

    async show(req, res) {
        try {
            const { id } = req.params;
            const employee = await EmployeeModel.findByIdWithOrganization(id);

            if (!employee) {
                req.flash('error', req.t ? req.t('flash:emp_not_found') : 'Employee not found');
                return res.redirect('/employees');
            }

            // Check RBAC access
            // READ: also the people this admin account is directly named manager of.
            const hasAccess = await RBACService.canViewEmployee(req.user, employee);
            if (!hasAccess) {
                req.flash('error', req.t ? req.t('flash:access_denied') : 'Access denied');
                return res.redirect('/employees');
            }

            // (The destination-placement check that sat here — on a GET, where
            // it never guarded a write — moved to update in 3.23.17, A-4.)

            // Access & identity management (SSO link + promote-to-admin) — visible
            // only to accounts that can manage admins/onboarding.
            const isSuper = RBACService.isSuperAdmin(req.user);
            const canManageAccess =
                isSuper ||
                (Array.isArray(req.user.permissions) &&
                    (req.user.permissions.includes('manage_admins') ||
                        req.user.permissions.includes('manage_onboarding')));
            let linkedAdmin = null;
            let identities = [];
            if (canManageAccess) {
                const AccountLinkService = require('../services/AccountLinkService');
                linkedAdmin = await AccountLinkService.linkedAdminForEmployee(employee.id);
                identities = await AccountLinkService.listIdentities('employee', employee.id);
            }
            // Account status block: read-only state for
            // everyone who may open the record; a manager gets one-click
            // "request unlock / resend" instead of a 403 on the admin buttons.
            const account =
                (
                    await EmployeeModel.accountStates(
                        [employee.id],
                        require('./InvitationController').lockoutPolicy()
                    )
                ).get(Number(employee.id)) || null;
            const isManagerUser =
                req.user.userType === 'manager' || req.user.userType === 'employee';
            let openRequests = [];
            try {
                openRequests = await require('../config/database').all(
                    'SELECT id, kind, created_at FROM account_requests WHERE employee_id = ? AND decided_at IS NULL ORDER BY created_at DESC',
                    [employee.id]
                );
            } catch (_) {
                openRequests = [];
            }
            const canActOnAccount =
                req.user.userType === 'admin' &&
                (isSuper || RBACService.hasPermission(req.user, 'reset_employee_password'));

            // ---- SECTION operations — "Journal" section -------------------------
            // One question — "everything about this person" — answered from the
            // append-only log: rows where they ACTED (any actor shape, normalised
            // by migration 112) or where they are the ENTITY. Admin-only: the
            // trail names other people's actions on this record.
            let journal = null;
            if (req.user.userType === 'admin') {
                const SystemLogModel = require('../models/SystemLogModel');
                const scope = await require('./SystemLogController')
                    .scopeFor(req.user)
                    .catch(() => null);
                const f = { employeeId: Number(id), excludeHttp: true };
                const [rows, total] = await Promise.all([
                    SystemLogModel.findFiltered(f, 25, 0, scope).catch(() => []),
                    SystemLogModel.countFiltered(f, scope).catch(() => null),
                ]);
                journal = { rows, total };
            }
            // ---- end SECTION operations --------------------------------------------------

            res.render('pages/employees/show', {
                title: req.t
                    ? req.t('chrome:pt_employee_detail', {
                          name: `${employee.firstName} ${employee.lastName}`,
                      })
                    : `Employee: ${employee.firstName} ${employee.lastName}`,
                employee,
                account,
                openRequests,
                isManagerUser,
                canActOnAccount,
                canManageAccess,
                isSuperAdmin: isSuper,
                linkedAdmin,
                identities,
                journal,
                passwordDisabled: !!(employee.passwordDisabled || employee.password_disabled),
                // English literal crumb on a French page. The person's name
                // keeps the product's « prénom nom » order.
                breadcrumbs: [
                    { label: bc(req, 'chrome:pt_employees', 'Employees'), url: '/employees' },
                    { label: `${employee.firstName} ${employee.lastName}` },
                ],
            });
        } catch (error) {
            console.error('Employee show error:', error);
            req.flash('error', req.t ? req.t('flash:emp_load_error') : 'Error loading employee');
            res.redirect('/employees');
        }
    }

    async createForm(req, res) {
        try {
            // Get accessible sites, departments, services, and roles
            let sites, departments, services, roles;

            if (RBACService.isSuperAdmin(req.user)) {
                sites = await SiteModel.findAll({ isActive: 1 }, 'name ASC');
                departments = await DepartmentModel.findWithSite();
                services = await ServiceModel.findWithDepartment();
            } else {
                // For LocalAdmin, filter by scope
                // Scope comes from the ONE resolver (utils/adminScope), which expands
                // region and country as well as site/department/service. Reading the raw
                // scope rows here and filtering on `scopeType === 'site'` meant a
                // COUNTRY-scoped admin got sites = [], and with no site value the
                // DOMContentLoaded cascade returned early so departments and services
                // never loaded either.
                const { resolveAdminScope } = require('../utils/adminScope');
                const scope = await resolveAdminScope(req.user);
                const siteIds = scope.siteIds || [];
                const departmentIds = scope.departmentIds || [];
                const serviceIds = scope.serviceIds || [];

                sites = siteIds.length
                    ? await SiteModel.findAll({ id: siteIds, isActive: 1 }, 'name ASC')
                    : [];
                departments = (await DepartmentModel.findWithSite()).filter((d) =>
                    departmentIds.some((id) => String(id) === String(d.id))
                );
                services = (await ServiceModel.findWithDepartment()).filter((s) =>
                    serviceIds.some((id) => String(id) === String(s.id))
                );
            }

            roles = await RoleModel.findAll({ isActive: 1 }, 'name ASC');

            // Potential supervisors/managers (employees) + admin accounts.
            const supervisors = (await RBACService.getFilteredEmployees(req.user)).filter(
                (e) => e.isActive
            );
            const adminManagers = await AdminModel.findAll({ isActive: 1 }, 'username ASC');

            res.render('pages/employees/create', {
                title: req.t ? req.t('chrome:pt_create_employee') : 'Create Employee',
                sites,
                departments,
                services,
                roles,
                supervisors,
                managers: supervisors,
                adminManagers,
            });
        } catch (error) {
            console.error('Employee create form error:', error);
            req.flash('error', req.t ? req.t('flash:form_load_error') : 'Error loading form');
            res.redirect('/employees');
        }
    }

    async create(req, res) {
        try {
            // Validation is handled by express-validator middleware in routes
            // Additional business logic validations below

            // Appliance seat entitlement (soft by default; only blocks when the
            // superadmin turned on the hard cap AND the license is at/over its seats).
            const seatGate = await require('../services/EntitlementService').canAddEmployee();
            if (!seatGate.ok) {
                // La clé d'abord (elle existe dans les DEUX catalogues), la phrase
                // anglaise du service seulement s'il n'y a pas de traducteur.
                req.flash(
                    'error',
                    req.t && seatGate.reasonKey
                        ? req.t(seatGate.reasonKey, seatGate.reasonVars || {})
                        : seatGate.reason || 'Seat limit reached'
                );
                return res.redirect(keepDraft(req, '/employees/create'));
            }

            // Auto-generate employee number if not provided
            let employeeNumber = req.body.employeeNumber?.trim();
            if (!employeeNumber) {
                // Generate unique employee number: EMP-{timestamp}
                employeeNumber = `EMP-${Date.now()}`;
            } else {
                // Check if employee number already exists only if provided
                const existing = await EmployeeModel.findByEmployeeNumber(employeeNumber);
                if (existing) {
                    req.flash(
                        'error',
                        req.t ? req.t('flash:emp_number_exists') : 'Employee number already exists'
                    );
                    return res.redirect(keepDraft(req, '/employees/create'));
                }
            }

            // A shared e-mail address is ALLOWED — a person may hold several
            // accounts (migration 107). The screen advises instead of refusing,
            // so a genuine duplicate person is still noticed by whoever is typing.
            const emailAdvisory = await require('../services/EmailAccountsService').advisory(
                req,
                req.body.email
            );

            // --- Enforce login credentials (every employee gets a username + password) ---
            const username = req.body.username?.trim();
            const password = req.body.password || '';
            if (!username || username.length < 3) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:emp_username_required')
                        : 'Username is required (minimum 3 characters)'
                );
                return res.redirect(keepDraft(req, '/employees/create'));
            }
            const pwCheck = passwordValidator.validate(password);
            if (!pwCheck.valid) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:pw_policy', { errors: pwCheck.errors.join('; ') })
                        : 'Password: ' + pwCheck.errors.join('; ')
                );
                return res.redirect(keepDraft(req, '/employees/create'));
            }
            // Username must be unique across employees AND admins (login auto-detects type)
            const dupEmp = await EmployeeModel.findByUsername(username);
            const dupAdmin = await AdminModel.findByUsername(username);
            if (dupEmp || dupAdmin) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:emp_username_in_use', { username })
                        : `Username "${username}" is already in use`
                );
                return res.redirect(keepDraft(req, '/employees/create'));
            }

            // Verify RBAC access to the selected site/department/service
            if (!RBACService.isSuperAdmin(req.user)) {
                const placeErr = await destinationPlacementError(req.user, req.body, req.t);
                if (placeErr) {
                    req.flash('error', placeErr);
                    return res.redirect(keepDraft(req, '/employees/create'));
                }
            }

            // Optional supervisor + manager (manager may be employee OR admin)
            const supervisorId = req.body.supervisorId ? parseInt(req.body.supervisorId) : null;
            const mgr = await resolveManagerSelection(req.body.manager, null);
            if (mgr.error) {
                req.flash('error', mgr.error);
                return res.redirect(keepDraft(req, '/employees/create'));
            }

            const employee = await EmployeeModel.create({
                employeeNumber: employeeNumber,
                firstName: req.body.firstName.trim(),
                lastName: req.body.lastName.trim(),
                email: req.body.email?.trim() || null,
                phone: req.body.phone?.trim() || null,
                nationality: req.body.nationality
                    ? String(req.body.nationality).trim().slice(0, 80)
                    : null,
                siteId: parseInt(req.body.siteId),
                departmentId: parseInt(req.body.departmentId),
                serviceId: parseInt(req.body.serviceId),
                roleId: parseInt(req.body.roleId),
                supervisorId: supervisorId,
                managerId: mgr.managerId,
                managerType: mgr.managerType,
                isActive: 1,
            });

            // Provision the login account (username + hashed password, activated).
            const acct = await EmployeeAuthService.setupAccount(employee.id, username, password);
            if (!acct.success) {
                // Roll back the orphaned employee so we don't leave a record with no login.
                await EmployeeModel.delete(employee.id).catch(() => {});
                req.flash(
                    'error',
                    acct.message ||
                        (req.t
                            ? req.t('flash:emp_account_setup_failed')
                            : 'Could not set up the login account')
                );
                return res.redirect(keepDraft(req, '/employees/create'));
            }

            await LogService.log({
                adminId: req.user.id,
                action: 'EMPLOYEE_CREATED',
                entityType: 'employee',
                entityId: employee.id,
                details: `Created employee ${employee.employeeNumber} with login "${username}"`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
            // A created person is a JOINER: enrolled in the open
            // campaign by LifecycleService.onJoiner, not left out of its denominator.
            try {
                await require('../services/LifecycleService').record(
                    'joiner',
                    Number(employee.id),
                    {
                        payload: { source: 'employee_form' },
                        actorRef: `admin:${req.user.id}`,
                    }
                );
            } catch (e) {
                console.warn('[employees] joiner event failed:', e && e.message);
            }

            if (emailAdvisory) req.flash('warning', emailAdvisory);
            req.flash(
                'success',
                req.t
                    ? req.t('flash:emp_created', { username })
                    : `Employee created with login "${username}"`
            );
            res.redirect(`/employees/${employee.id}`);
        } catch (error) {
            console.error('Employee create error:', error);
            req.flash('error', req.t ? req.t('flash:emp_create_error') : 'Error creating employee');
            res.redirect(keepDraft(req, '/employees/create'));
        }
    }

    async editForm(req, res) {
        try {
            const { id } = req.params;
            const employee = await EmployeeModel.findByIdWithOrganization(id);

            if (!employee) {
                req.flash('error', req.t ? req.t('flash:emp_not_found') : 'Employee not found');
                return res.redirect('/employees');
            }

            const hasAccess = await RBACService.canAccessEmployeeData(req.user, employee);
            if (!hasAccess) {
                req.flash('error', req.t ? req.t('flash:access_denied') : 'Access denied');
                return res.redirect('/employees');
            }

            // Get accessible sites, departments, services, and roles
            let sites, departments, services, roles;

            if (RBACService.isSuperAdmin(req.user) || req.user.userType === 'manager') {
                // Managers edit within their governed span (checkEmployeeAccess
                // gates the target); the org structure itself is not scoped for
                // them — they can place their report in any site/dept/service.
                sites = await SiteModel.findAll({ isActive: 1 }, 'name ASC');
                departments = await DepartmentModel.findWithSite();
                services = await ServiceModel.findWithDepartment();
            } else {
                // Scope comes from the ONE resolver (utils/adminScope), which expands
                // region and country as well as site/department/service. Reading the raw
                // scope rows here and filtering on `scopeType === 'site'` meant a
                // COUNTRY-scoped admin got sites = [], and with no site value the
                // DOMContentLoaded cascade returned early so departments and services
                // never loaded either.
                const { resolveAdminScope } = require('../utils/adminScope');
                const scope = await resolveAdminScope(req.user);
                const siteIds = scope.siteIds || [];
                const departmentIds = scope.departmentIds || [];
                const serviceIds = scope.serviceIds || [];

                sites = siteIds.length
                    ? await SiteModel.findAll({ id: siteIds, isActive: 1 }, 'name ASC')
                    : [];
                departments = (await DepartmentModel.findWithSite()).filter((d) =>
                    departmentIds.some((id) => String(id) === String(d.id))
                );
                services = (await ServiceModel.findWithDepartment()).filter((s) =>
                    serviceIds.some((id) => String(id) === String(s.id))
                );

                // The option the employee ALREADY holds must always be present, even if
                // it sits outside the caller's scope. The caller is already authorised
                // against this person, and a <select> that cannot render the stored value
                // does not merely look wrong: the field is REQUIRED, so saving either
                // fails or rewrites their placement to something nobody chose. Same rule
                // the supervisor/manager dropdowns below already follow.
                const ensureOption = async (list, id, loader) => {
                    if (!id || list.some((x) => String(x.id) === String(id))) return list;
                    try {
                        const row = await loader(id);
                        return row ? [...list, row] : list;
                    } catch (_) {
                        return list;
                    }
                };
                sites = await ensureOption(sites, employee.siteId, (id) => SiteModel.findById(id));
                departments = await ensureOption(
                    departments,
                    employee.departmentId,
                    async (id) => (await DepartmentModel.findWithSite(null, [id]))[0]
                );
                services = await ensureOption(
                    services,
                    employee.serviceId,
                    async (id) => (await ServiceModel.findWithDepartment(null, [id]))[0]
                );
            }

            roles = await RoleModel.findAll({ isActive: 1 }, 'name ASC');

            // Get potential supervisors/managers (all active employees except self)
            const allEmployees = await RBACService.getFilteredEmployees(req.user);
            const supervisors = allEmployees.filter((e) => e.id !== employee.id && e.isActive);
            // The dropdown must always contain the CURRENTLY assigned supervisor /
            // manager (and the manager-user themselves) even when they fall outside
            // the caller's filtered list — otherwise saving the form silently
            // clears an assignment the caller never meant to touch.
            const have = new Set(supervisors.map((e) => Number(e.id)));
            const mustInclude = [
                employee.supervisorId,
                employee.managerType === 'employee' ? employee.managerId : null,
                req.user.userType === 'manager' ? req.user.id : null,
            ]
                .map(Number)
                .filter(
                    (x) => Number.isFinite(x) && x > 0 && x !== Number(employee.id) && !have.has(x)
                );
            for (const extraId of [...new Set(mustInclude)]) {
                const extra = await EmployeeModel.findById(extraId);
                if (extra && extra.isActive) {
                    supervisors.push(extra);
                    have.add(Number(extra.id));
                }
            }
            supervisors.sort((a, b) =>
                `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`)
            );
            // Managers may also be admin accounts. The admin ROSTER is identity
            // territory (admins only): a manager-user only gets the currently
            // assigned admin (so saving the form keeps it), never the full list.
            let adminManagers = await AdminModel.findAll({ isActive: 1 }, 'username ASC');
            if (req.user.userType === 'manager') {
                adminManagers =
                    employee.managerType === 'admin' && employee.managerId != null
                        ? adminManagers.filter((a) => Number(a.id) === Number(employee.managerId))
                        : [];
            }

            res.render('pages/employees/edit', {
                title: req.t
                    ? req.t('chrome:pt_employee_edit', {
                          name: `${employee.firstName} ${employee.lastName}`,
                      })
                    : `Edit Employee: ${employee.firstName} ${employee.lastName}`,
                employee,
                sites,
                departments,
                services,
                roles,
                supervisors,
                managers: supervisors,
                adminManagers,
            });
        } catch (error) {
            console.error('Employee edit form error:', error);
            req.flash('error', req.t ? req.t('flash:form_load_error') : 'Error loading form');
            res.redirect('/employees');
        }
    }

    async update(req, res) {
        try {
            const { id } = req.params;
            const employee = await EmployeeModel.findById(id);

            if (!employee) {
                req.flash('error', req.t ? req.t('flash:emp_not_found') : 'Employee not found');
                return res.redirect('/employees');
            }

            const hasAccess = await RBACService.canAccessEmployeeData(req.user, employee);
            if (!hasAccess) {
                req.flash('error', req.t ? req.t('flash:access_denied') : 'Access denied');
                return res.redirect('/employees');
            }

            // Validation is handled by express-validator middleware in routes
            // Additional business logic validations below

            // A MANAGER edits contact data and the reporting line — never the org
            // placement or the matricule: site / department /
            // service / role changes are org master data and go through an admin
            // (or a Mobilité event). The form hides those fields for managers;
            // this guards a hand-crafted POST.
            if (req.user.userType === 'manager' || req.user.userType === 'employee') {
                const locked = [
                    ['siteId', employee.siteId],
                    ['departmentId', employee.departmentId],
                    ['serviceId', employee.serviceId],
                    ['roleId', employee.roleId],
                    ['employeeNumber', employee.employeeNumber],
                ];
                const touched = locked.filter(
                    ([k, cur]) =>
                        req.body[k] != null && String(req.body[k]).trim() !== String(cur ?? '')
                );
                if (touched.length) {
                    req.flash(
                        'error',
                        req.t
                            ? req.t('flash:emp_manager_org_locked')
                            : 'Managers may not change site, department, service, role or employee number.'
                    );
                    return res.redirect(keepDraft(req, `/employees/${id}/edit`));
                }
            }

            const isSuperActor = RBACService.isSuperAdmin(req.user);
            const isAdminActor = req.user.userType === 'admin';
            const T = (k, fb) => (req.t ? req.t(k, { defaultValue: fb }) : fb);

            // 3.23.17 (A-3): the e-mail address is where the password-reset link
            // goes. Letting a manager or an admin holding only edit_employees
            // rewrite ANOTHER person's address was an account takeover in two
            // requests (change the address, ask for a reset). Changing it now
            // takes CREDENTIAL authority: SuperAdmin, or reset_employee_password
            // (scope already enforced above by canAccessEmployeeData).
            const normEmail = (s) =>
                String(s == null ? '' : s)
                    .trim()
                    .toLowerCase();
            const emailChanged = normEmail(req.body.email) !== normEmail(employee.email);
            if (emailChanged) {
                const credentialAuthority =
                    isAdminActor &&
                    (isSuperActor ||
                        RBACService.hasPermission(req.user, 'reset_employee_password'));
                if (!credentialAuthority) {
                    req.flash(
                        'error',
                        T(
                            'employee:emp_email_change_denied',
                            'Modifier l’adresse e-mail d’une autre personne requiert la capacité « Réinitialiser les mots de passe » : l’adresse n’a pas été modifiée.'
                        )
                    );
                    return res.redirect(keepDraft(req, `/employees/${id}/edit`));
                }
            }

            // 3.23.17 (A-4): the access check above authorises against where the
            // person IS; this checks where the form MOVES them (it used to live in
            // show, a GET, where it never ran on a write).
            const placementChanged = ['siteId', 'departmentId', 'serviceId'].some(
                (k) => String(parseInt(req.body[k], 10)) !== String(employee[k])
            );
            // SuperAdmin is unrestricted and keeps its previous behaviour.
            if (placementChanged && !isSuperActor) {
                const moveErr = await destinationPlacementError(req.user, req.body, req.t);
                if (moveErr) {
                    req.flash('error', moveErr);
                    return res.redirect(keepDraft(req, `/employees/${id}/edit`));
                }
            }

            // Check employee number uniqueness if changed
            if (req.body.employeeNumber !== employee.employeeNumber) {
                const existing = await EmployeeModel.findByEmployeeNumber(req.body.employeeNumber);
                if (existing) {
                    req.flash(
                        'error',
                        req.t ? req.t('flash:emp_number_exists') : 'Employee number already exists'
                    );
                    return res.redirect(keepDraft(req, `/employees/${id}/edit`));
                }
            }

            // A shared e-mail address is allowed (a person may hold several
            // accounts — migration 107); advise when it changed to one in use.
            let emailAdvisory = null;
            if (
                req.body.email &&
                req.body.email.trim() &&
                req.body.email.trim() !== (employee.email || '').trim()
            ) {
                emailAdvisory = await require('../services/EmailAccountsService').advisory(
                    req,
                    req.body.email,
                    { excludeEmployeeId: id }
                );
            }

            // Validate supervisor assignment (cannot be self, must be valid employee)
            let supervisorId = null;
            if (req.body.supervisorId) {
                supervisorId = parseInt(req.body.supervisorId);
                if (supervisorId === parseInt(id)) {
                    req.flash(
                        'error',
                        req.t
                            ? req.t('flash:emp_own_supervisor')
                            : 'Employee cannot be their own supervisor'
                    );
                    return res.redirect(keepDraft(req, `/employees/${id}/edit`));
                }
                const supervisor = await EmployeeModel.findById(supervisorId);
                // Same test as setSupervisor: an inactive or voided person cannot
                // supervise. The edit form used to accept either.
                if (!supervisor || !supervisor.isActive || supervisor.cancelledAt) {
                    req.flash(
                        'error',
                        req.t
                            ? req.t('flash:emp_invalid_supervisor')
                            : 'Invalid supervisor selected'
                    );
                    return res.redirect(keepDraft(req, `/employees/${id}/edit`));
                }
                // The proposed supervisor must not already report (at any depth)
                // to this employee — otherwise the chain loops.
                if (
                    Number(employee.supervisorId) !== supervisorId &&
                    (await EmployeeModel.wouldCreateReportingCycle(id, supervisorId))
                ) {
                    req.flash(
                        'error',
                        req.t
                            ? req.t('flash:emp_reporting_cycle')
                            : 'Invalid supervisor selected: this would create a reporting loop'
                    );
                    return res.redirect(keepDraft(req, `/employees/${id}/edit`));
                }
                // A manager-user assigns supervisors from within their own span
                // (themselves or someone they govern) — the same rule the
                // dedicated /supervisor endpoint enforces; this guards the full
                // form against a hand-crafted POST wiring in an outside person.
                if (
                    req.user.userType === 'manager' &&
                    Number(employee.supervisorId) !== supervisorId &&
                    !(await managerCanAssignSupervisor(req.user.id, supervisorId))
                ) {
                    req.flash(
                        'error',
                        req.t
                            ? req.t('flash:no_permission')
                            : 'Access denied. You do not have permission for this action.'
                    );
                    return res.redirect(keepDraft(req, `/employees/${id}/edit`));
                }
                // 3.23.17 (A-4): a scoped admin may wire in, as a NEW supervisor,
                // only someone inside their own scope — the supervisor gains
                // authority over this person. An unchanged line is kept as is.
                if (
                    isAdminActor &&
                    !isSuperActor &&
                    Number(employee.supervisorId) !== supervisorId &&
                    !(await RBACService.canAccessEmployeeData(req.user, supervisor))
                ) {
                    req.flash(
                        'error',
                        T(
                            'employee:emp_supervisor_out_of_scope',
                            'Ce superviseur est hors de votre périmètre : la ligne hiérarchique n’a pas été modifiée.'
                        )
                    );
                    return res.redirect(keepDraft(req, `/employees/${id}/edit`));
                }
            }

            // Manager (may be an employee OR an admin account)
            const mgr = await resolveManagerSelection(req.body.manager, id);
            if (mgr.error) {
                req.flash('error', mgr.error);
                return res.redirect(keepDraft(req, `/employees/${id}/edit`));
            }
            // Identity boundary: a manager-user may keep the currently assigned
            // ADMIN manager but never assign or switch to one — wiring people to
            // admin accounts is admin business (the form doesn't offer the admin
            // roster to managers either; this guards direct POSTs).
            if (req.user.userType === 'manager' && mgr.managerType === 'admin') {
                const unchanged =
                    employee.managerType === 'admin' &&
                    Number(employee.managerId) === Number(mgr.managerId);
                if (!unchanged) {
                    req.flash(
                        'error',
                        req.t
                            ? req.t('flash:no_permission')
                            : 'Access denied. You do not have permission for this action.'
                    );
                    return res.redirect(keepDraft(req, `/employees/${id}/edit`));
                }
            }
            // 3.23.17 (A-4): a scoped admin naming a NEW manager — the manager
            // gains read authority over this person — may name only someone
            // inside their scope: an employee they govern, themselves, or an
            // admin account they could administer. Unchanged is kept as is.
            if (isAdminActor && !isSuperActor && mgr.managerId != null) {
                const mgrUnchanged =
                    String(employee.managerType || '') === String(mgr.managerType) &&
                    Number(employee.managerId) === Number(mgr.managerId);
                let mgrAllowed = mgrUnchanged;
                if (!mgrAllowed && mgr.managerType === 'employee') {
                    mgrAllowed = await RBACService.canAccessEmployee(req.user, mgr.managerId);
                } else if (!mgrAllowed && mgr.managerType === 'admin') {
                    mgrAllowed =
                        Number(mgr.managerId) === Number(req.user.id) ||
                        (await require('./AdminController')._internals.canManageTargetAdmin(
                            req.user,
                            mgr.managerId
                        ));
                }
                if (!mgrAllowed) {
                    req.flash(
                        'error',
                        T(
                            'employee:emp_manager_out_of_scope',
                            'Ce manager est hors de votre périmètre : la ligne hiérarchique n’a pas été modifiée.'
                        )
                    );
                    return res.redirect(keepDraft(req, `/employees/${id}/edit`));
                }
            }

            // Tag the transaction with the signed-in user so any site/department/
            // service/role/manager change this edit causes is attributed to them in
            // the movement trail instead of falling back to "system".
            await require('../config/database').withActor(req, () =>
                EmployeeModel.update(id, {
                    employeeNumber: req.body.employeeNumber.trim(),
                    firstName: req.body.firstName.trim(),
                    lastName: req.body.lastName.trim(),
                    email: req.body.email?.trim() || null,
                    phone: req.body.phone?.trim() || null,
                    // Only touch nationality when the field was actually submitted — the
                    // input is gated by the optional local-content module, and an edit
                    // with the module OFF must not wipe previously recorded data.
                    ...('nationality' in req.body
                        ? {
                              nationality: req.body.nationality
                                  ? String(req.body.nationality).trim().slice(0, 80)
                                  : null,
                          }
                        : {}),
                    siteId: parseInt(req.body.siteId),
                    departmentId: parseInt(req.body.departmentId),
                    serviceId: parseInt(req.body.serviceId),
                    roleId: parseInt(req.body.roleId),
                    supervisorId: supervisorId,
                    managerId: mgr.managerId,
                    managerType: mgr.managerType,
                })
            );

            // A-3: outstanding reset links die with the old address, and the old
            // address is told (best-effort, never blocks the edit).
            if (emailChanged) {
                await require('../services/PasswordResetService').onEmailChanged(
                    'employee',
                    Number(id),
                    {
                        oldEmail: employee.email,
                        newEmail: req.body.email?.trim() || null,
                        t: req.t,
                        name: `${employee.firstName || ''} ${employee.lastName || ''}`.trim(),
                    }
                );
            }

            await LogService.log({
                adminId: req.user.id,
                action: 'EMPLOYEE_UPDATED',
                entityType: 'employee',
                entityId: id,
                details: `Updated employee: ${req.body.employeeNumber}`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            // A real placement change IS a mobility: the JML
            // ledger, the handover plan and the notification follow the form
            // instead of waiting for someone to record the move by hand.
            let moved = null;
            try {
                moved = await require('../services/LifecycleService').moverFromChanges(
                    Number(id),
                    {
                        siteId: employee.siteId,
                        departmentId: employee.departmentId,
                        serviceId: employee.serviceId,
                        roleId: employee.roleId,
                    },
                    {
                        siteId: parseInt(req.body.siteId),
                        departmentId: parseInt(req.body.departmentId),
                        serviceId: parseInt(req.body.serviceId),
                        roleId: parseInt(req.body.roleId),
                    },
                    {
                        actorRef: `${req.user.userType || 'admin'}:${req.user.id}`,
                        reason: req.body.moveReason
                            ? String(req.body.moveReason).slice(0, 500)
                            : null,
                    }
                );
            } catch (e) {
                console.warn('[employees] mover event failed:', e && e.message);
            }

            if (emailAdvisory) req.flash('warning', emailAdvisory);
            req.flash(
                'success',
                req.t ? req.t('flash:emp_updated') : 'Employee updated successfully'
            );
            if (moved)
                req.flash(
                    'success',
                    req.t
                        ? req.t('flash:emp_mover_recorded')
                        : 'A mobility event was recorded on the lifecycle ledger.'
                );
            res.redirect(`/employees/${id}`);
        } catch (error) {
            console.error('Employee update error:', error);
            req.flash('error', req.t ? req.t('flash:emp_update_error') : 'Error updating employee');
            res.redirect(keepDraft(req, `/employees/${req.params.id}/edit`));
        }
    }

    // Quick per-subordinate supervisor assignment (JSON; used by the inline
    // control on the employee list). Route guard: manager OR edit_employees
    // admin, plus checkEmployeeAccess for the target. Managers may only assign
    // themselves or someone within their governed span.
    async setSupervisor(req, res) {
        // JSON refusals in the caller's language: the roster script shows
        // `error` verbatim on a French page. `code` stays stable for API callers.
        const refuse = (status, code, fallback) =>
            res.status(status).json({ code, error: req.t ? req.t(`flash:${code}`) : fallback });
        try {
            const { id } = req.params;
            const employee = await EmployeeModel.findById(id);
            if (!employee) return refuse(404, 'emp_not_found', 'Employee not found');

            const raw = req.body.supervisorId;
            let supervisorId = null;
            let supervisor = null;
            if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
                supervisorId = parseInt(raw, 10);
                if (!Number.isInteger(supervisorId) || supervisorId <= 0) {
                    return refuse(400, 'emp_invalid_supervisor', 'Invalid supervisor');
                }
                if (supervisorId === Number(id)) {
                    return refuse(
                        400,
                        'emp_own_supervisor',
                        'Employee cannot be their own supervisor'
                    );
                }
                supervisor = await EmployeeModel.findById(supervisorId);
                if (!supervisor || !supervisor.isActive || supervisor.cancelledAt) {
                    return refuse(400, 'emp_invalid_supervisor', 'Invalid supervisor selected');
                }
                if (
                    Number(employee.supervisorId) !== supervisorId &&
                    (await EmployeeModel.wouldCreateReportingCycle(id, supervisorId))
                ) {
                    return refuse(
                        400,
                        'emp_reporting_cycle',
                        'Invalid supervisor selected: this would create a reporting loop'
                    );
                }
                if (
                    req.user.userType === 'manager' &&
                    !(await managerCanAssignSupervisor(req.user.id, supervisorId))
                ) {
                    return refuse(
                        403,
                        'emp_supervisor_span',
                        'You may only assign yourself or someone in your team as supervisor'
                    );
                }
            }

            // Attributed to the signed-in user so the 'supervisor' movement the
            // trigger records names WHO changed the reporting line.
            await require('../config/database').withActor(req, () =>
                EmployeeModel.update(id, { supervisorId })
            );
            await LogService.log({
                adminId: req.user.userType === 'admin' ? req.user.id : null,
                actorRef: `${req.user.userType || 'admin'}:${req.user.id}`,
                action: 'EMPLOYEE_SUPERVISOR_SET',
                entityType: 'employee',
                entityId: id,
                details: `Supervisor ${supervisorId == null ? 'cleared' : 'set to employee #' + supervisorId} for employee #${id}`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
            const supervisorName = supervisor
                ? `${supervisor.firstName} ${supervisor.lastName}`
                : null;
            res.json({
                success: true,
                supervisorId,
                supervisorName,
                message: req.t
                    ? req.t(
                          supervisorId == null
                              ? 'flash:emp_supervisor_cleared'
                              : 'flash:emp_supervisor_saved',
                          { name: supervisorName || '' }
                      )
                    : 'Supervisor saved',
            });
        } catch (error) {
            console.error('Set supervisor error:', error);
            return refuse(500, 'emp_update_error', 'Error setting supervisor');
        }
    }

    async delete(req, res) {
        try {
            const { id } = req.params;
            const employee = await EmployeeModel.findById(id);

            if (!employee) {
                req.flash('error', req.t ? req.t('flash:emp_not_found') : 'Employee not found');
                return res.redirect('/employees');
            }

            const hasAccess = await RBACService.canAccessEmployeeData(req.user, employee);
            if (!hasAccess) {
                req.flash('error', req.t ? req.t('flash:access_denied') : 'Access denied');
                return res.redirect('/employees');
            }

            // "Delete" is a departure, and a departure is the JML leaver cascade —
            // not `isActive = 0`. That single flag left is_account_active on, so
            // the person's password still logged in, their sessions lived on and
            // a linked admin account (with its API keys) stayed active — all
            // reproduced by rolled-back probe. LifecycleService.deprovision records
            // the leaver event (revertable from the JML screen) and runs the
            // complete cascade.
            await require('../services/LifecycleService').deprovision(Number(id), {
                source: 'admin_delete',
                actorRef: `${req.user.userType || 'admin'}:${req.user.id}`,
            });

            await LogService.log({
                adminId: req.user.id,
                action: 'EMPLOYEE_DELETED',
                entityType: 'employee',
                entityId: id,
                details: `Deleted employee: ${employee.employeeNumber}`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            req.flash(
                'success',
                req.t ? req.t('flash:emp_deleted') : 'Employee deleted successfully'
            );
            res.redirect('/employees');
        } catch (error) {
            console.error('Employee delete error:', error);
            req.flash('error', req.t ? req.t('flash:emp_delete_error') : 'Error deleting employee');
            res.redirect('/employees');
        }
    }

    // (activateAccount and resetPassword were removed: two
    // credential-writing endpoints no view used; setCredentials replaced both.)

    /**
     * Set/choose the username and/or password for an employee — whether or not
     * the account already exists (reset_employee_password + scope, route-guarded).
     * Either field is optional (blank password keeps the current one); at least
     * one must be provided. A password set here counts as an invitation
     * so the "never invited" / "expired" states stay honest.
     */
    async setCredentials(req, res) {
        const refuse = (status, code) =>
            res.status(status).json({ code, error: req.t ? req.t(`admin:acc_err_${code}`) : code });
        try {
            const { id } = req.params;
            let { username, password, forcePasswordChange } = req.body;
            username = (username || '').trim();

            const employee = await EmployeeModel.findById(id);
            if (!employee) return refuse(404, 'not_found');
            if (employee.isActive === false || employee.isActive === 0)
                return refuse(409, 'employee_deactivated');

            const updates = {};
            if (username) {
                if (username.length < 3) return refuse(400, 'username_too_short');
                const existing = await EmployeeModel.findByUsername(username);
                if (existing && Number(existing.id) !== Number(id))
                    return refuse(409, 'username_taken');
                // Don't collide with an admin login of the same name either.
                try {
                    const AdminModel = require('../models/AdminModel');
                    const adminDup = await AdminModel.findByUsername(username);
                    if (adminDup) return refuse(409, 'username_taken');
                } catch (_) {
                    /* AdminModel optional */
                }
                updates.username = username;
            }
            if (password) {
                const pwCheckSet = passwordValidator.validate(String(password));
                if (!pwCheckSet.valid)
                    return res.status(400).json({
                        code: 'password_policy',
                        error: req.t
                            ? req.t('flash:pw_policy', { errors: pwCheckSet.errors.join('; ') })
                            : 'Password: ' + pwCheckSet.errors.join('; '),
                    });
                const bcrypt = require('bcrypt');
                updates.passwordHash = await bcrypt.hash(String(password), 10);
                updates.forcePasswordChange = forcePasswordChange ? 1 : 0;
                updates.invitedAt = new Date().toISOString();
                updates.invitedBy = req.user.userType === 'admin' ? req.user.id : null;
            }
            if (!updates.username && !updates.passwordHash) return refuse(400, 'nothing_to_update');
            updates.isAccountActive = 1; // setting credentials activates the login

            await EmployeeModel.update(id, updates);

            await LogService.log({
                adminId: req.user.id,
                action: 'EMPLOYEE_CREDENTIALS_SET',
                entityType: 'employee',
                entityId: parseInt(id),
                details:
                    `Set credentials for employee ${id}` +
                    (updates.username ? ` (username=${updates.username})` : '') +
                    (updates.passwordHash ? ' (password changed)' : ''),
                severity: 'info',
                category: 'security',
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
            try {
                await require('../services/MovementService').recordAccount(id, {
                    actor: req.user,
                    fromLabel: employee.passwordHash ? 'credentials' : 'no_credentials',
                    toLabel: updates.passwordHash ? 'credentials_set' : 'username_set',
                });
            } catch (_) {
                /* feed row is best-effort */
            }

            res.json({
                success: true,
                ok: true,
                message: req.t
                    ? req.t('admin:acc_credentials_updated')
                    : 'Login credentials updated.',
            });
        } catch (error) {
            console.error('Set credentials error:', error);
            return refuse(500, 'error');
        }
    }

    /**
     * Unlock a login blocked by failed attempts (reset_employee_password + scope):
     * the lockout is count-based (login_attempts rows in the window, enforced by
     * checkAccountLockout for ANY identifier), so clearing the failed rows for
     * both identifiers the person can sign in with unlocks immediately.
     */
    async unlock(req, res) {
        const employee = await EmployeeModel.findById(req.params.id);
        if (!employee)
            return res.status(404).json({
                code: 'not_found',
                error: req.t ? req.t('admin:acc_err_not_found') : 'Employee not found',
            });
        const { scopedEmployeeIds } = require('../utils/rbacScope');
        const ids = await scopedEmployeeIds(req.user);
        if (ids !== null && !ids.includes(Number(employee.id))) {
            return res.status(403).json({
                code: 'out_of_scope',
                error: req.t ? req.t('admin:acc_err_out_of_scope') : 'Employee outside your scope',
            });
        }
        const r = await require('./InvitationController')._apply(
            'unlock',
            Number(employee.id),
            req,
            {}
        );
        if (!r.ok)
            return res
                .status(400)
                .json({ code: r.code, error: req.t ? req.t(`admin:acc_err_${r.code}`) : r.code });
        res.json({
            success: true,
            ok: true,
            message: req.t
                ? req.t('admin:acc_unlocked')
                : 'Account unlocked — the employee can sign in immediately.',
        });
    }

    /** Issue credentials + welcome e-mail (or the one-time sheet) for one person. */
    async sendCredentials(req, res) {
        const r = await require('./InvitationController')._apply(
            'resend',
            Number(req.params.id),
            req,
            { welcome: true }
        );
        if (!r.ok)
            return res
                .status(400)
                .json({ code: r.code, error: req.t ? req.t(`admin:acc_err_${r.code}`) : r.code });
        res.json({
            success: true,
            ok: true,
            username: r.username,
            emailed: r.emailed,
            emailStatus: r.credential ? r.credential.reason : 'sent',
            ...(r.credential ? { credentials: [r.credential] } : {}),
            message: req.t
                ? req.t(r.emailed ? 'admin:acc_creds_emailed' : 'admin:acc_creds_on_sheet', {
                      username: r.username,
                  })
                : 'Credentials issued',
        });
    }

    /**
     * Reinstate a departed person: whoever may
     * deprovision within scope may bring back within scope. Goes through
     * LifecycleService.reinstate so the linked admin accounts / API keys the
     * departure switched off come back too; refuses voided / erased records.
     */
    async reactivate(req, res) {
        const employee = await EmployeeModel.findById(req.params.id);
        if (!employee)
            return res.status(404).json({
                code: 'not_found',
                error: req.t ? req.t('admin:acc_err_not_found') : 'Employee not found',
            });
        try {
            const out = await require('../services/LifecycleService').reinstate(
                Number(employee.id),
                // `actor`: restoring a LINKED ADMIN account is SuperAdmin-only (A-2).
                { source: 'admin_reactivate', adminId: req.user.id, actor: req.user }
            );
            await LogService.log({
                adminId: req.user.id,
                action: 'EMPLOYEE_REACTIVATED',
                entityType: 'employee',
                entityId: employee.id,
                details: `Employee ${employee.employeeNumber} reactivated (${out.via})`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
            res.json({
                success: true,
                ok: true,
                message: req.t ? req.t('admin:acc_reactivated') : 'Employee reactivated',
                summary: out,
            });
        } catch (e) {
            if (e && e.status === 409)
                return res.status(409).json({
                    code: e.code,
                    error: req.t
                        ? req.t(`admin:maint_err_${e.code}`, { defaultValue: e.code })
                        : e.code,
                });
            throw e;
        }
    }

    /**
     * A manager's one-click "request unlock / resend" for a report:
     * lands as an action item for the admins holding reset_employee_password
     * and on the Accounts console. Never acts on the account itself.
     */
    async accountRequest(req, res) {
        const kind = String(req.body.kind || '');
        const refuse = (status, code) =>
            res.status(status).json({ code, error: req.t ? req.t(`admin:acc_err_${code}`) : code });
        if (!['unlock', 'resend'].includes(kind)) return refuse(400, 'bad_request_kind');
        const id = Number(req.params.id);
        const employee = await EmployeeModel.findById(id);
        if (!employee || employee.isActive === false) return refuse(404, 'not_found');
        const db = require('../config/database');
        const open = await db.get(
            'SELECT id FROM account_requests WHERE employee_id = ? AND kind = ? AND decided_at IS NULL',
            [id, kind]
        );
        if (open)
            return res.json({
                ok: true,
                alreadyOpen: true,
                message: req.t
                    ? req.t('admin:acc_request_already_open')
                    : 'A request is already open.',
            });
        const note =
            String(req.body.note || '')
                .trim()
                .slice(0, 500) || null;
        await db.run(
            'INSERT INTO account_requests (employee_id, kind, requested_by, note) VALUES (?, ?, ?, ?)',
            [id, kind, Number(req.user.id), note]
        );
        await LogService.log({
            adminId: null,
            actorRef: `employee:${req.user.id}`,
            action: 'ACCOUNT_REQUEST_CREATED',
            entityType: 'employee',
            entityId: id,
            details: `Manager #${req.user.id} requested '${kind}' for employee ${employee.employeeNumber}${note ? ` — ${note}` : ''}`,
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
        });
        res.json({
            ok: true,
            message: req.t
                ? req.t('admin:acc_request_sent')
                : 'Request sent to the administrators.',
        });
    }

    // ---- Access & identity (SSO merge / promote to admin) ------------------
    async linkSso(req, res) {
        const AccountLinkService = require('../services/AccountLinkService');
        const result = await AccountLinkService.linkSsoIdentity(
            {
                targetType: 'employee',
                targetId: parseInt(req.params.id, 10),
                provider: req.body.provider,
                externalId: req.body.externalId,
            },
            req.user
        );
        req.flash(
            result.ok ? 'success' : 'error',
            // Le service rend un CODE stable + ses parametres ; `message` n'est que
            // le dernier recours anglais d'un appelant sans traducteur.
            result.code && req.t
                ? req.t(`admin:${result.code}`, result.params || {})
                : result.message
        );
        res.redirect(`/employees/${req.params.id}`);
    }

    async unlinkSso(req, res) {
        const AccountLinkService = require('../services/AccountLinkService');
        const result = await AccountLinkService.unlinkSsoIdentity(
            { targetType: 'employee', targetId: parseInt(req.params.id, 10) },
            req.user
        );
        req.flash(
            result.ok ? 'success' : 'error',
            // Le service rend un CODE stable + ses parametres ; `message` n'est que
            // le dernier recours anglais d'un appelant sans traducteur.
            result.code && req.t
                ? req.t(`admin:${result.code}`, result.params || {})
                : result.message
        );
        res.redirect(`/employees/${req.params.id}`);
    }

    async grantAdmin(req, res) {
        const AccountLinkService = require('../services/AccountLinkService');
        let permissions = req.body.permissions;
        if (permissions && !Array.isArray(permissions)) permissions = [permissions];
        const result = await AccountLinkService.grantAdminAccess(
            {
                employeeId: parseInt(req.params.id, 10),
                role: req.body.role,
                permissions: permissions || [],
            },
            req.user
        );
        req.flash(
            result.ok ? 'success' : 'error',
            // Le service rend un CODE stable + ses parametres ; `message` n'est que
            // le dernier recours anglais d'un appelant sans traducteur.
            result.code && req.t
                ? req.t(`admin:${result.code}`, result.params || {})
                : result.message
        );
        res.redirect(`/employees/${req.params.id}`);
    }

    async removeIdentity(req, res) {
        const AccountLinkService = require('../services/AccountLinkService');
        const result = await AccountLinkService.removeIdentity(
            parseInt(req.body.identityId, 10),
            req.user
        );
        req.flash(
            result.ok ? 'success' : 'error',
            // Le service rend un CODE stable + ses parametres ; `message` n'est que
            // le dernier recours anglais d'un appelant sans traducteur.
            result.code && req.t
                ? req.t(`admin:${result.code}`, result.params || {})
                : result.message
        );
        res.redirect(`/employees/${req.params.id}`);
    }

    async setPasswordAuth(req, res) {
        try {
            const targetId = parseInt(req.params.id, 10);
            // Scope: a delegated admin may only toggle sign-in for employees in their scope.
            const RBACService = require('../services/RBACService');
            if (
                !RBACService.isSuperAdmin(req.user) &&
                !(await RBACService.canAccessEmployee(req.user, targetId))
            ) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:emp_out_of_scope')
                        : 'That employee is outside your administrative scope.'
                );
                return res.redirect(`/employees/${targetId}`);
            }
            const disabled = req.body.disabled === '1' || req.body.disabled === 'true';
            const db = require('../config/database');
            await db.run('UPDATE employees SET password_disabled = ? WHERE id = ?', [
                disabled,
                targetId,
            ]);
            require('../services/LogService').log({
                adminId: req.user && req.user.id,
                action: disabled ? 'ACCOUNT_PASSWORD_DISABLED' : 'ACCOUNT_PASSWORD_ENABLED',
                entityType: 'employee',
                entityId: parseInt(req.params.id, 10),
                details: `Local password auth ${disabled ? 'disabled — sign-in via SSO only' : 'enabled'} for employee #${req.params.id}`,
            });
            req.flash(
                'success',
                disabled
                    ? req.t
                        ? req.t('flash:emp_password_disabled')
                        : 'Local password disabled — this person now signs in via SSO.'
                    : req.t
                      ? req.t('flash:emp_password_enabled')
                      : 'Local password re-enabled.'
            );
        } catch (e) {
            console.error('setPasswordAuth error:', e);
            req.flash(
                'error',
                req.t
                    ? req.t('flash:emp_password_setting_error')
                    : 'Could not update password setting.'
            );
        }
        res.redirect(`/employees/${req.params.id}`);
    }
}

module.exports = new EmployeeController();
// Shared with OnboardingService.approve so a placement made from the onboarding
// queue is validated by exactly the rule the employee form applies.
module.exports.destinationPlacementError = destinationPlacementError;
