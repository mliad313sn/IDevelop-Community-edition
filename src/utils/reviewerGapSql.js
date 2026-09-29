'use strict';

/**
 * THE "nobody reviews this person" rule, as SQL fragments — the single source
 * shared by the /employees?missingReviewer=1 worklist (EmployeeModel), the
 * Setup checklist (SetupController) and the governance coverage counts
 * (GovernanceService).
 *
 * "No supervisor" means no ACTIVE, non-voided one — never merely a NULL column:
 * when a supervisor is processed as a leaver or their record is voided,
 * supervisor_id on their reports still points at them. Same rule for the
 * manager line, for either manager type. The three surfaces used to disagree
 * (reproduced: one person re-pointed at an inactive supervisor — worklist 7,
 * setup 6, governance 6) because two of them still counted NULL columns.
 *
 * Lives in its own module (not on EmployeeModel) so a test that mocks the
 * model does not lose the predicate the other surfaces depend on.
 *
 * `alias` is the employees alias in the caller's query. snake_case throughout
 * so the fragments read the same under the compat translator and in raw SQL.
 * No SQL comments inside: a `--` in a SELECT list breaks GROUP BY expansion.
 */
function hasPersonReviewerSql(alias = 'e') {
    const e = alias;
    return `(EXISTS (SELECT 1 FROM employees sup
                     WHERE sup.id = ${e}.supervisor_id AND sup.is_active = true AND sup.cancelled_at IS NULL)
          OR EXISTS (SELECT 1 FROM employees mgr
                     WHERE mgr.id = ${e}.manager_id AND COALESCE(${e}.manager_type, 'employee') = 'employee'
                       AND mgr.is_active = true AND mgr.cancelled_at IS NULL)
          OR EXISTS (SELECT 1 FROM admins am
                     WHERE am.id = ${e}.manager_id AND ${e}.manager_type = 'admin' AND am.is_active = true))`;
}

/**
 * A clearance CONFERS AUTHORITY only while it has neither EXPIRED nor been
 * REVOKED. THE single predicate, shared: `GovernanceService` (coveringAdmins,
 * fallbackEmployeeIdsForAdmin) and `AdminModel.findWithScopes` — what
 * `deserializeUser` puts on `req.user` and what every `RBACService.canAccess*`
 * check reads — apply exactly this rule, and this fragment used to filter
 * `expires_at` ALONE.
 *
 * The consequence was measured on a development database, on the three surfaces
 * that share this module: a SINGLE REVOKED clearance posted on a site removed a
 * genuinely unreviewed person from the orphan list — orphanedEmployees 6 -> 5,
 * coverageSummary {byPerson:61, byAdmin:9, orphaned:6} -> {byPerson:61,
 * byAdmin:10, orphaned:5} — while `canReview(that account, that person)` stayed
 * FALSE. The person was counted as covered by an account that precisely cannot
 * review them: the worklist and the Setup checklist UNDER-report the people
 * nobody reviews, which is the one thing this module exists to prevent.
 *
 * Revoking a clearance is how a clearance is taken away ("Désactiver",
 * migration 110, writes `revoked_at` and keeps the row because nothing is ever
 * deleted). A withdrawal that half the product ignores is not a withdrawal.
 *
 * @param {string} alias the admin_scopes alias in the caller's query
 */
function liveAdminScopeSql(alias = 'sc') {
    const sc = alias;
    return `(${sc}.revoked_at IS NULL AND (${sc}.expires_at IS NULL OR ${sc}.expires_at > now()))`;
}

function hasCoveringAdminScopeSql(alias = 'e') {
    const e = alias;
    return `EXISTS (SELECT 1 FROM admin_scopes sc
                    JOIN admins a ON a.id = sc.admin_id AND a.is_active = true
                    WHERE ${liveAdminScopeSql('sc')}
                      AND ( (sc.scope_type = 'service'    AND sc.service_id    = ${e}.service_id)
                         OR (sc.scope_type = 'department' AND sc.department_id = ${e}.department_id)
                         OR (sc.scope_type = 'site'       AND sc.site_id       = ${e}.site_id) ))`;
}

/** Active, non-voided, and nobody — no person, no covering admin scope — reviews them. */
function missingReviewerSql(alias = 'e') {
    const e = alias;
    return `(${e}.is_active = true AND ${e}.cancelled_at IS NULL
        AND NOT ${hasPersonReviewerSql(e)}
        AND NOT ${hasCoveringAdminScopeSql(e)})`;
}

module.exports = {
    liveAdminScopeSql,
    hasPersonReviewerSql,
    hasCoveringAdminScopeSql,
    missingReviewerSql,
};
