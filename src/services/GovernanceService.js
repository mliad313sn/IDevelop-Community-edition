'use strict';

/**
 * GovernanceService — who is responsible for whom, with no dead ends.
 *
 * THE PROBLEM IT SOLVES
 * A person with no supervisor and no manager had nobody to review them: their
 * self-assessment reached no queue and they appeared in no digest. On the live
 * instance that was 15-16 active employees whose submissions would simply have
 * vanished.
 *
 * THE RULE
 * Responsibility falls through, most specific first:
 *
 *     supervisor  ->  manager  ->  the LOCAL ADMIN whose scope covers them
 *
 * The admin fallback is derived from `admin_scopes`, not invented: an admin
 * scoped to a service covers the people in that service, a department scope
 * covers the department, a site scope covers the site. Where several admins
 * cover the same person, the NARROWEST scope wins (service beats department
 * beats site); ties keep every candidate so nobody is silently dropped.
 * Expired scopes (`expires_at` in the past) never confer responsibility.
 *
 * Only when no supervisor, no manager AND no covering admin scope exists is a
 * person genuinely orphaned — that is the set the Setup checklist should flag,
 * and it is far smaller than "has no supervisor".
 */

const db = require('../config/database');

// ST-5 (3.23.21): per-account memo of the reporting line for rbacMiddleware only.
const LINE_CACHE = new Map();
const LINE_CACHE_TTL_MS = 60 * 1000;
const LINE_CACHE_MAX = 5000;

// Narrowest first: the closest scope owns the person.
const SCOPE_RANK = { service: 1, department: 2, site: 3, region: 4, country: 5 };

// THE "nobody reviews this person" rule, shared with the worklist and the
// Setup checklist so the three surfaces count the same people — and, with it,
// THE "this clearance is live" rule.
const {
    liveAdminScopeSql,
    hasPersonReviewerSql,
    hasCoveringAdminScopeSql,
    missingReviewerSql,
} = require('../utils/reviewerGapSql');

/**
 * An admin scope is only live when it has neither EXPIRED nor been REVOKED.
 *
 * `revoked_at` was missing from the shared fragment
 * (`utils/reviewerGapSql.hasCoveringAdminScopeSql`) while this file and
 * `AdminModel.findWithScopes` — what `deserializeUser` puts on `req.user`, what
 * every `RBACService.canAccess*` check reads — filtered both. The surfaces had
 * diverged a second time, which is exactly what sharing the rule was meant to
 * stop: a REVOKED clearance still counted as cover in the orphan worklist, the
 * Setup checklist and coverageSummary, so they UNDER-reported the people nobody
 * reviews (measured: one revoked clearance, orphaned 6 -> 5, byAdmin 9 -> 10,
 * while canReview on that same pair stayed FALSE).
 *
 * So the predicate is no longer written here: it is DEFINED ONCE in
 * `utils/reviewerGapSql.liveAdminScopeSql` and consumed by every surface, and it
 * cannot diverge a third time.
 */
const LIVE_SCOPE = liveAdminScopeSql('sc');
const { personNameSql } = require('../utils/personName');

/**
 * An employee row that can still HOLD a reporting line: active, not voided
 * (MaintenanceService.voidEmployee), not erased (DSRService.erase). Same bar as
 * utils/reviewerGapSql.hasPersonReviewerSql plus the erasure stamp.
 */
function activePersonSql(x) {
    return `${x}.is_active = true AND ${x}.cancelled_at IS NULL AND ${x}.erased_at IS NULL`;
}

/**
 * THE REPORTING LINE OF ONE PERSON, as SQL — 3.23.18.
 *
 * The line is the SUPERVISOR when there is a live one, otherwise the MANAGER:
 * an employee-typed manager (joined on employees) or an admin-typed manager
 * (joined on admins — the two id spaces overlap, so `manager_type` is never
 * optional). Every candidate must be live; a person is never their own line.
 *
 * Returned as UNION ALL candidate rows (prio, kind, id) so a caller can put its
 * own higher-priority rows in front (the campaign console puts an explicit
 * reviewer assignment first) and keep ONE definition of the line itself.
 * `e` is the alias of the employees row whose line is resolved.
 */
function reportingLineCandidatesSql(e = 'e') {
    return `SELECT 10 AS prio, 'employee' AS kind, lx.id AS id FROM employees lx
             WHERE lx.id = ${e}.supervisor_id AND lx.id <> ${e}.id AND ${activePersonSql('lx')}
            UNION ALL
            SELECT 20, 'employee', lm.id FROM employees lm
             WHERE COALESCE(${e}.manager_type, 'employee') = 'employee'
               AND lm.id = ${e}.manager_id AND lm.id <> ${e}.id AND ${activePersonSql('lm')}
            UNION ALL
            SELECT 30, 'admin', la.id FROM admins la
             WHERE ${e}.manager_type = 'admin' AND la.id = ${e}.manager_id AND la.is_active = true`;
}

const GovernanceService = {
    /**
     * THE PERSON BEHIND THE ACCOUNT.
     *
     * `admins.linked_employee_id` states, in the database, that this
     * administration account IS that employee — it is written by
     * promote-to-admin, by account linking and by the SSO "explicit admin
     * connect" path, and it carries a unique index. Until now NOTHING on the
     * review path read it, and the consequence was the worst kind: a supervisor
     * or manager who also holds an admin account, logged in on that account, lost
     * their ENTIRE team. Their line authority was not merged with their
     * clearance, it was REPLACED by it — measured on a development database, the
     * same human went from 15 reviewable people to 5, none of them theirs, with
     * the console rendering 200 and saying nothing.
     *
     * Two authorities, one person: they ADD UP. A clearance grants a perimeter,
     * it never takes one away, and the reporting line is not a property of the
     * password that was typed.
     *
     * Returns null when the account names no person, or names one who is no
     * longer active — a departed manager's admin account must not keep governing
     * the team they left.
     *
     * @returns {Promise<number|null>} employee id of the human acting, if any
     */
    async actingPersonId(user) {
        if (!user || user.id == null) return null;
        if (user.userType !== 'admin') return Number(user.id);
        const row = await db.get(
            `SELECT e.id
               FROM admins a
               JOIN employees e ON e.id = a.linked_employee_id
              WHERE a.id = ? AND e.is_active = true AND e.cancelled_at IS NULL`,
            [user.id]
        );
        return row ? Number(row.id) : null;
    },

    /**
     * Employees this ADMIN ACCOUNT is named the manager of.
     *
     * `employees.manager_id` is polymorphic and `manager_type` is what tells the
     * two id spaces apart: 'employee' points at a person, 'admin' at an
     * administration account. The product offers that designation on the employee
     * form, and it used to mean nothing at all — an admin named manager of
     * somebody drew no authority whatsoever from it, only from `admin_scopes`.
     * Either the designation means something or it must not be offered; it means
     * something.
     */
    async adminDesignatedEmployeeIds(adminId) {
        if (adminId == null) return [];
        const rows = await db.all(
            `SELECT id FROM employees
              WHERE manager_type = 'admin' AND manager_id = ?
                AND is_active = true AND cancelled_at IS NULL`,
            [adminId]
        );
        return rows.map((r) => Number(r.id));
    },

    /**
     * Everyone this user governs BY THE REPORTING LINE, whichever account they
     * signed in with — their own sub-tree as a person, plus the sub-tree of
     * anyone this admin account is named the manager of.
     *
     * The one place the line is resolved, so the queue (`RBACService.scopeFilter`),
     * the reviewable set below and the per-object guard in
     * `SelfAssessmentWorkflowService.resolveAuthority` cannot drift apart again.
     */
    async lineAuthorityEmployeeIds(user) {
        if (!user || user.id == null) return [];
        const EmployeeModel = require('../models/EmployeeModel');
        if (user.userType !== 'admin')
            return (await EmployeeModel.findGovernedIds(user.id)).map(Number);

        const ids = new Set();
        const personId = await this.actingPersonId(user);
        if (personId != null) {
            for (const id of await EmployeeModel.findGovernedIds(personId)) ids.add(Number(id));
        }
        // MESURE DE L'INTEGRATEUR, 16/09/2026 — LA LISTE DIT EXACTEMENT CE QUE LE
        // GARDE ACCORDE, NI PLUS NI MOINS.
        //
        // Cette boucle descendait aussi le SOUS-ARBRE de la personne designee
        // (`findGovernedIds(designated)`), par symetrie avec la branche employe.
        // Mais le garde par objet, lui, ne resout le sous-arbre que par
        // `EmployeeModel.governs(actingPersonId(user), …)`, et actingPersonId vaut
        // NULL pour un compte d'administration sans linked_employee_id : sa branche
        // `isManager` ne couvre que la personne DIRECTEMENT designee. Les deux cotes
        // ne pouvaient donc pas coincider.
        //
        // Mesure, un compte d'administration SANS AUCUNE habilitation designe manager
        // de l'employe 136 (qui gouverne 138) :
        //     reviewableEmployeeIds = 16 ids, contient 138  -> la FILE le montre
        //     resolveAuthority(…, 138) = canView FALSE       -> le DETAIL le refuse
        // C'est la forme exacte du defaut que ce programme combat : une liste qui
        // propose ce que le garde refuse.
        //
        // Aligne dans le sens RESTRICTIF, deliberement. Elargir le garde au sous-arbre
        // donnerait a un compte a zero habilitation le droit d'AGIR sur toute une
        // equipe, ce qui contredit « un administrateur borne reste confine sur TOUS
        // les chemins » et amplifierait le chemin d'auto-elevation de
        // EmployeeController.resolveManagerSelection (un administrateur borne qui peut
        // editer une fiche de son habilitation peut s'y nommer manager). Le constat
        // d'origine — « un ADMIN designe manager ne tire AUCUNE autorite de cette
        // designation » — reste ferme : il gouverne la personne qu'il a ete designe
        // pour gouverner. Le sous-arbre etait une extrapolation, signalee comme « un
        // choix, pas une evidence » par le lot qui l'a posee ; elle est a arbitrer par
        // le proprietaire, et alors dans les DEUX surfaces a la fois.
        for (const designated of await this.adminDesignatedEmployeeIds(user.id)) {
            ids.add(designated);
        }
        return [...ids];
    },

    /**
     * ST-5 (3.23.21) — the same set, memoised per account for a short TTL, for
     * the ONE caller that runs on every request: rbacMiddleware, which only
     * NARROWS read filters (dashboards, benchmark, executive views). Up to three
     * queries per admin request, on every page and every /api/benchmark/fit
     * call, for an answer that changes when someone edits a reporting line.
     *
     * Per-object AUTHORITY guards keep calling lineAuthorityEmployeeIds (never
     * cached). A failure is not cached. The map is bounded; the oldest entry
     * goes first. Staleness ≤ TTL is the accepted trade-off (a reporting line
     * edited now reaches the dashboard filter within a minute).
     */
    async lineAuthorityEmployeeIdsCached(user, { ttlMs = LINE_CACHE_TTL_MS } = {}) {
        if (!user || user.id == null) return [];
        const key = `${user.userType || '?'}:${user.id}`;
        const now = Date.now();
        const hit = LINE_CACHE.get(key);
        if (hit && hit.expires > now) return hit.ids.slice();
        const ids = await this.lineAuthorityEmployeeIds(user);
        if (LINE_CACHE.size >= LINE_CACHE_MAX) {
            LINE_CACHE.delete(LINE_CACHE.keys().next().value);
        }
        LINE_CACHE.delete(key);
        LINE_CACHE.set(key, { ids: ids.slice(), expires: now + ttlMs });
        return ids;
    },

    /** Drop the memoised line of one account, or all of them (tests, admin edits). */
    clearLineAuthorityCache(user) {
        if (user && user.id != null) LINE_CACHE.delete(`${user.userType || '?'}:${user.id}`);
        else LINE_CACHE.clear();
    },

    /**
     * Admins whose scope covers this employee, narrowest scope first.
     * @returns {Promise<Array<{adminId:number, username:string, role:string, scopeType:string}>>}
     */
    async coveringAdmins(employeeId) {
        const rows = await db.all(
            `SELECT a.id AS "adminId", a.username, a.role, sc.scope_type AS "scopeType"
             FROM employees e
             JOIN admin_scopes sc
               ON ${LIVE_SCOPE}
              AND ( (sc.scope_type = 'service'    AND sc.service_id    = e.service_id)
                 OR (sc.scope_type = 'department' AND sc.department_id = e.department_id)
                 OR (sc.scope_type = 'site'       AND sc.site_id       = e.site_id) )
             JOIN admins a ON a.id = sc.admin_id AND a.is_active = true
             WHERE e.id = ?`,
            [employeeId]
        );

        const seen = new Map();
        for (const r of rows) {
            const prev = seen.get(Number(r.adminId));
            const rank = SCOPE_RANK[r.scopeType] || 99;
            if (!prev || rank < prev.rank)
                seen.set(Number(r.adminId), { ...r, adminId: Number(r.adminId), rank });
        }
        return [...seen.values()].sort((a, b) => a.rank - b.rank);
    },

    /**
     * Who reviews this person. Never throws; returns kind 'none' when the person
     * is genuinely orphaned so callers can surface it rather than guess.
     */
    async resolveReviewer(employeeId) {
        // 3.23.18: the line is resolved on LIVE rows only, and the manager
        // is joined in the id space `manager_type` names. This used to take a
        // departed supervisor as the reviewer, and for an admin-managed person it
        // joined the ADMIN id against employees — naming whichever unrelated
        // employee happened to carry that number.
        //   supervisorId / managerId come back NULL when the person they point at
        //   is no longer live, so the fall-through below is the product rule:
        //   live supervisor -> live manager (employee or admin) -> covering admin.
        const e = await db.get(
            `SELECT e.id, sup.id AS "supervisorId",
                    COALESCE(mgr.id, adm.id) AS "managerId",
                    CASE WHEN adm.id IS NOT NULL THEN 'admin' WHEN mgr.id IS NOT NULL THEN 'employee' END AS "managerType",
                    ${personNameSql('sup')} AS "supervisorName",
                    COALESCE(NULLIF(${personNameSql('mgr')}, ''),
                             NULLIF(${personNameSql('adme')}, ''),
                             adm.username::text) AS "managerName"
             FROM employees e
             LEFT JOIN employees sup ON sup.id = e.supervisor_id AND sup.id <> e.id
                                    AND ${activePersonSql('sup')}
             LEFT JOIN employees mgr ON COALESCE(e.manager_type, 'employee') = 'employee'
                                    AND mgr.id = e.manager_id AND mgr.id <> e.id
                                    AND ${activePersonSql('mgr')}
             LEFT JOIN admins adm    ON e.manager_type = 'admin' AND adm.id = e.manager_id
                                    AND adm.is_active = true
             LEFT JOIN employees adme ON adme.id = adm.linked_employee_id
             WHERE e.id = ?`,
            [employeeId]
        );
        if (!e) return { kind: 'none', type: null, id: null, name: null };

        if (e.supervisorId)
            return {
                kind: 'supervisor',
                type: 'employee',
                id: Number(e.supervisorId),
                name: e.supervisorName,
            };
        if (e.managerId)
            return {
                kind: 'manager',
                type: e.managerType === 'admin' ? 'admin' : 'employee',
                id: Number(e.managerId),
                name: e.managerName,
            };

        const admins = await this.coveringAdmins(employeeId);
        if (admins.length) {
            return {
                kind: 'local_admin',
                type: 'admin',
                id: admins[0].adminId,
                name: admins[0].username,
                scopeType: admins[0].scopeType,
                alternates: admins.slice(1).map((a) => ({ id: a.adminId, name: a.username })),
            };
        }
        return { kind: 'none', type: null, id: null, name: null };
    },

    /**
     * The person's direct manager as a PERSON (an employee id), or null: the
     * live supervisor, else the live employee manager, else the employee linked
     * to the admin account named manager. A covering admin with no person
     * behind it is not a manager a one-to-one or a 360° rating can be held with.
     */
    async directManagerPersonId(employeeId) {
        const r = await this.resolveReviewer(employeeId);
        if (r.kind === 'supervisor' || (r.kind === 'manager' && r.type === 'employee'))
            return Number(r.id);
        if (r.kind === 'manager' && r.type === 'admin') {
            const row = await db.get(
                `SELECT e.id FROM admins a JOIN employees e ON e.id = a.linked_employee_id
                  WHERE a.id = ? AND e.is_active = true AND e.cancelled_at IS NULL`,
                [r.id]
            );
            return row && Number(row.id) !== Number(employeeId) ? Number(row.id) : null;
        }
        return null;
    },

    /**
     * Employees this ADMIN is responsible for reviewing directly — i.e. inside
     * their scope AND with no supervisor and no manager of their own. These are
     * the people whose reviews would otherwise reach nobody.
     */
    async fallbackEmployeeIdsForAdmin(adminId) {
        const rows = await db.all(
            `SELECT DISTINCT e.id
             FROM employees e
             JOIN admin_scopes sc
               ON sc.admin_id = ?
              AND ${LIVE_SCOPE}
              AND ( (sc.scope_type = 'service'    AND sc.service_id    = e.service_id)
                 OR (sc.scope_type = 'department' AND sc.department_id = e.department_id)
                 OR (sc.scope_type = 'site'       AND sc.site_id       = e.site_id) )
             WHERE e.is_active = true AND e.cancelled_at IS NULL
               AND NOT ${hasPersonReviewerSql('e')}`,
            [adminId]
        );
        return rows.map((r) => Number(r.id));
    },

    /**
     * Every employee whose assessments this user may see AND act on as a
     * reviewer — the team-wide set behind "a supervisor or manager sees all of
     * their staff's reviews, whoever performed them":
     *
     *   superadmin           -> null (everyone)
     *   manager / supervisor -> their full governed sub-tree
     *   local admin / viewer -> their scope, plus their fallback employees,
     *                           plus the reporting line of the PERSON behind the
     *                           account (see actingPersonId)
     *
     * @returns {Promise<number[]|null>} null = unrestricted
     */
    async reviewableEmployeeIds(user) {
        if (!user) return [];
        if (user.userType === 'admin' && user.role === 'superadmin') return null;

        if (user.userType === 'manager' || user.userType === 'employee') {
            const EmployeeModel = require('../models/EmployeeModel');
            return EmployeeModel.findGovernedIds(user.id);
        }

        // Local admin / viewer: their scope already includes the fallback people,
        // but union explicitly so a scope-matching change can never silently drop
        // the very employees this feature exists to rescue.
        //
        // UNION, never replacement. The third term is the reporting line of the
        // human behind the account: a supervisor who signs in on their admin
        // account used to arrive here and be handed their CLEARANCE INSTEAD OF
        // their team — their own people vanished from the review queue without a
        // word on screen.
        const RBACService = require('../services/RBACService');
        const scoped = (await RBACService.getFilteredEmployees(user)).map((e) => Number(e.id));
        const fallback = await this.fallbackEmployeeIdsForAdmin(user.id);
        const line = await this.lineAuthorityEmployeeIds(user);
        return [...new Set([...scoped, ...fallback, ...line])];
    },

    /**
     * May this user open and act on a review of this employee?
     * True when the employee is inside the caller's reviewable set — i.e. their
     * governed sub-tree, or their admin scope including fallback people. Being
     * the originally assigned reviewer is NOT required: accountability follows
     * the reporting line, not whoever happened to click first.
     */
    async canReview(user, employeeId) {
        const ids = await this.reviewableEmployeeIds(user);
        if (ids === null) return true; // superadmin
        return ids.includes(Number(employeeId));
    },

    /**
     * Active employees with NO reviewer at all — no supervisor, no manager and
     * no covering admin scope. The honest "nobody is responsible" list.
     */
    async orphanedEmployees() {
        return db.all(
            `SELECT e.id, e.employee_number AS "employeeNumber",
                    ${personNameSql('e')} AS "name",
                    s.name AS "siteName", d.name AS "departmentName", sv.name AS "serviceName"
             FROM employees e
             LEFT JOIN sites s        ON s.id  = e.site_id
             LEFT JOIN departments d  ON d.id  = e.department_id
             LEFT JOIN services sv    ON sv.id = e.service_id
             WHERE ${missingReviewerSql('e')}
             ORDER BY s.name, d.name, e.last_name`
        );
    },

    /**
     * Counts for the Setup checklist: covered by a person, by an admin, or nobody.
     * "By a person" means an ACTIVE, non-voided supervisor or manager — the same
     * rule as the /employees?missingReviewer=1 worklist (EmployeeModel), so
     * `orphaned` here is exactly the number of rows that worklist shows.
     */
    async coverageSummary() {
        const row = await db.get(
            `SELECT
                COUNT(*) FILTER (WHERE ${hasPersonReviewerSql('e')}) AS "byPerson",
                COUNT(*) FILTER (WHERE NOT ${hasPersonReviewerSql('e')}
                                   AND ${hasCoveringAdminScopeSql('e')}) AS "byAdmin",
                COUNT(*) FILTER (WHERE ${missingReviewerSql('e')}) AS "orphaned"
             FROM employees e WHERE e.is_active = true AND e.cancelled_at IS NULL`
        );
        return {
            byPerson: Number(row?.byPerson || 0),
            byAdmin: Number(row?.byAdmin || 0),
            orphaned: Number(row?.orphaned || 0),
        };
    },

    /** See reportingLineCandidatesSql above — THE line rule, as SQL. */
    reportingLineCandidatesSql,
    activePersonSql,
};

module.exports = GovernanceService;
