'use strict';

/**
 * ContinuityService — People Continuity core (Phase 1).
 *
 *   - Critical-role designation (role_criticality).
 *   - Succession plans (one open plan per critical role) + a bench of successors.
 *   - Auto-seeding the bench from readiness against the TARGET role, with each
 *     candidate's gap captured so the development-to-readiness loop can act on it.
 *   - Coverage analytics (v_continuity_coverage).
 *
 * Readiness here is computed against the *target* role's skill requirements
 * (not the candidate's own role), which is what succession needs.
 */
const db = require('../config/database');

// A candidate may only be called Ready-Now on a readiness figure that rests on
// enough measurement: at least this share of the target role's requirements
// must have been assessed. Below the floor the band is capped at ready_1_2y —
// 100 % on the two skills somebody happened to be rated on is not readiness.
const READY_NOW_COVERAGE_FLOOR = 80;
// A candidate placed on a 1-2 year track still needs enough of the role measured
// to say anything: 75 % on ONE of 161 requirements is not "ready in a year or
// two", it is "we have barely looked". Half the role is the floor for that band.
const READY_1_2Y_COVERAGE_FLOOR = 50;

/**
 * Band from the ASSESSED-ONLY readiness (ReadinessService's canonical number).
 * `pct` null = nothing measured → the lowest band; the successor row then carries
 * confidence NULL and every requirement as `current: null` in gap_summary, so
 * the placement can never be read as an earned score.
 *
 * Coverage gates BOTH ready bands. Unknown coverage (null — a role with no
 * positive requirement) is treated as 0, i.e. it never PASSES a floor: an unknown
 * is not evidence of readiness. This used to default to 100 and treat null as a
 * pass, so a candidate measured on a handful of a large role's skills could be
 * banded ready_1_2y (and, before the ready_now floor, ready_now).
 */
function bandFromReadiness(pct, coveragePct) {
    if (pct == null) return 'ready_3y';
    const cov = coveragePct == null ? 0 : Number(coveragePct);
    if (pct >= 90 && cov >= READY_NOW_COVERAGE_FLOOR) return 'ready_now';
    if (pct >= 70 && cov >= READY_1_2Y_COVERAGE_FLOOR) return 'ready_1_2y';
    return 'ready_3y';
}

/**
 * successors.confidence: NULL when nothing was measured, never "0.000".
 *
 * Confidence combines FIT with how much of the role was measured — a high fit on
 * a sliver of the role is not a confident placement. It was fit alone, so every
 * candidate came out at (fit/100) and a 4-of-63 candidate read as confident as a
 * fully-evidenced one. Now fit × coverage (both fractions): 100 % on 6 % of the
 * role → 0.060, 90 % on a fully-measured role → 0.900.
 */
function confidenceFrom(pct, coveragePct) {
    if (pct == null) return null;
    const cov = coveragePct == null ? 0 : Number(coveragePct);
    return ((pct / 100) * (cov / 100)).toFixed(3);
}

/**
 * The per-candidate arithmetic shared by readinessForRole and seedSuccessors —
 * one implementation so the bench and the manual nomination cannot disagree.
 *
 *   rows: [{skillId, skillName, required, current, assessedLevel}] for ONE candidate,
 *         `assessedLevel` = the raw assessment (NULL when never assessed),
 *         `current`       = the effective level (a lapsed certificate degrades it to 0).
 *
 * Mirrors ReadinessService._calculateSingleReadiness: points over the ASSESSED
 * requirements only, pct null when none was assessed; every never-assessed
 * requirement stays in the gap list (the department-designed set is never
 * hidden) but with `current: null`, and is counted in `unmeasured`.
 */
function scoreRows(rows) {
    let pointsGained = 0,
        pointsRequired = 0,
        assessed = 0,
        unmeasured = 0;
    const gaps = [];
    for (const r of rows) {
        const required = Number(r.required);
        // `assessedLevel` is the measurement predicate; a row shape without it
        // (older callers) falls back to the effective level's presence.
        const isAssessed =
            r.assessedLevel !== undefined ? r.assessedLevel != null : r.current != null;
        if (!isAssessed) {
            unmeasured++;
            gaps.push({ skillId: r.skillId, skillName: r.skillName, required, current: null });
            continue;
        }
        const current = Number(r.current);
        assessed++;
        pointsRequired += required;
        pointsGained += Math.min(current, required);
        if (current < required)
            gaps.push({ skillId: r.skillId, skillName: r.skillName, required, current });
    }
    const required = rows.length;
    return {
        // `pct` is ROUNDED, for display. `pctExact` is not, and is what the
        // band is chosen from: rounding first put everything in [89.5, 90)
        // into 'ready_now' and everything in [69.5, 70) into 'ready_1_2y'.
        // 89.5 % of a critical role's benchmark is not "can step into the post
        // today", and crossing into ready_now fires
        // continuity.successor_ready at the plan owner.
        pct:
            assessed > 0 && pointsRequired > 0
                ? Math.round((pointsGained / pointsRequired) * 100)
                : null,
        pctExact: assessed > 0 && pointsRequired > 0 ? (pointsGained / pointsRequired) * 100 : null,
        gaps,
        assessed,
        unmeasured,
        required,
        coveragePct: required > 0 ? Math.round((1000 * assessed) / required) / 10 : null,
    };
}

// Succession review cadence: a plan opened (or reviewed) today falls due in
// REVIEW_INTERVAL_MONTHS months. `succession_plans.review_due` shipped in
// migration 24 but nothing wrote or read it, so plans were never revisited.
const REVIEW_INTERVAL_MONTHS = 6;

/** `YYYY-MM-DD` for the next review, N months after `from` (UTC-safe). */
function nextReviewDue(from = new Date(), months = REVIEW_INTERVAL_MONTHS) {
    const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + months);
    // Clamp to the last day of the target month (31 Aug + 6 months → 28/29 Feb).
    const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, lastDay));
    return d.toISOString().slice(0, 10);
}

class ContinuityService {
    get REVIEW_INTERVAL_MONTHS() {
        return REVIEW_INTERVAL_MONTHS;
    }
    get READY_NOW_COVERAGE_FLOOR() {
        return READY_NOW_COVERAGE_FLOOR;
    }
    get READY_1_2Y_COVERAGE_FLOOR() {
        return READY_1_2Y_COVERAGE_FLOOR;
    }
    confidenceFrom(pct, coveragePct) {
        return confidenceFrom(pct, coveragePct);
    }
    nextReviewDue(from, months) {
        return nextReviewDue(from, months);
    }
    bandFromReadiness(pct, coveragePct) {
        return bandFromReadiness(pct, coveragePct);
    }
    scoreRows(rows) {
        return scoreRows(rows);
    }

    // ---- Critical roles ----------------------------------------------------
    // `roleIds` = null → org-wide (superadmin only). An array restricts the
    // coverage heatmap to the critical roles occupied by the caller's governed
    // employees, so a scoped manager/local-admin never sees org-wide succession
    // exposure. Empty array = fail closed (no rows).
    // business_impact and rationale are joined from role_criticality rather than
    // read from v_continuity_coverage: the view never exposed them, so the
    // business_impact the designation form writes had nowhere to be displayed.
    // A LEFT JOIN here avoids a view migration and cannot change any existing
    // column of the result.
    //
    // INCUMBENT PRIVACY. A role is in a scoped caller's list because one of
    // THEIR people occupies it — but the plan's incumbent may be somebody else
    // entirely (a peer's report, the caller's own manager). The view carries the
    // incumbent's retention verdict (incumbent_flight_risk / incumbent_impact_of_loss)
    // and id, so the role-scoped list leaked a flight-risk rating for people
    // outside the caller's governed span, and the caller's OWN rating, while
    // listPlans correctly hid the plan itself. `scope.governedIds` is the caller's
    // governed set and `scope.callerEmployeeId` the caller when they are an
    // employee: the three incumbent fields are nulled for any incumbent not in
    // the set, and always for the caller. A scoped call that supplies no span
    // fails CLOSED (all three nulled) — the bench/gap columns are unaffected.
    async listCoverage(roleIds = null, scope = null) {
        const select = `SELECT v.*, rc.business_impact AS "businessImpact", rc.rationale AS "rationale"
                        FROM v_continuity_coverage v
                        LEFT JOIN role_criticality rc ON rc.role_id = v.role_id`;
        const order = 'ORDER BY v.criticality_score DESC, v.has_coverage_gap DESC, v.role_name';
        if (roleIds === null) {
            return db.all(`${select} ${order}`);
        }
        if (!roleIds.length) return [];
        const ph = roleIds.map(() => '?').join(',');
        const rows = await db.all(`${select} WHERE v.role_id IN (${ph}) ${order}`, roleIds);
        return ContinuityService.maskIncumbents(rows, scope);
    }

    /** Null the incumbent's identity + retention verdict outside the caller's span (see listCoverage). */
    static maskIncumbents(rows, scope) {
        const governed =
            scope && Array.isArray(scope.governedIds)
                ? new Set(scope.governedIds.map(Number))
                : null;
        const self =
            scope && scope.callerEmployeeId != null ? Number(scope.callerEmployeeId) : null;
        return rows.map((r) => {
            const inc =
                r.incumbentEmployeeId != null
                    ? Number(r.incumbentEmployeeId)
                    : r.incumbent_employee_id != null
                      ? Number(r.incumbent_employee_id)
                      : null;
            if (inc == null) return r;
            const visible = governed !== null && governed.has(inc) && inc !== self;
            if (visible) return r;
            const masked = { ...r };
            for (const k of [
                'incumbentEmployeeId',
                'incumbent_employee_id',
                'incumbentFlightRisk',
                'incumbent_flight_risk',
                'incumbentImpactOfLoss',
                'incumbent_impact_of_loss',
            ]) {
                if (k in masked) masked[k] = null;
            }
            return masked;
        });
    }

    async setCriticality(
        roleId,
        { score, businessImpact, vacancyRisk, timeToFillDays, rationale },
        adminId = null
    ) {
        await db.run(
            `INSERT INTO role_criticality
               (role_id, criticality_score, business_impact, vacancy_risk, time_to_fill_days, rationale, designated_by)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (role_id) DO UPDATE SET
               criticality_score = EXCLUDED.criticality_score,
               business_impact   = EXCLUDED.business_impact,
               vacancy_risk      = EXCLUDED.vacancy_risk,
               time_to_fill_days = EXCLUDED.time_to_fill_days,
               rationale         = EXCLUDED.rationale,
               designated_by     = EXCLUDED.designated_by,
               updated_at        = now()`,
            [
                roleId,
                Number(score) || 3,
                businessImpact || null,
                vacancyRisk || 'medium',
                timeToFillDays != null ? Number(timeToFillDays) : null,
                rationale || null,
                adminId,
            ]
        );
        return db.get('SELECT * FROM role_criticality WHERE role_id = ?', [roleId]);
    }

    // ---- Plans -------------------------------------------------------------
    // `incumbentIds` = null → all open plans (superadmin only). An array limits
    // the list to plans whose incumbent is within the caller's governed set;
    // plans with no incumbent are omitted for scoped callers (they roll up to a
    // senior admin, same rule as canAccessPlan). Empty array = fail closed.
    async listPlans(incumbentIds = null) {
        if (incumbentIds !== null) {
            if (!incumbentIds.length) return [];
            const ph = incumbentIds.map(() => '?').join(',');
            return db.all(
                `SELECT sp.*, r.name AS role_name,
                        to_char(sp.review_due, 'YYYY-MM-DD') AS review_due_ymd,
                        (CURRENT_DATE - sp.review_due)       AS days_overdue,
                        e.first_name AS incumbent_first, e.last_name AS incumbent_last,
                        (SELECT COUNT(*) FROM successors s WHERE s.plan_id = sp.id) AS bench_depth
                 FROM succession_plans sp
                 JOIN roles r ON r.id = sp.position_role_id
                 LEFT JOIN employees e ON e.id = sp.incumbent_employee_id
                 WHERE sp.status <> 'archived'
                   AND sp.incumbent_employee_id IN (${ph})
                 ORDER BY sp.updated_at DESC`,
                incumbentIds
            );
        }
        return db.all(
            `SELECT sp.*, r.name AS role_name,
                    to_char(sp.review_due, 'YYYY-MM-DD') AS review_due_ymd,
                    (CURRENT_DATE - sp.review_due)       AS days_overdue,
                    e.first_name AS incumbent_first, e.last_name AS incumbent_last,
                    (SELECT COUNT(*) FROM successors s WHERE s.plan_id = sp.id) AS bench_depth
             FROM succession_plans sp
             JOIN roles r ON r.id = sp.position_role_id
             LEFT JOIN employees e ON e.id = sp.incumbent_employee_id
             WHERE sp.status <> 'archived'
             ORDER BY sp.updated_at DESC`
        );
    }

    async getPlan(planId) {
        const plan = await db.get(
            `SELECT sp.*, r.name AS role_name
             FROM succession_plans sp JOIN roles r ON r.id = sp.position_role_id
             WHERE sp.id = ?`,
            [planId]
        );
        if (!plan) return null;
        plan.successors = await db.all(
            `SELECT s.*, e.first_name, e.last_name, e.employee_number
             FROM successors s JOIN employees e ON e.id = s.candidate_employee_id
             WHERE s.plan_id = ?
             ORDER BY CASE s.readiness_band
                        WHEN 'ready_now' THEN 0 WHEN 'emergency' THEN 1
                        WHEN 'ready_1_2y' THEN 2 ELSE 3 END,
                      s.bench_rank NULLS LAST, e.last_name`,
            [planId]
        );
        plan.emergencyCover = await db.all(
            `SELECT ec.*, e.first_name, e.last_name
             FROM emergency_cover ec JOIN employees e ON e.id = ec.cover_employee_id
             WHERE ec.plan_id = ?`,
            [planId]
        );
        return plan;
    }

    /** Get-or-create the single open plan for a critical role. */
    async ensurePlan(roleId, { incumbentEmployeeId = null, ownerAdminId = null } = {}) {
        const existing = await db.get(
            "SELECT * FROM succession_plans WHERE position_role_id = ? AND status <> 'archived' LIMIT 1",
            [roleId]
        );
        if (existing) {
            // An older plan may predate the cadence — give it a due date so it
            // enters the review queue instead of drifting forever.
            if (!existing.reviewDue) {
                await db.run(
                    'UPDATE succession_plans SET review_due = ?, updated_at = now() WHERE id = ?',
                    [nextReviewDue(), existing.id]
                );
                existing.reviewDue = nextReviewDue();
            }
            return existing;
        }
        return db.get(
            `INSERT INTO succession_plans (position_role_id, incumbent_employee_id, owner_admin_id, status, review_due)
             VALUES (?, ?, ?, 'active', ?) RETURNING *`,
            [roleId, incumbentEmployeeId, ownerAdminId, nextReviewDue()]
        );
    }

    /**
     * Record that a plan has been reviewed: stamps who/when and pushes the next
     * review date out by the cadence. Returns the updated row, or null when no
     * open plan matched — never a bare {ok:true} that hides a zero-row update.
     */
    async markPlanReviewed(
        planId,
        reviewedByAdminId = null,
        { months = REVIEW_INTERVAL_MONTHS } = {}
    ) {
        const row = await db.get(
            `UPDATE succession_plans
                SET last_reviewed_at = now(),
                    reviewed_by      = ?,
                    review_due       = ?,
                    updated_at       = now()
              WHERE id = ? AND status <> 'archived'
              RETURNING *`,
            [reviewedByAdminId, nextReviewDue(new Date(), months), Number(planId)]
        );
        return row || null;
    }

    /** Explicitly set (or clear) the next review date of an open plan. */
    async setReviewDue(planId, reviewDue) {
        const row = await db.get(
            `UPDATE succession_plans SET review_due = ?, updated_at = now()
              WHERE id = ? AND status <> 'archived' RETURNING *`,
            [reviewDue || null, Number(planId)]
        );
        return row || null;
    }

    async setIncumbent(planId, incumbentEmployeeId) {
        await db.run(
            'UPDATE succession_plans SET incumbent_employee_id = ?, updated_at = now() WHERE id = ?',
            [incumbentEmployeeId || null, planId]
        );
    }

    async archivePlan(planId) {
        await db.run(
            "UPDATE succession_plans SET status = 'archived', updated_at = now() WHERE id = ?",
            [planId]
        );
    }

    // ---- Cadence + "where do I start" queue --------------------------------
    // Succession only works if something PROMPTS a leader. These three queries
    // are the prompts: roles nobody has scored, critical roles with an empty
    // bench, and plans whose review date has come round.

    /** Resolve the caller's succession scope once (mirrors the /v2/continuity view rules). */
    async _scopeFor(user) {
        const RBACService = require('./RBACService');
        const isSuper = !!(RBACService.isSuperAdmin && RBACService.isSuperAdmin(user));
        if (isSuper) return { isSuper: true, govIds: null, govRoleIds: null };
        const governed = await RBACService.getFilteredEmployees(user);
        return {
            isSuper: false,
            govIds: governed.map((e) => Number(e.id)).filter(Boolean),
            govRoleIds: [...new Set(governed.map((e) => Number(e.roleId)).filter(Boolean))],
        };
    }

    /**
     * Plans whose review date has arrived (or passed). `user` scopes the list the
     * same way listPlans does: superadmin sees all, anyone else only plans whose
     * incumbent is in their governed set (a plan with no incumbent rolls up).
     */
    async plansDueForReview(user) {
        const { isSuper, govIds } = await this._scopeFor(user);
        return this.listPlansDue(isSuper ? null : govIds);
    }

    /** `incumbentIds` = null → org-wide; [] → fail closed (no rows). */
    async listPlansDue(incumbentIds = null) {
        if (incumbentIds !== null && !incumbentIds.length) return [];
        const scope =
            incumbentIds === null
                ? ''
                : `AND sp.incumbent_employee_id IN (${incumbentIds.map(() => '?').join(',')})`;
        return db.all(
            `SELECT sp.id, sp.position_role_id, sp.status, sp.incumbent_employee_id,
                    -- owner_admin_id is the fallback recipient for the weekly
                    -- succession-review tick when a plan has no incumbent (and so
                    -- no manager to nudge). Additive to the existing selection.
                    sp.owner_admin_id,
                    to_char(sp.review_due, 'YYYY-MM-DD')      AS review_due_ymd,
                    to_char(sp.last_reviewed_at, 'YYYY-MM-DD') AS last_reviewed_ymd,
                    (CURRENT_DATE - sp.review_due)            AS days_overdue,
                    r.name AS role_name,
                    e.first_name AS incumbent_first, e.last_name AS incumbent_last,
                    (SELECT COUNT(*) FROM successors s WHERE s.plan_id = sp.id) AS bench_depth,
                    (SELECT COUNT(*) FROM successors s2
                      WHERE s2.plan_id = sp.id AND s2.readiness_band = 'ready_now') AS ready_now_count
               FROM succession_plans sp
               JOIN roles r ON r.id = sp.position_role_id
               LEFT JOIN employees e ON e.id = sp.incumbent_employee_id
              WHERE sp.status <> 'archived'
                AND sp.review_due IS NOT NULL
                AND sp.review_due <= CURRENT_DATE
                ${scope}
              ORDER BY sp.review_due, r.name`,
            incumbentIds === null ? [] : incumbentIds
        );
    }

    /**
     * Roles that are occupied but have never been scored for criticality — the
     * very first step of succession (role_criticality = 0 means nothing else can
     * even start). `roleIds` = null → org-wide; [] → fail closed.
     */
    async rolesNeedingCriticality(roleIds = null, { limit = 25 } = {}) {
        if (roleIds !== null && !roleIds.length) return [];
        const scope = roleIds === null ? '' : `AND r.id IN (${roleIds.map(() => '?').join(',')})`;
        return db.all(
            `SELECT r.id AS role_id, r.name AS role_name,
                    (SELECT COUNT(*) FROM employees e
                      WHERE e.role_id = r.id AND e.is_active = true) AS occupant_count
               FROM roles r
              WHERE r.is_active = true
                AND NOT EXISTS (SELECT 1 FROM role_criticality rc WHERE rc.role_id = r.id)
                AND EXISTS (SELECT 1 FROM employees e2 WHERE e2.role_id = r.id AND e2.is_active = true)
                ${scope}
              ORDER BY occupant_count DESC, r.name
              LIMIT ${Number(limit) > 0 ? Number(limit) : 25}`,
            roleIds === null ? [] : roleIds
        );
    }

    /** How many occupied roles are still unscored (the list above is capped). */
    async countRolesNeedingCriticality(roleIds = null) {
        if (roleIds !== null && !roleIds.length) return 0;
        const scope = roleIds === null ? '' : `AND r.id IN (${roleIds.map(() => '?').join(',')})`;
        const row = await db.get(
            `SELECT COUNT(*) AS n
               FROM roles r
              WHERE r.is_active = true
                AND NOT EXISTS (SELECT 1 FROM role_criticality rc WHERE rc.role_id = r.id)
                AND EXISTS (SELECT 1 FROM employees e2 WHERE e2.role_id = r.id AND e2.is_active = true)
                ${scope}`,
            roleIds === null ? [] : roleIds
        );
        return Number((row && row.n) || 0);
    }

    /**
     * Critical roles whose bench is empty — either no plan at all, or a plan with
     * zero successors named. This is the "successors = 0" hole made visible.
     */
    /**
     * `criticality_score` is a 1-5 scale (CHECK on role_criticality). "Critical"
     * has to mean the upper end of it: counting EVERY role that merely has a
     * criticality row — score 1 included — inflated the "critical posts with no
     * successor" figure on the continuity dashboard, the Commencer counter and the
     * monthly brief, all of which are read as a statement of key-person exposure.
     */
    static get CRITICAL_SCORE_MIN() {
        return 4;
    }

    async criticalRolesWithoutSuccessor(roleIds = null) {
        if (roleIds !== null && !roleIds.length) return [];
        const scope =
            roleIds === null ? '' : `AND rc.role_id IN (${roleIds.map(() => '?').join(',')})`;
        return db.all(
            `SELECT rc.role_id, r.name AS role_name, rc.criticality_score, rc.vacancy_risk,
                    sp.id AS plan_id, sp.status AS plan_status,
                    e.first_name AS incumbent_first, e.last_name AS incumbent_last,
                    (SELECT COUNT(*) FROM employees emp
                      WHERE emp.role_id = rc.role_id AND emp.is_active = true) AS occupant_count
               FROM role_criticality rc
               JOIN roles r ON r.id = rc.role_id
               LEFT JOIN succession_plans sp
                      ON sp.position_role_id = rc.role_id AND sp.status <> 'archived'
               LEFT JOIN employees e ON e.id = sp.incumbent_employee_id
              WHERE rc.criticality_score >= ${ContinuityService.CRITICAL_SCORE_MIN}
                AND (sp.id IS NULL
                     OR NOT EXISTS (SELECT 1 FROM successors s WHERE s.plan_id = sp.id))
                ${scope}
              ORDER BY rc.criticality_score DESC, r.name`,
            roleIds === null ? [] : roleIds
        );
    }

    /**
     * Everything the « Commencer » panel needs, in one scoped call: what to
     * score, what has no successor, and what is due for review.
     */
    async gettingStarted(user, scope = null) {
        // `scope` lets a caller that already resolved the RBAC span (the /v2/continuity
        // page does) reuse it instead of paying for a second getFilteredEmployees.
        const { isSuper, govIds, govRoleIds } = scope || (await this._scopeFor(user));
        const [needCriticality, needCriticalityTotal, noSuccessor, dueForReview] =
            await Promise.all([
                this.rolesNeedingCriticality(isSuper ? null : govRoleIds),
                this.countRolesNeedingCriticality(isSuper ? null : govRoleIds),
                this.criticalRolesWithoutSuccessor(isSuper ? null : govRoleIds),
                this.listPlansDue(isSuper ? null : govIds),
            ]);
        return {
            needCriticality, // capped list (see rolesNeedingCriticality)
            needCriticalityTotal, // true count behind that list
            noSuccessor,
            dueForReview,
            // A role can be BOTH without a successor and overdue for review; adding
            // the three lists counted it twice and overstated the work outstanding.
            // Count distinct roles/plans instead.
            total:
                needCriticalityTotal +
                new Set([
                    ...noSuccessor.map((r) => `role:${r.roleId ?? r.role_id}`),
                    ...dueForReview.map(
                        (p) =>
                            `role:${p.positionRoleId ?? p.position_role_id ?? 'plan:' + (p.id ?? '')}`
                    ),
                ]).size,
            reviewIntervalMonths: REVIEW_INTERVAL_MONTHS,
        };
    }

    // ---- Readiness against a target role -----------------------------------
    /**
     * Returns { pct, gaps:[{skillId,skillName,required,current}], assessed, unmeasured,
     * required, coveragePct } for a candidate vs a role.
     *
     * pct is the ASSESSED-ONLY, points-based readiness — the same number
     * ReadinessService / v_employee_assessment_coverage.readiness_assessed_only
     * publish — and null when nothing was assessed. It used to COALESCE an
     * absent level to 0 over the whole requirement set: a candidate measured on
     * 51 of 63 requirements at 91 % was benched at 74 % (ready_1_2y) with 12
     * fabricated "current: 0" gaps, and a never-assessed candidate scored 0 %
     * with 63 gaps. The never-assessed requirements stay in `gaps` with
     * `current: null` and are counted in `unmeasured`; `required` is the full
     * department-designed count.
     */
    async readinessForRole(employeeId, roleId) {
        // A LAPSED statutory certificate degrades the qualification to 0 for that
        // skill (migration 78 / v_certification_lapsed): an expired ticket means the
        // candidate may not perform the task today, so the bench must not call them
        // ready. The requirement rows themselves are untouched — same skills, same
        // count; only the level they count at moves. `assessed_level` is the raw
        // assessment: a lapse degrades the level, never the fact of measurement.
        const rows = await db.all(
            `SELECT rsr.skill_id AS skill_id, s.name AS skill_name,
                    rsr.required_level AS required,
                    sa.level AS assessed_level,
                    CASE WHEN cl.employee_id IS NOT NULL THEN 0
                         ELSE sa.level END AS current
             FROM role_skill_requirements rsr
             JOIN skills s ON s.id = rsr.skill_id
             LEFT JOIN v_resolved_assessments sa ON sa.skill_id = rsr.skill_id AND sa.employee_id = ?
             LEFT JOIN v_certification_lapsed cl ON cl.skill_id = rsr.skill_id AND cl.employee_id = ?
             WHERE rsr.role_id = ? AND rsr.required_level > 0`,
            [employeeId, employeeId, roleId]
        );
        if (!rows.length)
            return {
                pct: null,
                gaps: [],
                assessed: 0,
                unmeasured: 0,
                required: 0,
                coveragePct: null,
            };
        return scoreRows(rows);
    }

    // ---- Successors / bench ------------------------------------------------
    /**
     * Auto-seed the bench from a candidate pool (employees in the owner's scope,
     * excluding the incumbent). Inserts/refreshes auto candidates with readiness
     * >= floor; never touches manually-added successors.
     */
    async seedSuccessors(
        planId,
        candidateEmployeeIds,
        { floorPct = 50, limit = 10, nominatedBy = null } = {}
    ) {
        const plan = await db.get(
            'SELECT position_role_id, incumbent_employee_id FROM succession_plans WHERE id = ?',
            [planId]
        );
        if (!plan) return { added: 0 };

        // ONE set-based pass over the whole candidate pool.
        //
        // This used to be `for (const empId of candidateEmployeeIds) await
        // this.readinessForRole(...)` — a 3-way join per candidate. The only
        // caller (POST /api/v2/continuity/plan/:id/seed) passes EVERY employee
        // the requester governs, so for a superadmin on a 4 000-person estate
        // that was 4 000 sequential round-trips for one HTTP request.
        //
        // The arithmetic below is readinessForRole's (scoreRows), unchanged and
        // still per-candidate: points-based SUM(LEAST(current, required)) /
        // SUM(required) over the ASSESSED requirements, a lapsed statutory
        // certificate degrading that skill to 0 (migration 78 /
        // v_certification_lapsed), and the full department-designed requirement
        // list for the role — `required_level > 0` is the identical predicate,
        // nothing is sampled or capped. A candidate with NO assessed requirement
        // has no readiness (pct null) and is never seeded: an empty record is
        // not a 0 % candidate, and a bench built on zero measurement is not a bench.
        const uniqueIds = [
            ...new Set(
                (candidateEmployeeIds || [])
                    .map(Number)
                    .filter((n) => Number.isFinite(n) && n !== Number(plan.incumbentEmployeeId))
            ),
        ];
        if (!uniqueIds.length) return { added: 0 };

        const rows = await db.all(
            `SELECT cand.id AS employee_id,
                    rsr.skill_id AS skill_id, s.name AS skill_name,
                    rsr.required_level AS required,
                    sa.level AS assessed_level,
                    CASE WHEN cl.employee_id IS NOT NULL THEN 0
                         ELSE sa.level END AS current
             FROM unnest(?::bigint[]) AS cand(id)
             JOIN role_skill_requirements rsr ON rsr.role_id = ? AND rsr.required_level > 0
             JOIN skills s ON s.id = rsr.skill_id
             LEFT JOIN v_resolved_assessments sa
                    ON sa.skill_id = rsr.skill_id AND sa.employee_id = cand.id
             LEFT JOIN v_certification_lapsed cl
                    ON cl.skill_id = rsr.skill_id AND cl.employee_id = cand.id`,
            [uniqueIds, plan.positionRoleId]
        );

        const byCandidate = new Map(); // employeeId -> rows
        for (const id of uniqueIds) byCandidate.set(id, []);
        for (const r of rows) {
            const list = byCandidate.get(Number(r.employeeId));
            if (list) list.push(r);
        }

        const scored = [];
        let unmeasuredCandidates = 0;
        for (const [empId, candRows] of byCandidate) {
            const s = scoreRows(candRows);
            if (s.pct == null) {
                unmeasuredCandidates++;
                continue;
            }
            if ((s.pctExact ?? s.pct) >= floorPct) scored.push({ empId, ...s });
        }
        // Coverage-aware ranking, identical to BenchmarkModel.getRoleCandidates
        // so the bench and the benchmark candidate list cannot disagree about who
        // ranks first. pct is computed over the ASSESSED requirements only, so it
        // says nothing about HOW MUCH of the role was measured: sorting by pct
        // alone seated a candidate measured on 4 of 63 requirements (100 % of
        // those four) above fully-evidenced Ready-Now candidates, who were then
        // cut by `limit`. Adequately-measured candidates (coverage >= the
        // ready-now floor) now rank first; within that, higher fit wins; coverage
        // breaks a fit tie so the better-evidenced candidate leads.
        const meetsFloor = (c) =>
            c.coveragePct != null && c.coveragePct >= READY_NOW_COVERAGE_FLOOR;
        scored.sort((a, b) => {
            const fa = meetsFloor(a) ? 1 : 0;
            const fb = meetsFloor(b) ? 1 : 0;
            if (fa !== fb) return fb - fa;
            const pa = a.pctExact ?? a.pct;
            const pb = b.pctExact ?? b.pct;
            if (pb !== pa) return pb - pa;
            return (b.coveragePct ?? 0) - (a.coveragePct ?? 0);
        });
        const top = scored.slice(0, limit);
        let added = 0;
        for (let i = 0; i < top.length; i++) {
            const c = top[i];
            const band = bandFromReadiness(c.pctExact ?? c.pct, c.coveragePct);
            await db.run(
                `INSERT INTO successors (plan_id, candidate_employee_id, readiness_band, bench_rank, source, confidence, gap_summary, nominated_by, nominated_at)
                 VALUES (?, ?, ?, ?, 'auto_readiness', ?, ?, ?, now())
                 ON CONFLICT (plan_id, candidate_employee_id) DO UPDATE SET
                   readiness_band = CASE WHEN successors.source = 'manual' THEN successors.readiness_band ELSE EXCLUDED.readiness_band END,
                   bench_rank     = CASE WHEN successors.source = 'manual' THEN successors.bench_rank ELSE EXCLUDED.bench_rank END,
                   confidence     = EXCLUDED.confidence,
                   gap_summary    = EXCLUDED.gap_summary,
                   nominated_by   = COALESCE(successors.nominated_by, EXCLUDED.nominated_by),
                   nominated_at   = COALESCE(successors.nominated_at, EXCLUDED.nominated_at),
                   updated_at     = now()`,
                [
                    planId,
                    c.empId,
                    band,
                    i + 1,
                    confidenceFrom(c.pct, c.coveragePct),
                    JSON.stringify(c.gaps),
                    nominatedBy,
                ]
            );
            added++;
        }
        return { added, unmeasuredCandidates };
    }

    async addSuccessor(planId, employeeId, nominatedBy = null) {
        const plan = await db.get('SELECT position_role_id FROM succession_plans WHERE id = ?', [
            planId,
        ]);
        if (!plan) throw new Error('Plan not found');
        const r = await this.readinessForRole(employeeId, plan.positionRoleId);
        return db.get(
            `INSERT INTO successors (plan_id, candidate_employee_id, readiness_band, source, confidence, gap_summary, nominated_by, nominated_at)
             VALUES (?, ?, ?, 'manual', ?, ?, ?, now())
             ON CONFLICT (plan_id, candidate_employee_id) DO UPDATE SET
               source = 'manual', confidence = EXCLUDED.confidence, gap_summary = EXCLUDED.gap_summary,
               nominated_by = COALESCE(EXCLUDED.nominated_by, successors.nominated_by),
               nominated_at = COALESCE(successors.nominated_at, EXCLUDED.nominated_at),
               updated_at = now()
             RETURNING *`,
            [
                planId,
                employeeId,
                bandFromReadiness(r.pctExact ?? r.pct, r.coveragePct),
                confidenceFrom(r.pct, r.coveragePct),
                JSON.stringify(r.gaps),
                nominatedBy,
            ]
        );
    }

    async setSuccessorBand(successorId, band) {
        await db.run(
            "UPDATE successors SET readiness_band = ?, source = 'manual', updated_at = now() WHERE id = ?",
            [band, successorId]
        );
    }

    async removeSuccessor(successorId) {
        await db.run('DELETE FROM successors WHERE id = ?', [successorId]);
    }

    /**
     * The single best-placed successor for a role — the bench's top name.
     *
     * Ordering mirrors getPlan: readiness band first (ready_now → emergency →
     * ready_1_2y → ready_3y), then the manually curated bench_rank, then the
     * computed confidence, then id for determinism. Inactive candidates are
     * excluded (a bench entry outlives the person leaving), and the outgoing
     * employee can never succeed themselves.
     *
     * This is what lets an auto-created handover plan arrive with a NAMED
     * incoming person instead of an empty shell: LifecycleService._ensureHandover
     * calls it on every leaver/mover. Returns an employee id, or null when the
     * role has no plan, no bench, or only inactive candidates.
     */
    async topSuccessorForRole(roleId, { excludeEmployeeId = null } = {}) {
        if (!roleId) return null;
        // Branch rather than pass a bare `? IS NULL` — Postgres cannot infer the
        // parameter type there ("could not determine data type"), the same trap
        // HandoverService.ensureForEvent documents.
        const exclude = Number(excludeEmployeeId) || null;
        const row = await db.get(
            `SELECT s.candidate_employee_id AS candidate_id
               FROM successors s
               JOIN succession_plans sp ON sp.id = s.plan_id
               JOIN employees e ON e.id = s.candidate_employee_id
              WHERE sp.position_role_id = ?
                AND sp.status <> 'archived'
                AND e.is_active = true
                ${exclude ? 'AND s.candidate_employee_id <> ?' : ''}
              ORDER BY CASE s.readiness_band
                         WHEN 'ready_now' THEN 0 WHEN 'emergency' THEN 1
                         WHEN 'ready_1_2y' THEN 2 ELSE 3 END,
                       s.bench_rank NULLS LAST, s.confidence DESC NULLS LAST, s.id
              LIMIT 1`,
            exclude ? [roleId, exclude] : [roleId]
        );
        return row ? Number(row.candidateId) || null : null;
    }

    async setEmergencyCover(planId, employeeId, note, adminId = null) {
        return db.get(
            `INSERT INTO emergency_cover (plan_id, cover_employee_id, note, designated_by)
             VALUES (?, ?, ?, ?) RETURNING *`,
            [planId, employeeId, note || null, adminId]
        );
    }
}

module.exports = new ContinuityService();
