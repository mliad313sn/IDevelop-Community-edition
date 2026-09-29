'use strict';

/**
 * succession-review — the weekly succession tick.
 *
 * ContinuityService.listPlansDue and .criticalRolesWithoutSuccessor have
 * existed since the continuity phase, but the ONLY caller was the /v2/continuity
 * page. Succession therefore only ever advanced when somebody happened to open
 * that page: a plan could sail past its review_due for months, and a critical
 * role could sit with an empty bench indefinitely, with nothing anywhere
 * telling the responsible person. Key-person risk — the buyer's strongest
 * lock-in — had zero automation. This tick is the prompt.
 *
 * Two signals, ONE notification per recipient:
 *   - succession plans whose review_due has arrived or passed,
 *   - critical roles with no named successor (no plan at all, or a plan with an
 *     empty bench).
 *
 * Recipient resolution walks from the person closest to the reality outwards:
 *   plan due        → the incumbent's manager, else the plan's owning admin,
 *                     else the superadmins.
 *   no successor    → the managers of the role's active occupants, else the
 *                     plan's owning admin, else the superadmins.
 *
 * AGGREGATED PER RECIPIENT — one notification carrying counts, never one per
 * row: an org with 60 critical roles must not produce 60 bells. The payload
 * carries counts and a deep link only; no role is named and no incumbent is
 * named, so the message is safe at every clearance.
 *
 * Exactly-once per ISO week via the shared reminder_log ledger
 * (claim-before-send), so the hourly tick and a mid-week restart are both
 * no-ops. Self-gated to one hour/day, like the rest of the nudge family.
 */

const db = require('../config/database');
const { claim, release, weekBucket } = require('./reminders');

const ENV_HOUR = Number(process.env.REMINDER_HOUR) || 8;

/**
 * The ACTIVE line of each incumbent (3.23.18 R2): effective reviewer (ACTIVE
 * supervisor → employee-manager → admin-manager) + the manager when different —
 * succession is the manager's decision. Map employeeId → [{ userType, id }].
 */
async function managersOf(employeeIds) {
    if (!employeeIds.length) return new Map();
    return require('../services/ReportingLineService').lineRecipientsMany(employeeIds, {
        includeManager: true,
    });
}

/** Distinct ACTIVE effective reviewers of the ACTIVE occupants of each role: Map roleId → [{ userType, id }]. */
async function managersOfRoleOccupants(roleIds) {
    const map = new Map();
    if (!roleIds.length) return map;
    const RL = require('../services/ReportingLineService');
    const ph = roleIds.map(() => '?').join(',');
    const rows = await db.all(
        `SELECT DISTINCT e.role_id, rl.kind AS mgr_type, rl.id AS mgr_id
           FROM employees e
           ${RL.effectiveReviewerJoinSql('e', 'rl')}
          WHERE e.role_id IN (${ph}) AND e.is_active = true AND rl.id IS NOT NULL`,
        roleIds
    );
    for (const r of rows) {
        const roleId = Number(r.roleId ?? r.role_id);
        const mgr = Number(r.mgrId ?? r.mgr_id) || null;
        if (!roleId || !mgr) continue;
        if (!map.has(roleId)) map.set(roleId, []);
        map.get(roleId).push({
            userType: (r.mgrType ?? r.mgr_type) === 'admin' ? 'admin' : 'employee',
            id: mgr,
        });
    }
    return map;
}

/** Last-resort recipients: the people who can always act on succession. */
async function superadminIds() {
    try {
        const rows = await db.all(
            "SELECT id FROM admins WHERE role = 'superadmin' AND COALESCE(is_active, true) = true ORDER BY id"
        );
        return rows.map((r) => Number(r.id)).filter(Boolean);
    } catch (_) {
        return [];
    }
}

async function tick() {
    const now = new Date();
    const AppSettingsModel = require('../models/AppSettingsModel');
    let hour = ENV_HOUR;
    try {
        hour = Number(await AppSettingsModel.getValue('reminderHour', ENV_HOUR));
    } catch {
        /* default */
    }
    if (!Number.isFinite(hour)) hour = ENV_HOUR;
    if (now.getHours() < hour) return { notified: 0, skipped: 'not_due' };

    const ContinuityService = require('../services/ContinuityService');
    const N = require('../services/NotificationService');
    const wk = weekBucket(now);
    const out = { plansDue: 0, rolesWithoutSuccessor: 0, notified: 0 };

    let duePlans = [],
        noSuccessor = [];
    try {
        duePlans = await ContinuityService.listPlansDue(null);
    } catch (_) {
        duePlans = [];
    }
    try {
        noSuccessor = await ContinuityService.criticalRolesWithoutSuccessor(null);
    } catch (_) {
        noSuccessor = [];
    }
    out.plansDue = duePlans.length;
    out.rolesWithoutSuccessor = noSuccessor.length;
    if (!duePlans.length && !noSuccessor.length) return out;

    // 'admin:7' | 'employee:42' → { userType, userId, plansDue, noSuccessor }
    const byRecipient = new Map();
    const bump = (userType, userId, key) => {
        const id = Number(userId);
        if (!id) return;
        const k = `${userType}:${id}`;
        const cur = byRecipient.get(k) || { userType, userId: id, plansDue: 0, noSuccessor: 0 };
        cur[key]++;
        byRecipient.set(k, cur);
    };

    let supers = null;
    const fallback = async (ownerAdminId, key) => {
        if (ownerAdminId) {
            bump('admin', ownerAdminId, key);
            return;
        }
        if (supers === null) supers = await superadminIds();
        for (const id of supers) bump('admin', id, key);
    };

    // --- plans past their review date -------------------------------------
    const incumbentIds = [
        ...new Set(
            duePlans
                .map((p) => Number(p.incumbentEmployeeId ?? p.incumbent_employee_id))
                .filter(Boolean)
        ),
    ];
    const incumbentMgr = await managersOf(incumbentIds);
    for (const p of duePlans) {
        const incumbent = Number(p.incumbentEmployeeId ?? p.incumbent_employee_id) || null;
        const line = incumbent ? incumbentMgr.get(incumbent) || [] : [];
        if (line.length) for (const m of line) bump(m.userType, m.id, 'plansDue');
        else await fallback(Number(p.ownerAdminId ?? p.owner_admin_id) || null, 'plansDue');
    }

    // --- critical roles with an empty bench --------------------------------
    const roleIds = [
        ...new Set(noSuccessor.map((r) => Number(r.roleId ?? r.role_id)).filter(Boolean)),
    ];
    const roleMgrs = await managersOfRoleOccupants(roleIds);
    for (const r of noSuccessor) {
        const roleId = Number(r.roleId ?? r.role_id);
        const mgrs = roleMgrs.get(roleId) || [];
        if (mgrs.length) for (const m of mgrs) bump(m.userType, m.id, 'noSuccessor');
        else await fallback(null, 'noSuccessor'); // vacant critical role → superadmins
    }

    // --- one notification per recipient ------------------------------------
    for (const c of byRecipient.values()) {
        const count = c.plansDue + c.noSuccessor;
        if (!count) continue;
        if (!(await claim('succession.review', c.userType, c.userId, 0, wk))) continue;
        // AWAITED, unlike the fire-and-forget notify calls in the request path:
        // a tick has no latency budget to protect, and an un-awaited write here
        // races the pooled client (node-pg "client is already executing a query")
        // and can outlive the tick.
        //
        // notify signals failure by RETURNING { inapp: 'error' } — it does not
        // throw — so `.catch` caught nothing and `out.notified++` ran anyway:
        // the tick reported a send that never happened AND burned the weekly
        // claim, losing this recipient's succession nudge for the whole week.
        // Counted only when delivered; released otherwise (cycle-nudge pattern).
        let result = null;
        try {
            result = await N.notify({
                userType: c.userType,
                userId: c.userId,
                kind: 'succession.review_due',
                category: 'talent',
                payload: {
                    link: '/v2/continuity',
                    count,
                    plansDue: c.plansDue,
                    noSuccessor: c.noSuccessor,
                },
            });
        } catch (_) {
            result = null;
        }
        if (result && result.inapp !== 'error') out.notified++;
        else await release('succession.review', c.userType, c.userId, 0, wk);
    }

    if (process.env.NODE_ENV !== 'test') {
        console.log(
            `[succession-review] plansDue:${out.plansDue} noSuccessor:${out.rolesWithoutSuccessor} notified:${out.notified}`
        );
    }
    return out;
}

module.exports = { tick, __test: { managersOf, managersOfRoleOccupants } };
