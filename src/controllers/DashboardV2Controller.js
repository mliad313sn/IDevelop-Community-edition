'use strict';

const db = require('../config/database');
// Shared "scope before aggregate" helpers — the same resolution every analytics
// query and Power BI feed uses (SuperAdmin unrestricted, manager/supervisor →
// governed sub-tree, local admin/viewer → assigned scopes).
const { scopedEmployeeIds, scopeClause } = require('../utils/rbacScope');

/**
 * Every widget here used to aggregate ORG-WIDE with no employee scope, so a
 * manager with 16 reports was shown numbers built from people outside their
 * span (live: the "training uplift" card on a manager's dashboard came from an
 * erased employee they had never governed). Each query now filters by employee
 * id BEFORE the GROUP BY, and an empty span yields an empty result — never the
 * org number inherited by default.
 */
class DashboardV2Controller {
    static async biasMonitor(req, res) {
        const ids = await scopedEmployeeIds(req.user);
        // bias_alerts is keyed by (cycle, group) — site / department / … — not by
        // person. A scoped caller is therefore shown only the alerts on groups
        // whose members they govern (site or department of a governed employee);
        // an alert on a dimension that cannot be mapped to people (e.g. gender)
        // is org-level statistics and stays with the unrestricted caller only.
        const params = [];
        let where = '';
        if (ids !== null) {
            if (!ids.length) return res.json({ rows: [], scoped: true });
            const ph = ids.map(() => '?').join(',');
            params.push(...ids, ...ids);
            // BiasDetectionService stores the site / department ID (as text) in
            // group_value, never the name: comparing names hid every alert from
            // scoped readers. Nationality / gender alerts are org-wide by design.
            where = ` WHERE (b.group_dim = 'site' AND b.group_value IN (SELECT DISTINCT e.site_id::text FROM employees e WHERE e.id IN (${ph}) AND e.site_id IS NOT NULL))
                       OR (b.group_dim = 'department' AND b.group_value IN (SELECT DISTINCT e.department_id::text FROM employees e WHERE e.id IN (${ph}) AND e.department_id IS NOT NULL))`;
        }
        const rows = await db.all(
            `SELECT b.cycle_id, b.group_dim, b.group_value, b.z_score, b.state
             FROM bias_alerts b${where} ORDER BY b.raised_at DESC LIMIT 50`,
            params
        );
        res.json({ rows, scoped: ids !== null });
    }

    static async cycleCountdown(req, res) {
        const c = await db.get(
            `SELECT id, code, label, closes_at, status
             FROM assessment_cycles WHERE status = 'open' ORDER BY closes_at LIMIT 1`
        );
        if (!c) return res.json({ active: false });
        const ms = new Date(c.closesAt || c.closes_at).getTime() - Date.now();
        res.json({
            active: true,
            cycle: c,
            daysRemaining: Math.max(0, Math.ceil(ms / 86_400_000)),
        });
    }

    static async actionEffectiveness(req, res) {
        const ids = await scopedEmployeeIds(req.user);
        const params = [];
        const scope = scopeClause(ids, params, 'p.employee_id');
        // Scoped to the plans of the caller's people. An action with NO
        // action_effectiveness row yet is the caller's own UNMEASURED work and is
        // reported as such (`unmeasured`), never averaged in and never replaced
        // by the org-wide figure. avg_uplift is NULL when nothing was measured.
        // A row whose uplift is NULL (the skill had never been assessed before
        // the action, migration 148) is unmeasured too.
        const rows = await db.all(
            `SELECT a.type,
                    COUNT(e.uplift)::int                   AS actions,
                    COUNT(*) FILTER (WHERE e.uplift IS NULL)::int AS unmeasured,
                    ROUND(AVG(e.uplift)::numeric, 2)       AS avg_uplift,
                    COUNT(*) FILTER (WHERE e.uplift > 0)::int AS positive_uplifts
             FROM idp_actions a
             JOIN idp_plans p ON p.id = a.idp_id
             LEFT JOIN action_effectiveness e ON e.action_id = a.id
             WHERE 1 = 1${scope}
             GROUP BY a.type
             ORDER BY a.type`,
            params
        );
        res.json({ rows, scoped: ids !== null });
    }

    static async pipOverview(req, res) {
        // PIP aggregates. Gate on the catalogue (arbitrate_disputes is the
        // HR-business-partner capability) instead of the dead `hr_bp` role name,
        // which conferred this with zero grants and outside every access review.
        const RBAC = require('../services/RBACService');
        if (!RBAC.isSuperAdmin(req.user) && !RBAC.hasPermission(req.user, 'arbitrate_disputes')) {
            return res.status(403).json({ error: 'forbidden' });
        }
        const ids = await scopedEmployeeIds(req.user);
        const params = [];
        const scope = scopeClause(ids, params, 'employee_id');
        const rows = await db.all(
            `SELECT state, COUNT(*)::int AS n FROM pips WHERE 1 = 1${scope} GROUP BY state`,
            params
        );
        res.json({ rows, scoped: ids !== null });
    }
}

module.exports = DashboardV2Controller;
