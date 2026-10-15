'use strict';
/**
 * EmployeeHomeService — the ONE « Next step » at the top of the employee's
 * « Dashboard » (/employee/dashboard), from the person's own data only.
 *
 * Priority (the first that applies wins):
 *   1. a self-assessment to fix (sent back), to continue (a draft, or started
 *      in the running campaign) or to start (enrolled in the running campaign
 *      and not started, or never assessed at all while the role has requirements);
 *   2. a change request of theirs answered in the last 14 days;
 *   3. their safety clearance BLOCKED, then EXPIRING;
 *   4. otherwise « See my results ».
 * Every source is read on its own: one that fails is simply not a candidate
 * (never « nothing to do » for that area). Every query is keyed on the
 * signed-in person's id; no other person is ever read.
 */
const db = require('../config/database');

const ANSWERED_WINDOW_DAYS = 14;

/** The fixed destination of each step (no value from a request reaches a link). */
const STEPS = Object.freeze({
    sa_fix: '/employee/self-assessment',
    sa_continue: '/employee/self-assessment',
    sa_start: '/employee/self-assessment',
    change_answered: '/assessment-changes',
    safety_blocked: '/safety-gate/me',
    safety_expiring: '/safety-gate/me',
    results: '/employee/assessment-status',
});

async function safe(fn) {
    try {
        return { ok: true, value: await fn() };
    } catch (_) {
        return { ok: false, value: null };
    }
}

async function selfAssessmentStep(employeeId) {
    const rows = await db.all(
        `SELECT workflow_state AS "state", COUNT(*)::int AS "n"
           FROM self_assessments
          WHERE employee_id = ? AND cancelled_at IS NULL
          GROUP BY workflow_state`,
        [employeeId]
    );
    const by = new Map((rows || []).map((r) => [r.state, Number(r.n) || 0]));
    const any = [...by.values()].reduce((a, b) => a + b, 0);
    if (by.get('changes_requested')) return 'sa_fix';
    if (by.get('draft')) return 'sa_continue';
    const camp = await db.get(
        `SELECT p.started_at AS "startedAt", p.submitted_at AS "submittedAt"
           FROM assessment_cycles c
           JOIN cycle_participants p ON p.cycle_id = c.id
          WHERE c.status = 'open' AND p.employee_id = ? AND p.excluded_at IS NULL
          ORDER BY c.opened_at DESC NULLS LAST, c.id DESC LIMIT 1`,
        [employeeId]
    );
    if (camp && !camp.submittedAt) return camp.startedAt ? 'sa_continue' : 'sa_start';
    if (!any) {
        const req = await db.get(
            `SELECT 1 AS "x" FROM employees e
               JOIN role_skill_requirements r ON r.role_id = e.role_id AND r.required_level > 0
              WHERE e.id = ?
                AND NOT EXISTS (SELECT 1 FROM skill_assessments sa WHERE sa.employee_id = e.id)
              LIMIT 1`,
            [employeeId]
        );
        if (req) return 'sa_start';
    }
    return null;
}

async function answeredChange(employeeId) {
    const row = await db.get(
        `SELECT id FROM assessment_change_requests
          WHERE employee_id = ? AND status IN ('granted', 'refused')
            AND decided_at > now() - make_interval(days => ?::int)
          ORDER BY decided_at DESC LIMIT 1`,
        [employeeId, ANSWERED_WINDOW_DAYS]
    );
    return row ? 'change_answered' : null;
}

async function safetyStep(employeeId) {
    const row = await db.get(
        `SELECT COALESCE(enforced_status, status) AS "status"
           FROM safety_gate_status WHERE employee_id = ?`,
        [employeeId]
    );
    if (!row) return null;
    if (row.status === 'BLOCKED') return 'safety_blocked';
    if (row.status === 'EXPIRING') return 'safety_expiring';
    return null;
}

/**
 * The next step of one person.
 * @returns {Promise<{key: string, href: string}>}
 */
async function nextStep(employeeId) {
    const id = Number(employeeId);
    if (!Number.isInteger(id) || id <= 0) return { key: 'results', href: STEPS.results };
    for (const fn of [selfAssessmentStep, answeredChange, safetyStep]) {
        const r = await safe(() => fn(id));
        if (r.ok && r.value) return { key: r.value, href: STEPS[r.value] };
    }
    return { key: 'results', href: STEPS.results };
}

module.exports = { nextStep, STEPS, ANSWERED_WINDOW_DAYS };
