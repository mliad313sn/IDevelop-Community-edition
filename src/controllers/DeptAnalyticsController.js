'use strict';

/**
 * DeptAnalyticsController — departmental analytics for the dashboard/reports:
 *
 *   GET /reports/dept-analytics                    page (EJS + Chart.js)
 *   GET /api/analytics/department-completion       Site → Dept matrix completion %
 *   GET /api/analytics/ninebox-by-department       current 9-box distribution by dept
 *   GET /api/analytics/perf-actions-trend          monthly counts + MoM deltas for
 *                                                  PIP / IDP / coaching / mentoring /
 *                                                  self-assessment actions
 *
 * RBAC: every query is scoped BEFORE aggregation, the same way the Power BI
 * feeds are — SuperAdmin sees everything, a local admin/viewer sees only the
 * employees inside their assigned scopes, a manager sees only their governed
 * sub-tree. Scoping is done by employee id against the row-level views
 * (v_employee_skill_gaps / v_ninebox_current / v_perf_actions), so a person
 * outside the caller's clearance can never influence a returned number.
 * Deactivated employees are excluded by the views themselves (they all derive
 * from v_employee_details WHERE is_active = true).
 */

const db = require('../config/database');
// Shared "scope before aggregate" helpers (also used by the compliance layer).
const { scopedEmployeeIds, scopeClause } = require('../utils/rbacScope');

class DeptAnalyticsController {
    /** Page shell — the charts fetch their JSON from the endpoints below. */
    async page(req, res) {
        res.render('pages/reports/dept-analytics', {
            title: req.t ? req.t('compliance:da_title') : 'Analytique départementale',
        });
    }

    /**
     * Skill-matrix completion % grouped Site → Department.
     * completion = assessed required (employee, skill) cells / total required cells.
     * met        = met cells / ASSESSED cells — NULL when nothing was assessed.
     *
     * v_employee_skill_gaps sets is_met = 0 for a never-assessed cell (the view
     * coalesces an absent level to 0), so met / ALL cells plotted a department
     * nobody had measured as a solid "0 % met" bar — 794 unmeasured cells counted
     * as failures. The unmeasured cells are returned as their own quantity so the
     * chart can plot them as their own series.
     */
    async departmentCompletion(req, res) {
        try {
            const ids = await scopedEmployeeIds(req.user);
            const params = [];
            const rows = await db.all(
                `SELECT g.site_id      AS "siteId",
                        g.site_name    AS "siteName",
                        g.department_id   AS "departmentId",
                        g.department_name AS "departmentName",
                        COUNT(DISTINCT g.employee_id)::int AS headcount,
                        COUNT(*)::int                      AS "requiredCells",
                        SUM(g.is_assessed)::int            AS "assessedCells",
                        (COUNT(*) - SUM(g.is_assessed))::int AS "unmeasuredCells",
                        ROUND(100.0 * SUM(g.is_assessed) / NULLIF(COUNT(*), 0), 1)::float AS "completionPct",
                        ROUND(100.0 * (COUNT(*) - SUM(g.is_assessed)) / NULLIF(COUNT(*), 0), 1)::float AS "unmeasuredPct",
                        ROUND(100.0 * SUM(g.is_met)     / NULLIF(SUM(g.is_assessed), 0), 1)::float AS "metPct"
                   FROM v_employee_skill_gaps g
                  WHERE 1 = 1${scopeClause(ids, params, 'g.employee_id')}
                  GROUP BY g.site_id, g.site_name, g.department_id, g.department_name
                  ORDER BY g.site_name, g.department_name`,
                params
            );
            res.json({ departments: rows });
        } catch (e) {
            console.error('department-completion error:', e);
            res.status(500).json({ error: 'Failed to compute departmental completion' });
        }
    }

    /** Current (latest approved) 9-box distribution per department: dept × box counts. */
    async nineboxByDepartment(req, res) {
        try {
            const ids = await scopedEmployeeIds(req.user);
            const params = [];
            const rows = await db.all(
                `SELECT nb.site_id        AS "siteId",
                        nb.site_name      AS "siteName",
                        nb.department_id   AS "departmentId",
                        nb.department_name AS "departmentName",
                        nb.box,
                        COUNT(*)::int AS n
                   FROM v_ninebox_current nb
                  WHERE 1 = 1${scopeClause(ids, params, 'nb.employee_id')}
                  GROUP BY nb.site_id, nb.site_name, nb.department_id, nb.department_name, nb.box
                  ORDER BY nb.site_name, nb.department_name, nb.box`,
                params
            );
            // Pivot to { department, boxes: {1..9} } — the shape the stacked chart wants.
            const byDept = new Map();
            for (const r of rows) {
                const key = `${r.siteName} / ${r.departmentName}`;
                if (!byDept.has(key)) {
                    byDept.set(key, {
                        siteId: r.siteId,
                        siteName: r.siteName,
                        departmentId: r.departmentId,
                        departmentName: r.departmentName,
                        boxes: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0 },
                        total: 0,
                    });
                }
                const d = byDept.get(key);
                d.boxes[r.box] = r.n;
                d.total += r.n;
            }
            res.json({ departments: [...byDept.values()] });
        } catch (e) {
            console.error('ninebox-by-department error:', e);
            res.status(500).json({ error: 'Failed to compute 9-box distribution' });
        }
    }

    /**
     * Campaign burndown by department: for the current OPEN cycle (or
     * ?cycleId=), per-department participation counts and completion %.
     *
     * Built on the launch-stamped ROSTER (v_cycle_participant_status, migration
     * 70) exactly like DashboardService.getCampaignFunnel — never on
     * self_assessments, whose per-SKILL rows only exist once somebody has acted.
     * The old denominator counted skill rows of the people who had engaged, so a
     * 78-person campaign across 10 departments rendered as ONE department with
     * "participants: 1, total: 45" and the nine departments nobody had started
     * simply vanished. Now every department the caller can see is a row: the
     * people asked are `enrolled`, a department where nobody moved reads 0 %,
     * and one that was never launched reads NULL (`launched: false`).
     * "Completion" = people submitted or approved / people enrolled.
     */
    async campaignBurndown(req, res) {
        try {
            const ids = await scopedEmployeeIds(req.user);
            let cycle;
            if (req.query.cycleId) {
                cycle = await db.get(
                    'SELECT id, code, label, opened_at AS "openedAt", closes_at AS "closesAt", status FROM assessment_cycles WHERE id = ?',
                    [parseInt(req.query.cycleId, 10)]
                );
            } else {
                // Open first, else the most recent LOCKED campaign — the review
                // phase is still the campaign; one shared resolver.
                cycle = await require('../services/CycleService').findCurrent();
            }
            if (!cycle) return res.json({ cycle: null, departments: [] });

            // Departments = those holding at least one ACTIVE employee the caller
            // may see (a scoped manager never learns about departments outside
            // their span); the roster is LEFT-joined so a department with no
            // participant still appears, as "not launched", instead of vanishing.
            const params = [];
            const deptScope = scopeClause(ids, params, 'ed.employee_id');
            params.push(cycle.id);
            const rosterScope = scopeClause(ids, params, 'v.employee_id');
            const rows = await db.all(
                `SELECT s.name AS "siteName", d.id AS "departmentId", d.name AS "departmentName",
                        COUNT(v.employee_id) FILTER (WHERE v.participant_state <> 'excluded')::int AS enrolled,
                        COUNT(v.employee_id) FILTER (WHERE v.participant_state <> 'excluded')::int AS participants,
                        COUNT(v.employee_id) FILTER (WHERE v.participant_state = 'excluded')::int AS excluded,
                        COUNT(v.employee_id) FILTER (WHERE v.participant_state = 'approved')::int AS approved,
                        COUNT(v.employee_id) FILTER (WHERE v.participant_state = 'in_review')::int AS "inReview",
                        COUNT(v.employee_id) FILTER (WHERE v.participant_state = 'in_progress')::int AS "inProgress",
                        COUNT(v.employee_id) FILTER (WHERE v.participant_state = 'not_started')::int AS "notStarted",
                        COUNT(v.employee_id) FILTER (WHERE v.participant_state IN ('not_started','in_progress'))::int AS unsubmitted,
                        ROUND(100.0 * COUNT(v.employee_id) FILTER (WHERE v.participant_state IN ('in_review','approved'))
                              / NULLIF(COUNT(v.employee_id) FILTER (WHERE v.participant_state <> 'excluded'), 0), 1)::float AS "completionPct"
                   FROM departments d
                   JOIN sites s ON s.id = d.site_id
                   LEFT JOIN v_cycle_participant_status v
                          ON v.department_id = d.id AND v.cycle_id = ?${rosterScope}
                  WHERE d.id IN (SELECT ed.department_id FROM v_employee_details ed WHERE 1 = 1${deptScope})
                  GROUP BY s.name, d.id, d.name
                  -- Bare on purpose: the compat layer (sql-compat quoteCamelAliases)
                  -- quotes camelCase identifiers inside ORDER BY / GROUP BY, so this
                  -- reaches PostgreSQL as "completionPct" and matches the alias above.
                  ORDER BY completionPct ASC NULLS LAST, d.name`,
                params
            );
            res.json({
                cycle: {
                    ...cycle,
                    daysLeft: Math.ceil((new Date(cycle.closesAt) - Date.now()) / 86400000),
                },
                departments: rows.map((r) => ({ ...r, launched: Number(r.enrolled) > 0 })),
            });
        } catch (e) {
            console.error('campaign-burndown error:', e);
            res.status(500).json({ error: 'Failed to compute campaign burndown' });
        }
    }

    /**
     * Team progression rollup: monthly average CONFIRMED skill level per
     * department (trailing ?months=, default 12) — the org-level view of the
     * per-employee progression curves.
     */
    async teamProgression(req, res) {
        try {
            const months = Math.min(Math.max(parseInt(req.query.months, 10) || 12, 2), 36);
            const ids = await scopedEmployeeIds(req.user);
            const params = [String(months)];
            const scope = scopeClause(ids, params, 'tl.employee_id');
            const rows = await db.all(
                `SELECT tl.month,
                        ed.department_id AS "departmentId",
                        ed.site_name || ' / ' || ed.department_name AS "departmentLabel",
                        ROUND(AVG(tl.avg_level), 2)::float AS "avgLevel",
                        SUM(tl.assessments)::int AS assessments
                   FROM v_employee_level_timeline tl
                   JOIN v_employee_details ed ON ed.employee_id = tl.employee_id
                  WHERE tl.month >= to_char(date_trunc('month', now()) - (? || ' months')::interval, 'YYYY-MM')
                        ${scope}
                  GROUP BY tl.month, ed.department_id, ed.site_name, ed.department_name
                  ORDER BY tl.month, departmentLabel`,
                params
            );
            res.json({ months, rows });
        } catch (e) {
            console.error('team-progression error:', e);
            res.status(500).json({ error: 'Failed to compute team progression' });
        }
    }

    /**
     * Monthly performance-action counts (PIP / IDP / coaching / mentoring /
     * self-assessment) for the trailing N months (?months=, default 12, max 36),
     * plus current-month totals with month-over-month deltas.
     */
    async perfActionsTrend(req, res) {
        try {
            const months = Math.min(Math.max(parseInt(req.query.months, 10) || 12, 2), 36);
            const ids = await scopedEmployeeIds(req.user);
            const params = [String(months)];
            const rows = await db.all(
                `SELECT to_char(date_trunc('month', pa.occurred_at), 'YYYY-MM') AS month,
                        pa.action_type AS "actionType",
                        COUNT(*)::int  AS n
                   FROM v_perf_actions pa
                  WHERE pa.occurred_at >= date_trunc('month', now()) - (? || ' months')::interval
                        ${scopeClause(ids, params, 'pa.employee_id')}
                  GROUP BY 1, 2
                  ORDER BY 1, 2`,
                params
            );

            // Dense month axis (missing months = 0) so Chart.js lines don't skip.
            const axis = [];
            const cursor = new Date();
            cursor.setDate(1);
            cursor.setMonth(cursor.getMonth() - (months - 1));
            for (let i = 0; i < months; i++) {
                axis.push(
                    `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`
                );
                cursor.setMonth(cursor.getMonth() + 1);
            }
            const types = ['pip', 'idp', 'coaching', 'mentoring', 'self_assessment'];
            const series = Object.fromEntries(types.map((t) => [t, axis.map(() => 0)]));
            for (const r of rows) {
                const i = axis.indexOf(r.month);
                if (i >= 0 && series[r.actionType]) series[r.actionType][i] = r.n;
            }

            // Current month vs previous month (MoM).
            const cur = axis.length - 1;
            const prev = axis.length - 2;
            const currentMonth = types.map((t) => {
                const now = series[t][cur] || 0;
                const before = prev >= 0 ? series[t][prev] || 0 : 0;
                return {
                    actionType: t,
                    count: now,
                    previous: before,
                    delta: now - before,
                    deltaPct: before > 0 ? Math.round(((now - before) / before) * 1000) / 10 : null,
                };
            });

            res.json({ months: axis, series, currentMonth });
        } catch (e) {
            console.error('perf-actions-trend error:', e);
            res.status(500).json({ error: 'Failed to compute performance-action trends' });
        }
    }
}

module.exports = new DeptAnalyticsController();
