const BaseModel = require('./BaseModel');
const db = require('../config/database');

// THE "nobody reviews this person" rule — shared with SetupController and
// GovernanceService so the three surfaces count the same people.
const { missingReviewerSql } = require('../utils/reviewerGapSql');

/**
 * Roster sort whitelist: the ONLY expressions ?sort= can reach.
 * Keys are what the URL carries; values are the joined-table columns.
 */
const SORT_COLUMNS = {
    employeeNumber: 'e.employeeNumber',
    lastName: 'e.lastName',
    role: 'r.name',
    site: 's.name',
    department: 'd.name',
    service: 'sv.name',
    // the roster's account columns are sortable too.
    // Sorts on what the column SHOWS: the effective line (see findPageWithOrg).
    supervisor: 'lineName',
    lastLogin: 'e.lastLoginAt',
};

/**
 * Search clause shared by the two roster queries: every token of
 * the term must appear in the full name, OR the whole term matches the employee
 * number, the e-mail, or the USERNAME — the identifier a helpdesk ticket names
 * ("my login is X, unlock me"), which used to find nobody.
 */
function searchClause(term, params) {
    const { ilike } = require('../utils/searchSql');
    const raw = String(term).trim();
    const tokens = raw.split(/\s+/).filter(Boolean).slice(0, 6);
    const nameExpr = `(e.firstName || ' ' || e.lastName)`;
    const nameClause = tokens.map(() => ilike(nameExpr)).join(' AND ') || ilike(nameExpr);
    if (tokens.length) tokens.forEach((t) => params.push(`%${t}%`));
    else params.push(`%${raw}%`);
    params.push(`%${raw}%`, `%${raw}%`, `%${raw}%`);
    return `((${nameClause}) OR e.employeeNumber ILIKE ? OR e.email ILIKE ? OR e.username ILIKE ?)`;
}

class EmployeeModel extends BaseModel {
    constructor() {
        super('employees');
    }

    /**
     * True when this employee governs at least one active person — as a direct
     * SUPERVISOR or as an employee-typed MANAGER. This is the login-time
     * "is a manager" test: being a manager via `manager_id` counts, not only via
     * `supervisor_id` (the old findSubordinates check missed pure managers, so
     * they logged in as plain employees and were 403'd from the review console).
     * A single indexed existence check — cheap enough for per-request deserialize.
     */
    async governsAnyone(employeeId) {
        const r = await db.get(
            `SELECT 1 AS yes FROM employees
              WHERE is_active AND (supervisor_id = ? OR (manager_id = ? AND manager_type = 'employee'))
              LIMIT 1`,
            [employeeId, employeeId]
        );
        return Boolean(r);
    }

    /**
     * The two governance lines, resolved in ONE query so a per-request call
     * costs no more than `governsAnyone` did.
     *
     * They are NOT the same role, and the workflow treats them differently:
     * a SUPERVISOR (governs via `supervisor_id`) satisfies `canSupervise` —
     * opening a review and requesting changes; a MANAGER (governs via
     * `manager_id` + `manager_type='employee'`) additionally satisfies
     * `canManage` — manager validation and dispute arbitration, which a pure
     * supervisor is excluded from. Collapsing the two into one "manager" bucket
     * is what made the user guide promise supervisors capabilities they do not
     * have, so the clearance resolver needs both flags.
     */
    async governanceOf(employeeId) {
        const r = await db.get(
            `SELECT
                 bool_or(supervisor_id = ?) AS supervises,
                 bool_or(manager_id = ? AND manager_type = 'employee') AS manages
               FROM employees
              WHERE is_active AND (supervisor_id = ? OR (manager_id = ? AND manager_type = 'employee'))`,
            [employeeId, employeeId, employeeId, employeeId]
        );
        const supervises = Boolean(r && r.supervises);
        const manages = Boolean(r && r.manages);
        return { supervises, manages, governs: supervises || manages };
    }

    async findWithOrganization(conditions = {}) {
        let sql = `
            SELECT e.*, 
                   s.name as siteName, 
                   d.name as departmentName, 
                   sv.name as serviceName,
                   r.name as roleName
            FROM employees e
            INNER JOIN sites s ON e.siteId = s.id
            INNER JOIN departments d ON e.departmentId = d.id
            INNER JOIN services sv ON e.serviceId = sv.id
            INNER JOIN roles r ON e.roleId = r.id
        `;
        const params = [];
        const conditionsList = [];

        if (Object.keys(conditions).length > 0) {
            Object.keys(conditions).forEach((key) => {
                conditionsList.push(`e.${key} = ?`);
                params.push(conditions[key]);
            });
            sql += ` WHERE ${conditionsList.join(' AND ')}`;
        }

        sql += ` ORDER BY s.name, e.lastName, e.firstName`;

        return await db.all(sql, params);
    }

    /**
     * ACTIVE STAFF BY DEFAULT. This is the population behind
     * RBACService.getFilteredEmployees, i.e. behind the readiness report, the
     * Power BI feed, the skill matrix, the org chart and every scope check —
     * while every dashboard reads v_employee_details WHERE is_active. With no
     * default the two disagreed: dashboard 77, readiness report 78, the erased
     * subject "Erased 68963" listed as regular staff on /reports/readiness
     * (reproduced: getFilteredEmployees(super).length 78 vs 77 active). The
     * manager branch (findGoverned) already filtered is_active, so admins were
     * the only callers still seeing leavers — an accident, not a design.
     *
     * Opt-out for the surfaces that legitimately list leavers (data-management
     * exports, the audit trail): pass `isActive: null` (or `includeInactive:
     * true`) to get the whole population; `isActive: false` lists leavers only.
     */
    async findByScopesAndFilters(scopes = null, filters = {}) {
        filters = { ...(filters || {}) };
        if (filters.includeInactive === true) filters.isActive = null;
        else if (filters.isActive === undefined) filters.isActive = true;
        delete filters.includeInactive;
        let sql = `
            SELECT e.*, 
                   s.name as siteName, 
                   d.name as departmentName, 
                   sv.name as serviceName,
                   r.name as roleName
            FROM employees e
            INNER JOIN sites s ON e.siteId = s.id
            INNER JOIN departments d ON e.departmentId = d.id
            INNER JOIN services sv ON e.serviceId = sv.id
            INNER JOIN roles r ON e.roleId = r.id
        `;

        const conditions = [];
        const params = [];

        // 1. Handle Scopes (if not null)
        // scopes = null implies "All Access" (SuperAdmin)
        // scopes = [] implies "No Access" (handled by caller typically, but safe to handle here)
        if (scopes !== null) {
            if (scopes.length === 0) {
                return []; // No access
            }

            const scopeConditions = [];
            scopes.forEach((scope) => {
                if (scope.scopeType === 'site') {
                    scopeConditions.push('e.siteId = ?');
                    params.push(scope.siteId);
                } else if (scope.scopeType === 'department') {
                    scopeConditions.push('e.departmentId = ?');
                    params.push(scope.departmentId);
                } else if (scope.scopeType === 'service') {
                    scopeConditions.push('e.serviceId = ?');
                    params.push(scope.serviceId);
                } else if (scope.scopeType === 'country') {
                    // country scope → any employee whose site is in that country
                    scopeConditions.push('s.countryId = ?');
                    params.push(scope.countryId);
                } else if (scope.scopeType === 'region') {
                    // region scope → every country in the region, and their sites.
                    // This branch was MISSING, which is what made the whole block
                    // fail open (see the fail-closed guard below).
                    scopeConditions.push(
                        's.countryId IN (SELECT id FROM countries WHERE regionId = ?)'
                    );
                    params.push(scope.regionId);
                }
            });

            // FAIL CLOSED. Previously, if no branch matched — a region scope, or any
            // scope type added to the schema later — `scopeConditions` stayed empty,
            // no condition was appended, and the query returned EVERY employee in the
            // organisation. Measured: a region-scoped admin saw all 77 of 77 active
            // employees. An authority row the code does not understand must grant
            // NOTHING, never everything.
            if (scopeConditions.length > 0) {
                conditions.push(`(${scopeConditions.join(' OR ')})`);
            } else {
                return [];
            }
        }

        // 2. Handle Search — NAME-focused, case-insensitive, token-based.
        //    Every whitespace-separated word must appear somewhere in the full
        //    name (any order), so "clara novak", "novak clara" and partials
        //    all match "Clara Beatrice NOVAK", incl. middle names. Employee
        //    number / email match the whole term as a fallback. ILIKE = case-insensitive.
        if (filters.search) conditions.push(searchClause(filters.search, params));

        // 3. Handle specific field filters
        const exactFilters = ['roleId', 'siteId', 'departmentId', 'serviceId', 'isActive'];
        exactFilters.forEach((key) => {
            if (filters[key] !== undefined && filters[key] !== null && filters[key] !== '') {
                conditions.push(`e.${key} = ?`);
                params.push(filters[key]);
            }
        });

        if (conditions.length > 0) {
            sql += ` WHERE ${conditions.join(' AND ')}`;
        }

        sql += ` ORDER BY s.name, e.lastName, e.firstName`;

        return await db.all(sql, params);
    }

    /**
     * Scope-aware, DB-paginated employee list for the roster page. Instead of
     * loading every governed employee into memory and slicing (which loaded
     * thousands of rows to show 20 at 4000-user scale), this pushes the scope
     * filter + search + LIMIT/OFFSET into SQL and returns { rows, total } via a
     * single windowed COUNT.
     *
     * @param {object} opts
     * @param {Array|null} opts.scopes  local-admin scope rows, or null = all (superadmin)
     * @param {number[]|null} opts.employeeIds  explicit id allow-list (managers' sub-tree)
     * @param {object} opts.filters {search, roleId, isActive, …}
     * @param {number} opts.limit
     * @param {number} opts.offset
     * @param {string} [opts.orderBy]  a SORT_COLUMNS key (or `key:desc`); anything
     *        else falls back to the default site-grouped order — never raw SQL.
     */
    async findPageWithOrg({
        scopes = null,
        employeeIds = null,
        // Admin line authority: the people this admin account is DIRECTLY named
        // manager of, visible even outside the admin's org scopes (the SA-review
        // console already lists and authorises them — the two must agree).
        alsoEmployeeIds = null,
        filters = {},
        limit = 20,
        offset = 0,
        orderBy = null,
    }) {
        const conditions = [];
        const params = [];
        const also = Array.isArray(alsoEmployeeIds)
            ? alsoEmployeeIds.map(Number).filter(Boolean)
            : [];

        if (Array.isArray(employeeIds)) {
            if (!employeeIds.length) return { rows: [], total: 0 };
            conditions.push('e.id = ANY(?)');
            params.push(employeeIds.map(Number));
        } else if (scopes !== null) {
            if (!scopes.length && !also.length) return { rows: [], total: 0 };
            const sc = [];
            scopes.forEach((scope) => {
                if (scope.scopeType === 'site') {
                    sc.push('e.siteId = ?');
                    params.push(scope.siteId);
                } else if (scope.scopeType === 'department') {
                    sc.push('e.departmentId = ?');
                    params.push(scope.departmentId);
                } else if (scope.scopeType === 'service') {
                    sc.push('e.serviceId = ?');
                    params.push(scope.serviceId);
                } else if (scope.scopeType === 'country') {
                    sc.push('s.countryId = ?');
                    params.push(scope.countryId);
                } else if (scope.scopeType === 'region') {
                    sc.push('s.countryId IN (SELECT id FROM countries WHERE regionId = ?)');
                    params.push(scope.regionId);
                }
            });
            // FAIL CLOSED — the second instance of the same defect. This is the
            // PAGINATED list behind /employees, so an unmatched scope type here
            // showed a region-scoped admin the entire organisation on the very
            // first screen they open. No branch matched ⇒ no rows, never all rows.
            if (also.length) {
                sc.push('e.id = ANY(?)');
                params.push(also);
            }
            if (sc.length) conditions.push(`(${sc.join(' OR ')})`);
            else return { rows: [], total: 0 };
        }

        if (filters.search) conditions.push(searchClause(filters.search, params));
        // supervisorId: "everyone under X" — the site HR's crew list.
        ['roleId', 'siteId', 'departmentId', 'serviceId', 'supervisorId', 'isActive'].forEach(
            (key) => {
                if (filters[key] !== undefined && filters[key] !== null && filters[key] !== '') {
                    conditions.push(`e.${key} = ?`);
                    params.push(filters[key]);
                }
            }
        );
        // Governance gap: nobody reviews these people. Their self-assessments
        // reach no queue and they appear in no manager digest — surfaced as a
        // filter so the gap is fixable, not invisible.
        if (filters.missingReviewer) {
            // Responsibility falls through supervisor -> manager -> the local
            // admin whose scope covers the person, so "no supervisor" is NOT the
            // same as "nobody reviews them". Only those with no covering admin
            // scope either are genuinely orphaned; flagging the rest would send
            // an operator chasing reporting lines that are already covered.
            //
            // "No supervisor" means no ACTIVE, non-voided one — not merely a NULL
            // column. When a supervisor is processed as a leaver or their record
            // is voided, supervisor_id on their reports still points at them,
            // and those people were invisible on the one screen built to show
            // them (reproduced: 15 active people reporting to a deactivated
            // supervisor, worklist unchanged). Same rule for the manager line,
            // for either manager type. The rule lives in utils/reviewerGapSql
            // so the Setup checklist and the governance coverage counts can
            // never drift from this worklist again.
            conditions.push(missingReviewerSql('e'));
        }

        const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
        // Shared FROM/WHERE for the page query and the count query. The total is a
        // SEPARATE COUNT(*) rather than a `COUNT(*) OVER AS _total` window column:
        // the camelCase↔snake result translator rewrites an `_total` alias to `Total`,
        // so reading `_total` gave undefined → NaN → totalPages NaN → the pagination
        // controls never rendered (every page past the first was unreachable). A plain
        // `AS cnt` alias round-trips cleanly.
        const baseFrom = `FROM employees e
             INNER JOIN sites s ON e.siteId = s.id
             INNER JOIN departments d ON e.departmentId = d.id
             INNER JOIN services sv ON e.serviceId = sv.id
             INNER JOIN roles r ON e.roleId = r.id`;
        const fromWhere = `${baseFrom}${where}`;
        // 3.23.18: the roster's "supervisor" column shows the EFFECTIVE
        // reporting line — the live supervisor, else the live manager (employee
        // or admin, labelled) — the rule GovernanceService states once. It used
        // to print supervisor_id alone, so a person reporting to a manager read
        // "—" as if nobody governed them. LEFT JOINs only: no row is added or lost.
        const { reportingLineCandidatesSql } = require('../services/GovernanceService');
        const lineJoins = `
             LEFT JOIN LATERAL (
                 SELECT c.prio, c.kind, c.id FROM (${reportingLineCandidatesSql('e')}) c
                  ORDER BY c.prio LIMIT 1
             ) ln ON true
             LEFT JOIN employees lne ON ln.kind = 'employee' AND lne.id = ln.id
             LEFT JOIN admins lna ON ln.kind = 'admin' AND lna.id = ln.id
             LEFT JOIN employees lnae ON lnae.id = lna.linked_employee_id`;
        // Server-side sort: the key is resolved against SORT_COLUMNS here,
        // so the controller's ?sort= can only ever reach SQL as one of these
        // expressions. Name/first name are the stable tiebreak for paging.
        const [sortKey, sortDir] = String(orderBy || '').split(':');
        const sortExpr = SORT_COLUMNS[sortKey];
        const dir = String(sortDir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
        const orderSql = sortExpr
            ? `${sortExpr} ${dir}, e.lastName, e.firstName`
            : 'e.lastName, e.firstName';
        const rows = await db.all(
            `SELECT e.*, s.name AS siteName, d.name AS departmentName, sv.name AS serviceName,
                    r.name AS roleName,
                    (SELECT sup.firstName || ' ' || sup.lastName FROM employees sup WHERE sup.id = e.supervisorId) AS supervisorName,
                    CASE WHEN ln.prio = 10 THEN 'supervisor' WHEN ln.prio = 20 THEN 'manager'
                         WHEN ln.prio = 30 THEN 'admin' END AS lineKind,
                    CASE WHEN ln.kind = 'admin'
                         THEN COALESCE(NULLIF(TRIM(COALESCE(lnae.first_name, '') || ' ' || COALESCE(lnae.last_name, '')), ''), lna.username::text)
                         ELSE NULLIF(TRIM(COALESCE(lne.first_name, '') || ' ' || COALESCE(lne.last_name, '')), '') END AS lineName
             ${baseFrom}${lineJoins}${where}
             ORDER BY ${sortExpr ? orderSql : `s.name, ${orderSql}`}
             LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );
        const countRow = await db.get(`SELECT COUNT(*)::int AS cnt ${fromWhere}`, [...params]);
        const total = countRow ? Number(countRow.cnt) : 0;
        return { rows, total };
    }

    /** Sortable columns of the roster (key → SQL expression). Whitelist — see findPageWithOrg. */
    get SORT_COLUMNS() {
        return SORT_COLUMNS;
    }

    /**
     * Account state of a set of people, computed in ONE query with the same
     * rules as the Accounts console:
     *   locked        ≥ maxAttempts failed logins in the lockout window
     *   disabled      a password exists but the login was switched off
     *   sso           no local password, an SSO identity resolves the person
     *   none          no local password and no identity
     *   active        signed in at least once (local or SSO — last_login_at)
     *   never_invited credentials exist, nobody ever invited, never signed in
     *   expired       invited, never used, older than the expiry policy
     *   stale         invited, never used, older than STALE days
     *   pending       invited recently, never used
     * `kind` says HOW the person can sign in (local / sso / both / none).
     * Returns a Map id → row. Read-only; used by the roster and the console.
     */
    async accountStates(ids, policy = {}) {
        const out = new Map();
        const list = (ids || []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
        if (!list.length) return out;
        const { sql, params, lockoutMinutes } = this.accountStateSql(
            'e.id = ANY(?)',
            [list],
            policy
        );
        const rows = await db.all(`SELECT a.* FROM (${sql}) a`, params);
        for (const r of rows) out.set(Number(r.id), this.decorateAccountRow(r, lockoutMinutes));
        return out;
    }

    /**
     * The ONE SQL that classifies an account (shared by accountStates and the
     * Accounts console, so the roster chip and the console can never disagree).
     * Returns a SELECT (alias `a`-ready) with columns: the employee's account
     * fields + has_password / account_active / has_sso / failed_attempts /
     * last_failed_at + `state` + `kind`. `innerWhere` filters employees (use
     * alias `e`), its placeholders first in `innerParams`.
     */
    accountStateSql(
        innerWhere,
        innerParams,
        { maxAttempts = 5, lockoutMinutes = 30, expiryDays = 14, staleDays = 7 } = {}
    ) {
        const sql = `
            SELECT a.*,
                   CASE
                       WHEN a.failed_attempts >= ? THEN 'locked'
                       WHEN a.has_password AND NOT a.account_active THEN 'disabled'
                       WHEN NOT a.has_password AND a.has_sso THEN 'sso'
                       WHEN NOT a.has_password THEN 'none'
                       WHEN a.last_login_at IS NOT NULL THEN 'active'
                       WHEN a.invited_at IS NULL THEN 'never_invited'
                       WHEN ? > 0 AND a.invited_at < now() - (? * interval '1 day') THEN 'expired'
                       WHEN a.invited_at < now() - (? * interval '1 day') THEN 'stale'
                       ELSE 'pending'
                   END AS state,
                   CASE
                       WHEN a.has_password AND a.has_sso THEN 'both'
                       WHEN a.has_password THEN 'local'
                       WHEN a.has_sso THEN 'sso'
                       ELSE 'none'
                   END AS kind
              FROM (
                SELECT e.id, e.employee_number, e.first_name, e.last_name, e.username, e.email,
                       e.site_id, e.department_id, e.service_id, e.role_id, e.supervisor_id, e.created_at,
                       e.password_hash IS NOT NULL AS has_password,
                       COALESCE(e.is_account_active, false) AS account_active,
                       e.last_login_at, e.invited_at, e.invited_by, e.auth_policy, e.password_disabled,
                       e.force_password_change,
                       (e.external_id IS NOT NULL OR EXISTS (
                           SELECT 1 FROM user_identities ui
                            WHERE ui.subject_type = 'employee' AND ui.subject_id = e.id)) AS has_sso,
                       -- Failures that COUNT TOWARDS THE LOCK: in the window AND after
                       -- the last success/reset of that identifier. login_attempts is
                       -- append-only (migration 134): a success no longer deletes the
                       -- failures before it, so the boundary is what lifts the lock here.
                       (SELECT COUNT(*)::int FROM login_attempts la
                         WHERE la.successful = false
                           AND la.attempted_at > now() - (? * interval '1 minute')
                           AND la.attempted_at > COALESCE((SELECT MAX(l2.attempted_at) FROM login_attempts l2
                                                            WHERE l2.username = la.username
                                                              AND (l2.successful = true OR l2.kind = 'reset')), '-infinity'::timestamptz)
                           AND (la.username = e.username OR (e.email IS NOT NULL AND e.email <> '' AND la.username = e.email))) AS failed_attempts,
                       (SELECT MAX(la.attempted_at) FROM login_attempts la
                         WHERE la.successful = false
                           AND la.attempted_at > now() - (? * interval '1 minute')
                           AND la.attempted_at > COALESCE((SELECT MAX(l2.attempted_at) FROM login_attempts l2
                                                            WHERE l2.username = la.username
                                                              AND (l2.successful = true OR l2.kind = 'reset')), '-infinity'::timestamptz)
                           AND (la.username = e.username OR (e.email IS NOT NULL AND e.email <> '' AND la.username = e.email))) AS last_failed_at
                  FROM employees e
                 WHERE ${innerWhere}
              ) a`;
        return {
            sql,
            params: [
                maxAttempts,
                expiryDays,
                expiryDays,
                staleDays,
                lockoutMinutes,
                lockoutMinutes,
                ...(innerParams || []),
            ],
            lockoutMinutes,
        };
    }

    /**
     * Distinct ACTIVE supervisors of the visible population for
     * the roster's "Superviseur" filter — bounded by the same scope as the list.
     */
    async supervisorOptions({ scopes = null, employeeIds = null } = {}) {
        const conditions = ['e.is_active', 'sup.is_active'];
        const params = [];
        if (Array.isArray(employeeIds)) {
            if (!employeeIds.length) return [];
            conditions.push('e.id = ANY(?)');
            params.push(employeeIds.map(Number));
        } else if (scopes !== null) {
            if (!scopes.length) return [];
            const sc = [];
            scopes.forEach((scope) => {
                if (scope.scopeType === 'site') {
                    sc.push('e.site_id = ?');
                    params.push(scope.siteId);
                } else if (scope.scopeType === 'department') {
                    sc.push('e.department_id = ?');
                    params.push(scope.departmentId);
                } else if (scope.scopeType === 'service') {
                    sc.push('e.service_id = ?');
                    params.push(scope.serviceId);
                } else if (scope.scopeType === 'country') {
                    sc.push('s.country_id = ?');
                    params.push(scope.countryId);
                } else if (scope.scopeType === 'region') {
                    sc.push('s.country_id IN (SELECT id FROM countries WHERE region_id = ?)');
                    params.push(scope.regionId);
                }
            });
            if (!sc.length) return []; // fail closed, like findPageWithOrg
            conditions.push(`(${sc.join(' OR ')})`);
        }
        return db.all(
            `SELECT DISTINCT sup.id, sup.first_name, sup.last_name, sup.employee_number
               FROM employees e
               JOIN employees sup ON sup.id = e.supervisor_id
               JOIN sites s ON s.id = e.site_id
              WHERE ${conditions.join(' AND ')}
              ORDER BY sup.last_name, sup.first_name`,
            params
        );
    }

    /** lockedUntil (last failure + lockout window) and noEmail on a classified row. */
    decorateAccountRow(r, lockoutMinutes = 30) {
        const lockedUntil =
            r.state === 'locked' && r.lastFailedAt
                ? new Date(new Date(r.lastFailedAt).getTime() + lockoutMinutes * 60000)
                : null;
        return { ...r, lockedUntil, noEmail: !r.email };
    }

    /**
     * Campaign state of a set of people in the running campaign(s), read from
     * the roster view. Read-only: v_cycle_participant_status is
     * the contract; nothing here writes to cycles. Map id → { cycleId,
     * cycleCode, state } for the most recent open/locked campaign only.
     */
    async campaignStates(ids) {
        const out = new Map();
        const list = (ids || []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
        if (!list.length) return out;
        const rows = await db
            .all(
                `SELECT DISTINCT ON (v.employee_id)
                    v.employee_id, v.cycle_id, c.code AS cycle_code, v.participant_state
               FROM v_cycle_participant_status v
               JOIN assessment_cycles c ON c.id = v.cycle_id
              WHERE c.status IN ('open', 'locked') AND v.employee_id = ANY(?)
              ORDER BY v.employee_id, c.opened_at DESC NULLS LAST, c.id DESC`,
                [list]
            )
            .catch(() => []);
        for (const r of rows) {
            out.set(Number(r.employeeId), {
                cycleId: Number(r.cycleId),
                cycleCode: r.cycleCode,
                state: r.participantState,
            });
        }
        return out;
    }

    async findByIdWithOrganization(id) {
        const result = await db.get(
            `
            SELECT e.*, 
                   s.name as siteName, 
                   d.name as departmentName, 
                   sv.name as serviceName,
                   r.name as roleName
            FROM employees e
            INNER JOIN sites s ON e.siteId = s.id
            INNER JOIN departments d ON e.departmentId = d.id
            INNER JOIN services sv ON e.serviceId = sv.id
            INNER JOIN roles r ON e.roleId = r.id
            WHERE e.id = ?
        `,
            [id]
        );

        return result;
    }

    async findByEmployeeNumber(employeeNumber) {
        return await this.findOne({ employeeNumber });
    }

    async findByEmail(email) {
        if (!email || email.trim() === '') {
            return null;
        }
        return await this.findOne({ email: email.trim() });
    }

    async findByUsername(username) {
        if (!username || username.trim() === '') {
            return null;
        }
        return await this.findOne({ username: username.trim() });
    }

    // 3.23.18: `findSubordinates` (supervisor_id ONLY, direct reports) was
    // removed — no caller anywhere in src, views, public, scripts or tests, and
    // its supervisor-only reading is exactly the defect other surfaces were
    // fixed for. Direct reports are `supervisor_id = X OR (manager_id = X AND
    // manager_type = 'employee')`; the sub-tree is findGovernedIds.

    /**
     * The site / department / service ids a set of people are placed in — so a
     * scope expressed as org-unit lists can carry people added by the
     * reporting line (middleware/rbac.js). Empty input → empty lists.
     */
    async orgUnitsOf(employeeIds) {
        const ids = [...new Set((employeeIds || []).map(Number))].filter(
            (n) => Number.isInteger(n) && n > 0
        );
        if (!ids.length) return { siteIds: [], departmentIds: [], serviceIds: [] };
        const rows = await db.all(
            `SELECT DISTINCT site_id AS "siteId", department_id AS "departmentId", service_id AS "serviceId"
               FROM employees WHERE id = ANY(?)`,
            [ids]
        );
        const col = (k) => [
            ...new Set(rows.map((r) => Number(r[k])).filter((n) => Number.isInteger(n) && n > 0)),
        ];
        return {
            siteIds: col('siteId'),
            departmentIds: col('departmentId'),
            serviceIds: col('serviceId'),
        };
    }

    /**
     * Does `managerId` govern `employeeId` anywhere in their reporting sub-tree?
     *
     * THE authority question for a manager or supervisor, and the single answer to
     * it. The list surfaces (9-box grid, IDP console, coaching list) have always
     * used the sub-tree, while the per-object guards beside them tested only the
     * DIRECT link — so an N+2 manager saw names and placements in a list and was
     * refused with 403 the moment they opened one. Over-disclosure in the list and
     * a dead end in the workflow, from the same screen.
     *
     * The sub-tree is the hierarchy, which is what a manager's authority rests on,
     * so the guards resolve to this. Self is excluded: nobody governs themselves.
     */
    async governs(managerId, employeeId) {
        const mid = Number(managerId);
        const eid = Number(employeeId);
        if (!Number.isFinite(mid) || !Number.isFinite(eid) || mid === eid) return false;
        const ids = await this.findGovernedIds(mid);
        return ids.some((id) => Number(id) === eid);
    }

    // All employee ids in a manager's reporting sub-tree (reports, reports-of-
    // reports, …) via either reporting relationship. Iterative BFS — cycle-safe.
    async findGovernedIds(managerId) {
        const all = new Set();
        let frontier = [Number(managerId)];
        while (frontier.length) {
            // `= ANY(?)` with ONE array parameter instead of an N-placeholder
            // IN-list. This runs on every authenticated request for every
            // manager/employee (middleware/rbac.js), and the level-1 frontier of
            // a senior manager can be thousands of ids: the IN-list form built a
            // different SQL string — and therefore a fresh parse, a fresh
            // translation and 2N bind parameters — on every single request.
            // The template is now constant, so the driver's translation memo
            // hits and PostgreSQL can plan it once. Same rows, same order of
            // discovery, same cycle safety.
            // `manager_type = 'employee'` is NOT optional. `manager_id` is
            // polymorphic — it points at an EMPLOYEE or at an ADMIN, and the two
            // id spaces overlap (employees 84..68963, admins 1..666). Without the
            // discriminator, an employee managed by admin #33 is returned as
            // governed by EMPLOYEE #33, who may be an unrelated person: they then
            // see that employee's record everywhere this function feeds, which is
            // every authenticated request through middleware/rbac.js.
            // `governsAnyone` (:58) and `governanceOf` (:82) have always filtered
            // it; this one did not, so the three disagreed about who governs whom.
            const rows = await db.all(
                `SELECT id FROM employees
                 WHERE (supervisor_id = ANY(?) OR (manager_id = ANY(?) AND manager_type = 'employee'))
                   AND is_active`,
                [frontier, frontier]
            );
            const next = [];
            for (const r of rows) {
                const id = Number(r.id);
                if (!all.has(id)) {
                    all.add(id);
                    next.push(id);
                }
            }
            frontier = next;
        }
        return [...all];
    }

    // Org-enriched rows for everyone a manager governs (full sub-tree).
    async findGoverned(managerId) {
        const ids = await this.findGovernedIds(managerId);
        if (!ids.length) return [];
        const ph = ids.map(() => '?').join(',');
        return await db.all(
            `
            SELECT e.*,
                   s.name as siteName,
                   d.name as departmentName,
                   sv.name as serviceName,
                   r.name as roleName
            FROM employees e
            INNER JOIN sites s ON e.siteId = s.id
            INNER JOIN departments d ON e.departmentId = d.id
            INNER JOIN services sv ON e.serviceId = sv.id
            INNER JOIN roles r ON e.roleId = r.id
            WHERE e.id IN (${ph}) AND e.isActive = 1
            ORDER BY e.lastName, e.firstName
        `,
            ids
        );
    }

    /**
     * @deprecated 3.23.18 — NO PRODUCT CALLER. Kept only because a
     * regression test
     * still calls it. It walks `supervisor_id` ONLY and ignores the manager
     * line, so it is NOT the reporting line: do not build on it. The line is
     * supervisor, else manager (GovernanceService.reportingLineCandidatesSql).
     */
    async getSupervisorChain(employeeId) {
        const chain = [];
        let currentId = employeeId;
        // Cycle-safe. Only self-reference was guarded by the schema, so an
        // A→B→A reporting loop was writable (reproduced: both UPDATEs succeed)
        // and this walk never terminated on it (aborted after 40 hops on a
        // 2-node cycle). A visited set ends the walk at the first repeat.
        const seen = new Set([Number(employeeId)]);

        while (currentId) {
            const employee = await this.findById(currentId);
            if (!employee || !employee.supervisorId) break;
            if (seen.has(Number(employee.supervisorId))) break;

            const supervisor = await this.findByIdWithOrganization(employee.supervisorId);
            if (!supervisor) break;

            chain.push(supervisor);
            seen.add(Number(supervisor.id));
            currentId = supervisor.id;
        }

        return chain;
    }

    /**
     * Would making `candidateId` the supervisor or (employee-typed) manager of
     * `employeeId` close a reporting loop? True when the candidate already sits
     * anywhere in the employee's governed sub-tree — i.e. the employee is an
     * ancestor of the candidate — or is the employee themselves. Both reporting
     * relationships count, exactly as findGovernedIds walks them, so a loop
     * through manager_id is refused as firmly as one through supervisor_id.
     */
    async wouldCreateReportingCycle(employeeId, candidateId) {
        const eid = Number(employeeId);
        const cid = Number(candidateId);
        if (!Number.isFinite(eid) || !Number.isFinite(cid)) return false;
        if (eid === cid) return true;
        return this.governs(eid, cid);
    }

    /**
     * A reactivation must never resurrect an ERASED subject (DSRService.erase,
     * erased_at) or a VOIDED record (MaintenanceService.voidEmployee,
     * cancelled_at). This is the generic write path the SuperAdmin
     * "reactivate" toggle and any future caller go through, so the refusal
     * lives here rather than in each screen. Only a write that turns is_active /
     * is_account_active ON is inspected; every other update is untouched.
     */
    async update(id, data) {
        const turnsOn = (v) => v === true || v === 1 || v === '1' || v === 'true';
        if (data && (turnsOn(data.isActive) || turnsOn(data.isAccountActive))) {
            const row = await db.get('SELECT cancelled_at, erased_at FROM employees WHERE id = ?', [
                id,
            ]);
            if (row && row.erasedAt) {
                const e = new Error('erased_record_cannot_be_reinstated');
                e.status = 409;
                e.code = 'erased_record_cannot_be_reinstated';
                throw e;
            }
            if (row && row.cancelledAt && turnsOn(data.isActive)) {
                const e = new Error('void_record_cannot_be_reinstated');
                e.status = 409;
                e.code = 'void_record_cannot_be_reinstated';
                throw e;
            }
        }
        return super.update(id, data);
    }

    validate(data) {
        const errors = [];

        if (!data.firstName || data.firstName.trim() === '') {
            errors.push('First name is required');
        }

        if (!data.lastName || data.lastName.trim() === '') {
            errors.push('Last name is required');
        }

        if (!data.siteId) {
            errors.push('Site is required');
        }

        if (!data.departmentId) {
            errors.push('Department is required');
        }

        if (!data.serviceId) {
            errors.push('Service is required');
        }

        if (!data.roleId) {
            errors.push('Role is required');
        }

        return errors;
    }
}

module.exports = new EmployeeModel();
