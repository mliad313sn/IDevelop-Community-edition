'use strict';

/**
 * InvitationController — the **Comptes / Accounts** console (;
 * evolved from the bulk-invitation console of 3.22.36 — the route names of that
 * console keep working).
 *
 *   GET  /admin/accounts                 ONE list of every active employee in the
 *                                        caller's scope with an account STATE
 *                                        (never_invited / pending / stale / expired /
 *                                        active / locked / disabled / sso / none),
 *                                        sign-in KIND (local / sso / both), last
 *                                        login (SSO included), lock state ("locked
 *                                        until"), filters site / department / state /
 *                                        search (username too), sort, paging, CSV.
 *   POST /admin/accounts/bulk            { action, employeeIds } — unlock | resend |
 *                                        reset | disable | enable | policy, for one
 *                                        row or a selection (≤ 500), scope-checked
 *                                        per id. Credentials that could not be
 *                                        e-mailed (no address / SMTP off) come back
 *                                        ONCE for the one-time credentials sheet.
 *   GET  /admin/accounts/export.csv      the list as shown (filters honoured), BOM.
 *   POST /admin/accounts/requests/:id/decline   close a manager's request without acting.
 *   GET  /admin/invitations              → redirect to /admin/accounts (bookmarks).
 *   POST /admin/invitations/send         legacy bulk invite (kept; = bulk resend).
 *   POST /admin/invitations/:id/email    inline e-mail fix-up, validated + audited.
 *   GET  /admin/invitations/:id/preview  the welcome e-mail as it will render.
 *
 * ACCESS: any admin holding `reset_employee_password` (which now implies
 * view_employees — ) for THEIR scope; SuperAdmin implicitly. Every JSON
 * reply carries a stable `code` AND the sentence in the caller's language.
 */

const db = require('../config/database');
const LogService = require('../services/LogService');
const EmployeeModel = require('../models/EmployeeModel');
const RBACService = require('../services/RBACService');
const { scopedEmployeeIds } = require('../utils/rbacScope');
const { parsePage, buildPager, sortClause, sortLinks, csvResponse } = require('../utils/listTools');
const { personNameOf } = require('../utils/personName');

const STALE_DAYS = 7; // invited this long ago with no login = "stale" chip
const STATES = [
    'never_invited',
    'pending',
    'stale',
    'expired',
    'active',
    'locked',
    'disabled',
    'sso',
    'none',
];
// Extra filters that are not a single state: a cross-cutting flag.
// 3.23.20 (C3g): SSO migration filters — migrated, invited but not yet signed in
// by SSO, and no e-mail address (a printed notice to hand over).
const FLAG_FILTERS = [
    'no_email',
    'never_logged',
    'dormant',
    'sso_migrated',
    'sso_invited_not_signed',
    'sso_notice_due',
];
const SSO_INVITED = "('sent', 'reminded', 'inapp_only', 'skipped_no_email')";
const SSO_SQL = {
    migrated: `EXISTS (SELECT 1 FROM sso_migration_invites si WHERE si.subject_type = 'employee' AND si.subject_id = x.id AND si.status NOT IN ('cancelled', 'skipped_superadmin'))`,
    invited: `EXISTS (SELECT 1 FROM sso_migration_invites si WHERE si.subject_type = 'employee' AND si.subject_id = x.id AND si.status IN ${SSO_INVITED})`,
    signed: `EXISTS (SELECT 1 FROM user_identities ui WHERE ui.subject_type = 'employee' AND ui.subject_id = x.id AND ui.last_used_at IS NOT NULL)`,
    noticeDue: `EXISTS (SELECT 1 FROM sso_migration_invites si WHERE si.subject_type = 'employee' AND si.subject_id = x.id AND si.status = 'skipped_no_email' AND si.handed_over_at IS NULL)`,
};
const PER_PAGE = [25, 50, 100, 200];
const SORT = {
    name: 'x.last_name',
    site: 'x.site_name',
    department: 'x.department_name',
    username: 'x.username',
    lastLogin: 'x.last_login_at',
    invited: 'x.invited_at',
    state: 'x.state',
};
const ACTIONS = [
    'unlock',
    'resend',
    'reset',
    'disable',
    'enable',
    'policy',
    'sso_resend',
    'sso_handed_over',
];
const POLICIES = ['any', 'sso_only', 'local_only', 'mfa_required'];

/**
 * The lockout policy the console DISPLAYS must be the one the login path
 * ENFORCES (rateLimiter.js reads these two env values; the `maxLoginAttempts`
 * App Setting is not wired there's item). Mirroring the env read keeps
 * "locked" on the console true to the login page.
 */
function lockoutPolicy() {
    return {
        maxAttempts: parseInt(process.env.LOGIN_RATE_LIMIT, 10) || 5,
        lockoutMinutes: parseInt(process.env.LOGIN_LOCKOUT_DURATION, 10) || 30,
    };
}

function tr(req, key, params) {
    return req.t ? req.t(key, { defaultValue: key, ...(params || {}) }) : key;
}

class InvitationController {
    async _expiryDays() {
        try {
            const AppSettingsModel = require('../models/AppSettingsModel');
            const v = Number(await AppSettingsModel.getValue('invitationExpiryDays', 14));
            return Number.isFinite(v) && v >= 0 ? v : 14;
        } catch {
            return 14;
        }
    }

    async _dormantDays() {
        const env = Number(process.env.DORMANT_ACCOUNT_DAYS) || 30;
        try {
            const AppSettingsModel = require('../models/AppSettingsModel');
            const v = Number(await AppSettingsModel.getValue('dormantAccountDays', env));
            return Number.isFinite(v) && v > 0 ? v : env;
        } catch {
            return env;
        }
    }

    /** Filters read from the query, validated. */
    _filters(req) {
        const q = String(req.query.q || req.query.search || '').trim();
        const state =
            STATES.includes(req.query.state) || FLAG_FILTERS.includes(req.query.state)
                ? req.query.state
                : '';
        return {
            siteId: parseInt(req.query.siteId, 10) || null,
            departmentId: parseInt(req.query.departmentId, 10) || null,
            state,
            q,
            requests: req.query.requests === '1',
        };
    }

    /**
     * The classified population for this caller: scope + site / department / q
     * in the INNER select, state / flag filters on the OUTER one (they need the
     * computed columns). Returns { fromSql, params } for `SELECT … FROM (…) x`.
     */
    async _population(user, filters, { expiryDays, dormantDays, policy }) {
        const ids = await scopedEmployeeIds(user);
        const inner = ['e.is_active = true', 'e.erased_at IS NULL', 'e.cancelled_at IS NULL'];
        const innerParams = [];
        if (ids !== null) {
            if (!ids.length) inner.push('1 = 0');
            else {
                inner.push('e.id = ANY(?)');
                innerParams.push(ids);
            }
        }
        if (filters.siteId) {
            inner.push('e.site_id = ?');
            innerParams.push(filters.siteId);
        }
        if (filters.departmentId) {
            inner.push('e.department_id = ?');
            innerParams.push(filters.departmentId);
        }
        if (filters.q) {
            inner.push(
                `((e.first_name || ' ' || e.last_name) ILIKE ? OR e.employee_number ILIKE ? OR e.username ILIKE ? OR e.email ILIKE ?)`
            );
            const like = `%${filters.q}%`;
            innerParams.push(like, like, like, like);
        }
        const { sql, params } = EmployeeModel.accountStateSql(inner.join(' AND '), innerParams, {
            ...policy,
            expiryDays,
            staleDays: STALE_DAYS,
        });
        const outer = [];
        if (STATES.includes(filters.state)) {
            outer.push('x.state = ?');
            params.push(filters.state);
        } else if (filters.state === 'no_email') outer.push(`(x.email IS NULL OR x.email = '')`);
        else if (filters.state === 'never_logged')
            outer.push('(x.has_password AND x.last_login_at IS NULL)');
        else if (filters.state === 'dormant') {
            outer.push(
                `(x.has_password AND x.account_active AND COALESCE(x.last_login_at, x.invited_at, x.created_at) < now() - (? * interval '1 day'))`
            );
            params.push(dormantDays);
        } else if (filters.state === 'sso_migrated') outer.push(SSO_SQL.migrated);
        else if (filters.state === 'sso_invited_not_signed')
            outer.push(`(${SSO_SQL.invited} AND NOT ${SSO_SQL.signed})`);
        else if (filters.state === 'sso_notice_due') outer.push(SSO_SQL.noticeDue);
        if (filters.requests) outer.push('x.open_request_kind IS NOT NULL');
        const fromSql = `
            FROM (
              SELECT a.*, s.name AS site_name, d.name AS department_name, r.name AS role_name,
                     inv.username AS invited_by_name,
                     ar.kind AS open_request_kind, ar.id AS open_request_id, ar.created_at AS open_request_at,
                     (SELECT rq.first_name || ' ' || rq.last_name FROM employees rq WHERE rq.id = ar.requested_by) AS open_request_by
                FROM (${sql}) a
                JOIN sites s ON s.id = a.site_id
                JOIN departments d ON d.id = a.department_id
                JOIN roles r ON r.id = a.role_id
                LEFT JOIN admins inv ON inv.id = a.invited_by
                LEFT JOIN LATERAL (
                    SELECT id, kind, created_at, requested_by FROM account_requests q
                     WHERE q.employee_id = a.id AND q.decided_at IS NULL
                     ORDER BY q.created_at DESC LIMIT 1) ar ON true
            ) x${outer.length ? ` WHERE ${outer.join(' AND ')}` : ''}`;
        return { fromSql, params, ids };
    }

    /** Headline counters over the scope (site / department honoured; state / search not). */
    async _counters(user, filters, ctx) {
        const { fromSql, params } = await this._population(
            user,
            { ...filters, state: '', q: '', requests: false },
            ctx
        );
        // Placeholders bind in TEXTUAL order: the dormant `?` sits in the SELECT
        // list, i.e. BEFORE the FROM. Counting through a CTE puts the population's
        // placeholders first again, so `dormantDays` cannot capture the scope array
        // (that shift made every /admin/accounts render fail with
        // "invalid input syntax for type double precision").
        const row = await db.get(
            `WITH pop AS (SELECT x.* ${fromSql})
             SELECT COUNT(*)::int AS total,
                    COUNT(*) FILTER (WHERE x.has_password AND x.last_login_at IS NULL)::int AS never_logged,
                    COUNT(*) FILTER (WHERE x.state = 'locked')::int AS locked,
                    COUNT(*) FILTER (WHERE x.email IS NULL OR x.email = '')::int AS no_email,
                    COUNT(*) FILTER (WHERE x.state = 'disabled')::int AS disabled,
                    COUNT(*) FILTER (WHERE x.state = 'expired')::int AS expired,
                    COUNT(*) FILTER (WHERE x.has_sso)::int AS sso,
                    COUNT(*) FILTER (WHERE x.state = 'none')::int AS none,
                    COUNT(*) FILTER (WHERE x.has_password AND x.account_active AND COALESCE(x.last_login_at, x.invited_at, x.created_at) < now() - (? * interval '1 day'))::int AS dormant,
                    COUNT(*) FILTER (WHERE x.open_request_kind IS NOT NULL)::int AS requests,
                    COUNT(*) FILTER (WHERE ${SSO_SQL.migrated})::int AS sso_migrated,
                    COUNT(*) FILTER (WHERE ${SSO_SQL.invited})::int AS sso_invited,
                    COUNT(*) FILTER (WHERE ${SSO_SQL.migrated} AND ${SSO_SQL.signed})::int AS sso_signed,
                    COUNT(*) FILTER (WHERE ${SSO_SQL.noticeDue})::int AS sso_notice_due
               FROM pop x`,
            [...params, ctx.dormantDays]
        );
        return row || {};
    }

    async page(req, res) {
        const filters = this._filters(req);
        const policy = lockoutPolicy();
        const ctx = {
            expiryDays: await this._expiryDays(),
            dormantDays: await this._dormantDays(),
            policy,
        };
        const { page, perPage, offset } = parsePage(req.query, {
            perPageOptions: PER_PAGE,
            defaultPerPage: 50,
        });
        const sort = sortClause(req.query, SORT, 'name');
        const { fromSql, params } = await this._population(req.user, filters, ctx);
        const total =
            Number(((await db.get(`SELECT COUNT(*)::int AS cnt ${fromSql}`, params)) || {}).cnt) ||
            0;
        const rows = await db.all(
            `SELECT x.* ${fromSql} ORDER BY ${sort.orderBy}, x.last_name, x.first_name LIMIT ? OFFSET ?`,
            [...params, perPage, offset]
        );
        const employees = rows.map((r) =>
            EmployeeModel.decorateAccountRow(r, policy.lockoutMinutes)
        );
        await this._attachSso(employees);
        const counters = await this._counters(req.user, filters, ctx);

        let emailEnabled = false;
        try {
            emailEnabled = await require('../services/EmailService').isEnabled();
        } catch {
            /* off */
        }
        const sites = await RBACService.getFilteredSites(req.user);
        let departments = await RBACService.getFilteredDepartments(req.user);
        if (filters.siteId)
            departments = departments.filter((d) => String(d.siteId) === String(filters.siteId));

        res.render('pages/admins/accounts', {
            title: tr(req, 'chrome:pt_accounts'),
            employees,
            counters,
            filters,
            sites,
            departments,
            states: STATES,
            flagFilters: FLAG_FILTERS,
            expiryDays: ctx.expiryDays,
            staleDays: STALE_DAYS,
            dormantDays: ctx.dormantDays,
            lockout: policy,
            emailEnabled,
            isSuperAdmin: RBACService.isSuperAdmin(req.user),
            canViewEmployees: RBACService.hasPermission(req.user, 'view_employees'),
            total,
            perPage,
            perPageOptions: PER_PAGE,
            pager: buildPager(req.query, { page, total, perPage, basePath: '/admin/accounts' }),
            sort,
            sortCols: sortLinks(req.query, SORT, sort, { basePath: '/admin/accounts' }),
        });
    }

    /**
     * 3.23.20 (C3g): the SSO migration state of each row — the latest
     * invitation (status, dates, printed-notice hand-over) and the last SSO
     * sign-in measured on the identity. Never blocks the page.
     */
    async _attachSso(employees) {
        const ids = employees.map((e) => Number(e.id));
        if (!ids.length) return;
        try {
            const inv = await require('../services/SsoInviteService').statusFor('employee', ids);
            const used = await db.all(
                `SELECT subject_id, MAX(last_used_at) AS at FROM user_identities
                  WHERE subject_type = 'employee' AND subject_id = ANY(?) AND last_used_at IS NOT NULL
                  GROUP BY subject_id`,
                [ids]
            );
            const usedBy = new Map(
                (used || []).map((u) => [Number(u.subjectId ?? u.subject_id), u.at])
            );
            for (const e of employees) {
                e.ssoInvite = inv.get(Number(e.id)) || null;
                e.ssoSignedAt = usedBy.get(Number(e.id)) || null;
            }
        } catch (err) {
            console.warn('[accounts] SSO migration state unavailable:', err && err.message);
        }
    }

    /**
     * GET /admin/accounts/sso-notices — « Imprimer les notices SSO »: one A5 page
     * per person (no secret on it: what changed, how to sign in, the company
     * login, whom to contact). Selection: ?ids=1,2,3, else the filters
     * (siteId, supervisorId; default: every notice still to hand over), in scope.
     */
    async ssoNotices(req, res) {
        const scoped = await scopedEmployeeIds(req.user);
        let ids = String(req.query.ids || '')
            .split(',')
            .map(Number)
            .filter((n) => Number.isFinite(n) && n > 0);
        if (!ids.length) {
            const where = [
                `si.subject_type = 'employee'`,
                `si.status = 'skipped_no_email'`,
                'si.handed_over_at IS NULL',
                'e.is_active = true',
            ];
            const params = [];
            const siteId = parseInt(req.query.siteId, 10);
            const supervisorId = parseInt(req.query.supervisorId, 10);
            if (siteId) {
                where.push('e.site_id = ?');
                params.push(siteId);
            }
            if (supervisorId) {
                where.push('e.supervisor_id = ?');
                params.push(supervisorId);
            }
            const rows = await db.all(
                `SELECT DISTINCT e.id FROM sso_migration_invites si JOIN employees e ON e.id = si.subject_id
                  WHERE ${where.join(' AND ')} ORDER BY e.id LIMIT 500`,
                params
            );
            ids = rows.map((r) => Number(r.id));
        }
        if (scoped !== null) ids = ids.filter((id) => scoped.includes(id));
        const notices = await require('../services/SsoInviteService').notices(
            'employee',
            ids.slice(0, 500)
        );
        await LogService.log({
            adminId: req.user.id,
            action: 'SSO_MIGRATION_NOTICES_PRINTED',
            entityType: 'employee',
            details: `SSO migration notices opened for printing: ${notices.length} person(s)`,
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
        });
        res.render('pages/admins/sso-notices', {
            layout: false,
            title: tr(req, 'admin:acc_sso_notices_title'),
            notices,
        });
    }

    /** Bookmarks and the sidebar still point at /admin/invitations. */
    legacyPage(req, res) {
        const qs = new URLSearchParams(req.query).toString();
        res.redirect(302, '/admin/accounts' + (qs ? `?${qs}` : ''));
    }

    /** CSV of exactly what the list shows (scope + every filter), BOM + formula guard. */
    async exportCsv(req, res) {
        const filters = this._filters(req);
        const policy = lockoutPolicy();
        const ctx = {
            expiryDays: await this._expiryDays(),
            dormantDays: await this._dormantDays(),
            policy,
        };
        const sort = sortClause(req.query, SORT, 'name');
        const { fromSql, params } = await this._population(req.user, filters, ctx);
        const rows = await db.all(
            `SELECT x.* ${fromSql} ORDER BY ${sort.orderBy}, x.last_name, x.first_name LIMIT 20000`,
            params
        );
        const headers = [
            'employee_number',
            'name',
            'site',
            'department',
            'role',
            'username',
            'email',
            'kind',
            'state',
            'login_enabled',
            'invited_at',
            'invited_by',
            'last_login_at',
            'failed_attempts',
            'locked_until',
            'auth_policy',
        ].map((k) => tr(req, `admin:acc_csv_${k}`));
        const fmt = (d) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '');
        const data = rows.map((r0) => {
            const r = EmployeeModel.decorateAccountRow(r0, policy.lockoutMinutes);
            // this file wrote « Jean-Luc MORENO, Daniel » while the
            // directory export of the same product wrote « Daniel Jean-Luc MORENO »
            // for the same MOUA1184 — two formats between two exports, the very title of
            // the finding. One order everywhere now (utils/personName), and it is the order
            // this console's own search indexes on (:113), so its label finds its own rows.
            return [
                r.employeeNumber,
                personNameOf(r),
                r.siteName,
                r.departmentName,
                r.roleName,
                r.username || '',
                r.email || '',
                tr(req, `admin:acc_kind_${r.kind}`),
                tr(req, `admin:acc_state_${r.state}`),
                r.accountActive ? '1' : '0',
                fmt(r.invitedAt),
                r.invitedByName || '',
                fmt(r.lastLoginAt),
                r.failedAttempts || 0,
                fmt(r.lockedUntil),
                r.authPolicy || 'any',
            ];
        });
        await LogService.log({
            adminId: req.user.id,
            action: 'ACCOUNTS_EXPORTED',
            entityType: 'employee',
            details: `Accounts inventory exported: ${data.length} row(s) (site ${filters.siteId || 'all'}, department ${filters.departmentId || 'all'}, state ${filters.state || 'all'})`,
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
        });
        return csvResponse(
            res,
            `accounts-${new Date().toISOString().slice(0, 10)}.csv`,
            headers,
            data
        );
    }

    // -----------------------------------------------------------------------
    // Actions
    // -----------------------------------------------------------------------

    /** One employee, one action. Returns { ok, code?, credential? }. */
    async _apply(action, id, req, { welcome, policy }) {
        const employee = await EmployeeModel.findById(id);
        if (!employee) return { ok: false, code: 'not_found' };
        if (employee.isActive === false || employee.isActive === 0)
            return { ok: false, code: 'employee_deactivated' };
        const actor = req.user;
        const Movement = require('../services/MovementService');
        const audit = (actionName, details) =>
            LogService.log({
                adminId: actor.id,
                action: actionName,
                entityType: 'employee',
                entityId: Number(id),
                details,
                severity: 'info',
                category: 'security',
                requestId: req.id || null,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
        switch (action) {
            case 'unlock': {
                const LoginAttemptModel = require('../models/LoginAttemptModel');
                // Lockout keys on the identifier TYPED at login — clear both possibilities.
                for (const identifier of [employee.username, employee.email]) {
                    if (identifier) await LoginAttemptModel.clearFailedAttempts(identifier);
                }
                await audit(
                    'EMPLOYEE_ACCOUNT_UNLOCKED',
                    `Failed-login lockout cleared for employee ${employee.employeeNumber} (username/email attempt counters reset)`
                );
                await Movement.recordAccount(id, {
                    actor,
                    fromLabel: 'locked',
                    toLabel: 'unlocked',
                });
                await this._closeRequests(id, 'unlock', actor.id);
                return { ok: true };
            }
            case 'sso_resend': {
                // C3g (3.23.20): « Relancer l'invitation SSO » — re-queue only.
                const r = await require('../services/SsoInviteService').requeue(
                    'employee',
                    id,
                    actor
                );
                return r.ok ? { ok: true, ssoQueued: true } : { ok: false, code: r.code };
            }
            case 'sso_handed_over': {
                const n = await require('../services/SsoInviteService').markHandedOver(
                    'employee',
                    [id],
                    actor
                );
                return n ? { ok: true } : { ok: false, code: 'sso_nothing_to_hand_over' };
            }
            case 'resend':
            case 'reset': {
                // C3g (3.23.20): on an account MIGRATED to SSO the « resend » never
                // issues a password — it re-queues the SSO invitation instead; a
                // password « reset » is refused while SSO is enforced.
                const Inv = require('../services/SsoInviteService');
                if (await Inv.isMigrated('employee', id)) {
                    if (action === 'resend') {
                        const r = await Inv.requeue('employee', id, actor);
                        return r.ok || r.code === 'sso_invite_already_queued'
                            ? { ok: true, ssoQueued: true }
                            : { ok: false, code: r.code };
                    }
                    if (require('../services/AdminSsoService').isEnforced())
                        return { ok: false, code: 'sso_migrated_no_password' };
                }
                const Cred = require('../services/OnboardingCredentialService');
                const r = await Cred.issueAndSend(id, actor, req, {
                    welcome: action === 'resend' || welcome,
                    allowNoEmail: true,
                });
                if (!r.success) return { ok: false, code: r.code || 'issue_failed' };
                await this._closeRequests(id, 'resend', actor.id);
                return {
                    ok: true,
                    emailed: r.emailed,
                    username: r.username,
                    credential: r.tempPassword
                        ? {
                              employeeNumber: employee.employeeNumber,
                              name: `${employee.firstName} ${employee.lastName}`,
                              username: r.username,
                              tempPassword: r.tempPassword,
                              reason: r.emailStatus,
                          }
                        : null,
                };
            }
            case 'disable': {
                if (!employee.passwordHash && !employee.isAccountActive)
                    return { ok: false, code: 'no_login' };
                await EmployeeModel.update(id, { isAccountActive: 0 });
                try {
                    await require('../services/SessionService').revokeAllForUser(
                        Number(id),
                        'employee'
                    );
                    await require('../services/SessionService').revokeAllForUser(
                        Number(id),
                        'manager'
                    );
                } catch (_) {
                    /* deserialize gate backstops */
                }
                await audit(
                    'EMPLOYEE_LOGIN_DISABLED',
                    `Login disabled for employee ${employee.employeeNumber} (record kept active; credentials kept)`
                );
                await Movement.recordAccount(id, {
                    actor,
                    fromLabel: 'login_enabled',
                    toLabel: 'login_disabled',
                });
                return { ok: true };
            }
            case 'enable': {
                if (!employee.passwordHash) return { ok: false, code: 'no_password' };
                await EmployeeModel.update(id, { isAccountActive: 1 });
                await audit(
                    'EMPLOYEE_LOGIN_ENABLED',
                    `Login re-enabled for employee ${employee.employeeNumber}`
                );
                await Movement.recordAccount(id, {
                    actor,
                    fromLabel: 'login_disabled',
                    toLabel: 'login_enabled',
                });
                return { ok: true };
            }
            case 'policy': {
                if (!RBACService.isSuperAdmin(actor))
                    return { ok: false, code: 'policy_superadmin_only' };
                await EmployeeModel.update(id, { authPolicy: policy });
                await audit(
                    'AUTH_POLICY_SET',
                    `Authentication policy for employee ${employee.employeeNumber} set to '${policy}'`
                );
                await Movement.recordAccount(id, {
                    actor,
                    fromLabel: `policy:${employee.authPolicy || 'any'}`,
                    toLabel: `policy:${policy}`,
                });
                return { ok: true };
            }
            default:
                return { ok: false, code: 'bad_action' };
        }
    }

    /** An admin action answers the manager's request of the same kind. */
    async _closeRequests(employeeId, kind, adminId) {
        try {
            await db.run(
                `UPDATE account_requests SET decided_by = ?, decided_at = now(), decision = 'done'
                  WHERE employee_id = ? AND kind = ? AND decided_at IS NULL`,
                [adminId, Number(employeeId), kind]
            );
        } catch (e) {
            console.error('[accounts] closing requests failed:', e && e.message);
        }
    }

    /**
     * Bulk / per-row actions. Body: { action, employeeIds, policy?, includeActive? }.
     * Scope-enforced per id (outOfScope counted, never acted on). Credentials
     * that could not be e-mailed come back ONCE for the one-time sheet.
     */
    async bulk(req, res) {
        const action = String(req.body.action || '');
        const requested = Array.isArray(req.body.employeeIds)
            ? req.body.employeeIds.map(Number).filter(Number.isFinite)
            : [];
        if (!ACTIONS.includes(action))
            return res.status(400).json({
                ok: false,
                code: 'bad_action',
                error: tr(req, 'admin:acc_err_bad_action'),
            });
        if (!requested.length)
            return res.status(400).json({
                ok: false,
                code: 'no_selection',
                error: tr(req, 'admin:acc_err_no_selection'),
            });
        if (requested.length > 500)
            return res.status(400).json({
                ok: false,
                code: 'batch_too_large',
                error: tr(req, 'admin:acc_err_batch_too_large'),
            });
        const policy = String(req.body.policy || 'any');
        if (action === 'policy' && !POLICIES.includes(policy))
            return res.status(400).json({
                ok: false,
                code: 'bad_policy',
                error: tr(req, 'admin:acc_err_bad_policy'),
            });
        if (action === 'policy' && !RBACService.isSuperAdmin(req.user))
            return res.status(403).json({
                ok: false,
                code: 'policy_superadmin_only',
                error: tr(req, 'admin:acc_err_policy_superadmin_only'),
            });

        const ids = await scopedEmployeeIds(req.user);
        const allowed = ids === null ? requested : requested.filter((id) => ids.includes(id));
        const outOfScope = requested.length - allowed.length;
        if (!allowed.length)
            return res.status(403).json({
                ok: false,
                code: 'out_of_scope',
                error: tr(req, 'admin:acc_err_out_of_scope'),
                outOfScope,
            });

        const includeActive = req.body.includeActive === true || req.body.includeActive === '1';
        const results = {
            done: 0,
            failed: [],
            outOfScope,
            skippedActive: 0,
            credentials: [],
            emailed: 0,
            ssoQueued: 0,
        };
        for (const id of allowed) {
            try {
                // Re-issuing never silently overwrites a password someone already chose.
                if ((action === 'resend' || action === 'reset') && !includeActive) {
                    const row = await db.get(
                        'SELECT (password_hash IS NOT NULL AND is_account_active AND last_login_at IS NOT NULL) AS active FROM employees WHERE id = ?',
                        [id]
                    );
                    if (row && row.active) {
                        results.skippedActive++;
                        continue;
                    }
                }
                const r = await this._apply(action, id, req, {
                    welcome: action === 'resend',
                    policy,
                });
                if (!r.ok) {
                    results.failed.push({
                        id,
                        code: r.code,
                        error: tr(req, `admin:acc_err_${r.code}`),
                    });
                    continue;
                }
                results.done++;
                if (r.ssoQueued) results.ssoQueued++;
                if (r.emailed) results.emailed++;
                if (r.credential) results.credentials.push(r.credential);
            } catch (e) {
                results.failed.push({ id, code: 'error', error: e.message });
            }
        }
        if (allowed.length > 1) {
            await LogService.log({
                adminId: req.user.id,
                action: 'ACCOUNTS_BULK_ACTION',
                entityType: 'employee',
                details:
                    `Bulk account action '${action}': ${results.done} done, ${results.skippedActive} skipped (already signed in), ${outOfScope} out of scope, ${results.failed.length} failed, of ${requested.length} selected` +
                    (results.credentials.length
                        ? `; ${results.credentials.length} credential(s) on a one-time sheet`
                        : ''),
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
        }
        let message = tr(req, `admin:acc_done_${action}`, {
            n: results.done,
            sheet: results.credentials.length,
            skipped: results.skippedActive,
            out: outOfScope,
            failed: results.failed.length,
        });
        // C3g: bulk runs only QUEUE SSO invitations — say how many.
        if (results.ssoQueued)
            message += ` ${tr(req, 'admin:acc_sso_queued_n', { n: results.ssoQueued })}`;
        res.json({
            ok: results.done > 0 || results.failed.length === 0,
            success: results.done > 0,
            results,
            message,
        });
    }

    /** Close a manager's request without acting (a note is required). */
    async declineRequest(req, res) {
        const id = Number(req.params.id);
        const note = String(req.body.note || '').trim();
        if (!note)
            return res.status(400).json({
                ok: false,
                code: 'reason_required',
                error: tr(req, 'admin:acc_err_reason_required'),
            });
        const rq = await db.get(
            'SELECT id, employee_id, kind, decided_at FROM account_requests WHERE id = ?',
            [id]
        );
        if (!rq)
            return res
                .status(404)
                .json({ ok: false, code: 'not_found', error: tr(req, 'admin:acc_err_not_found') });
        if (rq.decidedAt)
            return res.status(409).json({
                ok: false,
                code: 'already_decided',
                error: tr(req, 'admin:acc_err_already_decided'),
            });
        const ids = await scopedEmployeeIds(req.user);
        if (ids !== null && !ids.includes(Number(rq.employeeId)))
            return res.status(403).json({
                ok: false,
                code: 'out_of_scope',
                error: tr(req, 'admin:acc_err_out_of_scope'),
            });
        await db.run(
            `UPDATE account_requests SET decided_by = ?, decided_at = now(), decision = 'declined', note = COALESCE(note, '') || ' — ' || ? WHERE id = ?`,
            [req.user.id, note, id]
        );
        await LogService.log({
            adminId: req.user.id,
            action: 'ACCOUNT_REQUEST_DECLINED',
            entityType: 'employee',
            entityId: Number(rq.employeeId),
            details: `Account request #${id} (${rq.kind}) declined — ${note}`,
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
        });
        res.json({ ok: true, message: tr(req, 'admin:acc_request_declined') });
    }

    // -----------------------------------------------------------------------
    // Legacy routes (kept working)
    // -----------------------------------------------------------------------

    /** Legacy bulk invitation = bulk resend with the welcome mail. */
    async send(req, res) {
        req.body.action = 'resend';
        return this.bulk(req, res);
    }

    /** Inline email fix-up for a no-email employee (validated + audited + scoped). */
    async setEmail(req, res) {
        const employeeId = Number(req.params.id);
        const email = String(req.body.email || '')
            .trim()
            .toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
            return res
                .status(400)
                .json({ error: tr(req, 'admin:acc_err_bad_email'), code: 'bad_email' });
        }
        const ids = await scopedEmployeeIds(req.user);
        if (ids !== null && !ids.includes(employeeId)) {
            return res
                .status(403)
                .json({ error: tr(req, 'admin:acc_err_out_of_scope'), code: 'out_of_scope' });
        }
        // A shared address is allowed (a person may hold several accounts,
        // migration 107): the console is advised, never refused.
        const shared = await require('../services/EmailAccountsService')
            .describe(req, email, { excludeEmployeeId: employeeId })
            .catch(() => ({ count: 0, who: '' }));
        const emp = await db.get(
            'SELECT employee_number AS n FROM employees WHERE id = ? AND is_active',
            [employeeId]
        );
        if (!emp)
            return res
                .status(404)
                .json({ error: tr(req, 'admin:acc_err_not_found'), code: 'not_found' });
        await db.run('UPDATE employees SET email = ?, updated_at = now() WHERE id = ?', [
            email,
            employeeId,
        ]);
        await LogService.log({
            adminId: req.user.id,
            action: 'EMPLOYEE_EMAIL_SET',
            entityType: 'employee',
            entityId: employeeId,
            details: `Email address set for employee ${emp.n} via the Accounts console`,
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
        });
        res.json({
            success: true,
            ok: true,
            email,
            shared: shared.count
                ? req.t
                    ? req.t('admin:email_shared_note', { count: shared.count, who: shared.who })
                    : `Also used by ${shared.who}`
                : null,
        });
    }

    /** Render the welcome email exactly as it will be sent — password masked. */
    async preview(req, res) {
        const employeeId = Number(req.params.id);
        const ids = await scopedEmployeeIds(req.user);
        if (ids !== null && !ids.includes(employeeId))
            return res.status(403).send(tr(req, 'admin:acc_err_out_of_scope'));
        const employee = await EmployeeModel.findById(employeeId);
        if (!employee) return res.status(404).send(tr(req, 'admin:acc_err_not_found'));
        let branding = null;
        try {
            branding = await require('../utils/branding').getBranding();
        } catch {
            /* stock */
        }
        const OnboardingCredentialService = require('../services/OnboardingCredentialService');
        const mail = await OnboardingCredentialService._welcomeEmail({
            employee,
            username: employee.username || tr(req, 'admin:acc_preview_username_generated'),
            tempPassword: '••••••••••••',
            branding,
        });
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(mail.html);
    }
}

module.exports = new InvitationController();
module.exports.lockoutPolicy = lockoutPolicy;
module.exports.STATES = STATES;
