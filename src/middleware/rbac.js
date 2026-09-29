const RBACService = require('../services/RBACService');
const EmployeeModel = require('../models/EmployeeModel');

/**
 * SCOPE denial — the sibling of denyPermission in middleware/auth.js.
 *
 * These four guards used to end with a hardcoded ENGLISH flash on a
 * French-first UI ("Access denied. You do not have permission to access this
 * employee.") followed by a redirect that erased the reason. The holder is not
 * missing a capability here: they hold it, but the record sits OUTSIDE their
 * assigned site / department / service. That distinction is exactly what the
 * user needs to be told, so it now renders the same explanatory 403 page with
 * `scopeDenied` set instead of `missing`.
 *
 * The XHR/JSON branch is kept EXACTLY as it was (`{ error: 'Access denied' }`)
 * so no API consumer changes behaviour.
 *
 * @param {string} kind  'employee' | 'site' | 'department' | 'service'
 * @param {string} backUrl  the list page the caller came from
 */
async function denyScope(req, res, kind, backUrl) {
    // Same caller test as denyPermission: the app's own fetch sends only a
    // JSON Content-Type — no Accept, no X-Requested-With — and used to receive
    // the HTML 403 page here, which the client could not parse.
    const { wantsJson } = require('./auth');
    if (wantsJson(req)) {
        return res.status(403).json({ error: 'Access denied' });
    }
    try {
        const t = (key, fallback) => (req.t ? req.t(key, { defaultValue: fallback }) : fallback);
        const isAdmin = req.user && req.user.userType === 'admin';
        // the same contactable list as the capability refusal.
        const granters = await require('../utils/contactableAdmins').contactableGranters();
        return res.status(403).render('pages/errors/403-permission', {
            title: t('admin:acc_403_title', 'Accès refusé'),
            attemptedPath: String(req.originalUrl || req.path || '/').split('?')[0],
            attemptedMethod: String(req.method || 'GET').toUpperCase(),
            missing: [],
            scopeDenied: { kind, backUrl },
            granters,
            isAdmin,
            backUrl,
        });
    } catch (e) {
        // Never let the denial page itself 500 — degrade to a localized flash.
        req.flash('error', req.t ? req.t('flash:no_permission') : 'Access denied.');
        return res.redirect(backUrl);
    }
}

/**
 * STRICT id parse shared by the guards and the handlers behind them (3.23.17,
 * A-5). `parseInt('137e1')` is 137 while `Number('137e1')` is 1370: a guard that
 * authorised one id and a handler that read another. Only a plain run of digits
 * is an id; anything else is NaN, which every guard refuses.
 */
function parseStrictId(raw) {
    if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw > 0 ? raw : NaN;
    const s = String(raw == null ? '' : raw).trim();
    if (!/^\d+$/.test(s)) return NaN;
    const n = Number(s);
    return Number.isSafeInteger(n) && n > 0 ? n : NaN;
}

// Middleware to check RBAC access for employees
const checkEmployeeAccess = async (req, res, next) => {
    try {
        const employeeId = parseStrictId(
            req.params.id ||
                (req.body && req.body.employeeId) ||
                (req.query && req.query.employeeId)
        );

        if (!employeeId) {
            return res.status(400).json({ error: 'Employee ID required' });
        }

        const hasAccess = await RBACService.canAccessEmployee(req.user, employeeId);

        if (!hasAccess) {
            return await denyScope(req, res, 'employee', '/employees');
        }

        next();
    } catch (error) {
        console.error('RBAC check error:', error);
        res.status(500).json({ error: 'Access check failed' });
    }
};

// READ-only variant for the employee record page: also admits the people an
// admin account is directly named manager of (RBACService.canViewEmployee).
const checkEmployeeReadAccess = async (req, res, next) => {
    try {
        const employeeId = parseStrictId(req.params.id);
        if (!employeeId) return res.status(400).json({ error: 'Employee ID required' });
        if (!(await RBACService.canViewEmployee(req.user, employeeId))) {
            return await denyScope(req, res, 'employee', '/employees');
        }
        next();
    } catch (error) {
        console.error('RBAC check error:', error);
        res.status(500).json({ error: 'Access check failed' });
    }
};

// Middleware to check RBAC access for sites
const checkSiteAccess = async (req, res, next) => {
    try {
        const siteId = parseInt(req.params.id || req.body.siteId || req.query.siteId);

        if (!siteId) {
            return res.status(400).json({ error: 'Site ID required' });
        }

        const hasAccess = await RBACService.canAccessSite(req.user, siteId);

        if (!hasAccess) {
            return await denyScope(req, res, 'site', '/organization/sites');
        }

        next();
    } catch (error) {
        console.error('RBAC check error:', error);
        res.status(500).json({ error: 'Access check failed' });
    }
};

// Middleware to check RBAC access for departments
const checkDepartmentAccess = async (req, res, next) => {
    try {
        const departmentId = parseInt(
            req.params.id || req.body.departmentId || req.query.departmentId
        );

        if (!departmentId) {
            return res.status(400).json({ error: 'Department ID required' });
        }

        const hasAccess = await RBACService.canAccessDepartment(req.user, departmentId);

        if (!hasAccess) {
            return await denyScope(req, res, 'department', '/organization/departments');
        }

        next();
    } catch (error) {
        console.error('RBAC check error:', error);
        res.status(500).json({ error: 'Access check failed' });
    }
};

// Middleware to check RBAC access for services
const checkServiceAccess = async (req, res, next) => {
    try {
        const serviceId = parseInt(req.params.id || req.body.serviceId || req.query.serviceId);

        if (!serviceId) {
            return res.status(400).json({ error: 'Service ID required' });
        }

        const hasAccess = await RBACService.canAccessService(req.user, serviceId);

        if (!hasAccess) {
            return await denyScope(req, res, 'service', '/organization/services');
        }

        next();
    } catch (error) {
        console.error('RBAC check error:', error);
        res.status(500).json({ error: 'Access check failed' });
    }
};

// Middleware to populate req.scope based on user role and assigned scopes
const rbacMiddleware = async (req, res, next) => {
    if (!req.user) {
        return next();
    }

    const scope = {
        siteIds: [],
        departmentIds: [],
        serviceIds: [],
        employeeIds: [],
    };

    if (req.user.userType === 'admin' && req.user.role === 'superadmin') {
        // SuperAdmin has no restrictions (empty scope object implies all access in Controller)
        req.scope = {};
        return next();
    }

    if (req.user.userType === 'employee' || req.user.userType === 'manager') {
        // Managers/supervisors see ONLY the people they govern — their full
        // reporting sub-tree (reports + reports-of-reports), not their whole site.
        try {
            scope.employeeIds = await EmployeeModel.findGovernedIds(req.user.id);
        } catch (e) {
            scope.employeeIds = [];
        }
        // No reports → see nothing (force an impossible id rather than "all").
        if (!scope.employeeIds.length) scope.employeeIds.push(-1);
        req.scope = scope;
        return next();
    }

    // Local admins / viewers — expanded by utils/adminScope, the ONE reader of
    // admin_scopes. This block used to parse the raw rows itself: it knew site,
    // department, service and country but not REGION, and it expanded country to
    // sites inline with the failure swallowed.
    //
    // That inline version had a specific hole. `hasScope` counted
    // `countryIds.length` BEFORE knowing whether the expansion had produced any
    // site, so two ordinary situations —
    //   · a country scope over a country that has no sites yet (routine when a
    //     new geography is created before its sites), and
    //   · a transient DB error on the expansion query, whose catch was silent
    // — left siteIds, departmentIds and serviceIds ALL empty while suppressing
    // the `-1` sentinel below. Downstream consumers read an empty array as
    // "no filter", so the result was a whole-organisation dashboard, benchmark
    // and executive aggregate for an admin scoped to one country.
    //
    // The resolver removes the guesswork: it returns the real sets or throws, and
    // the sentinel is now decided by what was actually resolved.
    let resolved = null;
    try {
        const { resolveAdminScope } = require('../utils/adminScope');
        resolved = await resolveAdminScope(req.user);
    } catch (e) {
        // FAIL CLOSED. The previous code's catch let the request continue with an
        // empty scope, which downstream means "everything". An authority layer
        // that cannot determine authority must grant none.
        console.error('rbacMiddleware: scope resolution failed —', e && e.message);
        resolved = null;
    }

    if (resolved && resolved.unrestricted) {
        req.scope = scope; // superadmin: no filters
        return next();
    }

    if (resolved) {
        scope.siteIds = [...resolved.siteIds];
        scope.departmentIds = [...resolved.departmentIds];
        scope.serviceIds = [...resolved.serviceIds];
        // The exact set is strictly better than the org-unit approximation, and
        // every consumer already folds employeeIds in when present.
        scope.employeeIds = [...resolved.employeeIds];
    }

    // 3.23.18 — THE REPORTING LINE OF THE PERSON BEHIND THE ACCOUNT.
    // An administration account linked to a person (admins.linked_employee_id),
    // or named the manager of someone (manager_type='admin'), governs that line
    // on top of its clearance. RBACService.scopeFilter — the review console, the
    // IDP and PIP lists — has unioned it since 3.23.x; this middleware did not,
    // so the dashboards, the benchmark and the executive view of the same human
    // showed their clearance WITHOUT their team. Same source, same union:
    // GovernanceService.lineAuthorityEmployeeIds.
    //
    // Consumers AND the org-unit lists with employeeIds (DashboardModel
    // ._buildFilterClause), so the line people's own site/department/service
    // are added to the unit lists — otherwise a report outside the clearance
    // would be listed in employeeIds and filtered straight back out by siteIds.
    // employeeIds stays the EXACT authority set, so this cannot widen anything
    // beyond those people. Only when the scope itself resolved (a failed
    // resolution stays closed).
    if (resolved) {
        try {
            // ST-5 (3.23.21): this runs on EVERY admin request (dashboards,
            // /api/benchmark/fit polling…) — read the per-account memo (60 s)
            // rather than re-resolving the line each time. The memo is an
            // optimisation only: without it, the direct resolution is used.
            const Gov = require('../services/GovernanceService');
            const line = (
                await (typeof Gov.lineAuthorityEmployeeIdsCached === 'function'
                    ? Gov.lineAuthorityEmployeeIdsCached(req.user)
                    : Gov.lineAuthorityEmployeeIds(req.user))
            )
                .map(Number)
                .filter((n) => Number.isInteger(n) && n > 0);
            const have = new Set(scope.employeeIds.map(Number));
            const extra = [...new Set(line.filter((id) => !have.has(id)))];
            if (extra.length) {
                const units = await EmployeeModel.orgUnitsOf(extra);
                const add = (arr, ids) => {
                    const s = new Set(arr.map(Number));
                    for (const id of ids || []) {
                        const n = Number(id);
                        if (Number.isInteger(n) && n > 0 && !s.has(n)) {
                            s.add(n);
                            arr.push(n);
                        }
                    }
                };
                add(scope.siteIds, units.siteIds);
                add(scope.departmentIds, units.departmentIds);
                add(scope.serviceIds, units.serviceIds);
                scope.employeeIds.push(...extra);
            }
        } catch (e) {
            // The line could not be resolved: keep the clearance exactly as it
            // resolved (never wider), and say so in the log.
            console.error('rbacMiddleware: line authority failed —', e && e.message);
        }
    }

    // Decided on what was RESOLVED, never on what was merely requested.
    const hasScope =
        scope.siteIds.length > 0 ||
        scope.departmentIds.length > 0 ||
        scope.serviceIds.length > 0 ||
        (Array.isArray(scope.employeeIds) && scope.employeeIds.length > 0);

    if (!hasScope) {
        // A restricted user with nothing resolved must see NOTHING. Empty arrays
        // mean "no filter" downstream, so force an impossible id instead.
        scope.siteIds.push(-1);
        scope.departmentIds.push(-1);
        scope.serviceIds.push(-1);
        scope.employeeIds = [-1];
    }

    req.scope = scope;
    next();
};

module.exports = {
    denyScope,
    parseStrictId,
    checkEmployeeAccess,
    checkEmployeeReadAccess,
    checkSiteAccess,
    checkDepartmentAccess,
    checkServiceAccess,
    rbacMiddleware,
};
