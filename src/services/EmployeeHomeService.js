'use strict';
/**
 * EmployeeHomeService — the ONE « Next step » at the top of the employee's
 * « Dashboard » (/employee/dashboard), and the « What changed since… » block
 * of the home and « My progress », from the person's own data only.
 *
 * Next-step priority (the first that applies wins):
 *   1. a self-assessment to fix (sent back), to continue (a draft, or started
 *      in the running campaign) or to start (enrolled in the running campaign
 *      and not started, or never assessed at all while the role has
 *      requirements) — but only where a save would be ACCEPTED: with no open
 *      campaign and the person's latest campaign LOCKED, every save is refused
 *      (EmployeePortalController.resolveEmployeeCycle), so the person is never
 *      sent there to rate for nothing;
 *   2. a change request of theirs answered in the last 14 days;
 *   3. their safety clearance BLOCKED, then EXPIRING;
 *   4. a development step that is due (a plan action, a training) — urgent;
 *   5. another development step (a measured gap with no plan: propose an
 *      action; an action waiting for the line), else measured gaps still open
 *      (→ « My progress »);
 *   6. the locked campaign, when work was left in it (never « nothing waits »);
 *   7. otherwise « See my results ».
 * Every source is read on its own: one that fails is simply not a candidate
 * (never « nothing to do » for that area). Every query is keyed on the
 * signed-in person's id; no other person is ever read.
 */
const db = require('../config/database');

const ANSWERED_WINDOW_DAYS = 14;
/** Days of the « What changed » window when no weekly point was ever sent. */
const CHANGES_WINDOW_DAYS = 90;

/** The fixed destination of each step (no value from a request reaches a link). */
const STEPS = Object.freeze({
    sa_fix: '/employee/self-assessment',
    sa_continue: '/employee/self-assessment',
    sa_start: '/employee/self-assessment',
    change_answered: '/assessment-changes',
    safety_blocked: '/safety-gate/me',
    safety_expiring: '/safety-gate/me',
    dev_action_due: '/employee/my-development',
    dev_training: '/employee/my-learning',
    dev_gap_no_plan: '/v2/idp/propose',
    dev_validate_wait: '/employee/my-development',
    dev_gaps_open: '/employee/my-progress',
    sa_locked: '/employee/assessment-status',
    results: '/employee/assessment-status',
});

/** An app-relative path built by the loop from database ids, else null. */
function safeHref(h) {
    const s = typeof h === 'string' ? h : '';
    return /^\/[a-z0-9][a-z0-9/_-]*(\?[a-zA-Z]+=\d+)?(#[a-z]+-\d+)?$/.test(s) ? s : null;
}

async function safe(fn) {
    try {
        return { ok: true, value: await fn() };
    } catch (_) {
        return { ok: false, value: null };
    }
}

/**
 * The self-assessment state: { todo, locked } where `todo` is the step to
 * offer (or null) and `locked` names the locked campaign that refuses every
 * save when work was left in it (or null).
 */
async function selfAssessmentState(employeeId) {
    const rows = await db.all(
        `SELECT workflow_state AS "state", COUNT(*)::int AS "n"
           FROM self_assessments
          WHERE employee_id = ? AND cancelled_at IS NULL
          GROUP BY workflow_state`,
        [employeeId]
    );
    const by = new Map((rows || []).map((r) => [r.state, Number(r.n) || 0]));
    const any = [...by.values()].reduce((a, b) => a + b, 0);
    const camp = await db.get(
        `SELECT p.started_at AS "startedAt", p.submitted_at AS "submittedAt"
           FROM assessment_cycles c
           JOIN cycle_participants p ON p.cycle_id = c.id
          WHERE c.status = 'open' AND p.employee_id = ? AND p.excluded_at IS NULL
          ORDER BY c.opened_at DESC NULLS LAST, c.id DESC LIMIT 1`,
        [employeeId]
    );
    // The SAME lock rule as the save path (resolveEmployeeCycle): with no open
    // campaign at all and the person's latest campaign LOCKED, a save is refused.
    let anyOpen = !!camp;
    if (!anyOpen) {
        anyOpen = !!(await db.get(
            "SELECT 1 AS x FROM assessment_cycles WHERE status = 'open' LIMIT 1"
        ));
    }
    let lockedCycle = null;
    if (!anyOpen) {
        lockedCycle =
            (await db.get(
                `SELECT c.id, c.code, c.label
                   FROM assessment_cycles c
                   JOIN cycle_participants p ON p.cycle_id = c.id
                  WHERE c.status = 'locked' AND p.employee_id = ? AND p.excluded_at IS NULL
                  ORDER BY c.closes_at DESC LIMIT 1`,
                [employeeId]
            )) || null;
    }
    const canSave = anyOpen || !lockedCycle;
    let todo = null;
    let blocked = false;
    if (by.get('changes_requested')) {
        if (canSave) todo = 'sa_fix';
        else blocked = true;
    } else if (by.get('draft')) {
        if (canSave) todo = 'sa_continue';
        else blocked = true;
    } else if (camp && !camp.submittedAt) {
        todo = camp.startedAt ? 'sa_continue' : 'sa_start';
    } else if (!any) {
        const req = await db.get(
            `SELECT 1 AS "x" FROM employees e
               JOIN role_skill_requirements r ON r.role_id = e.role_id AND r.required_level > 0
              WHERE e.id = ?
                AND NOT EXISTS (SELECT 1 FROM skill_assessments sa WHERE sa.employee_id = e.id)
              LIMIT 1`,
            [employeeId]
        );
        if (req) {
            if (canSave) todo = 'sa_start';
            else blocked = true;
        }
    }
    const locked =
        blocked && lockedCycle
            ? {
                  id: Number(lockedCycle.id),
                  code: lockedCycle.code || null,
                  label: lockedCycle.label || null,
              }
            : null;
    return { todo, locked };
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

/** The person's requirement rows (v_employee_skill_gaps); a level is null when never measured. */
async function gapRowsOf(employeeId) {
    const rows = await db.all(
        `SELECT g.skill_id AS "skillId", g.skill_name AS "skillName", g.required_level AS "required",
                g.actual_level AS "actual", g.is_assessed AS "isAssessed", g.is_critical AS "isCritical",
                g.gap AS "gap"
           FROM v_employee_skill_gaps g
          WHERE g.employee_id = ?`,
        [Number(employeeId)]
    );
    return (rows || []).map((r) => {
        const assessed = Number(r.isAssessed) === 1;
        return {
            skillId: r.skillId == null ? null : Number(r.skillId),
            skillName: r.skillName,
            required: r.required == null ? null : Number(r.required),
            isCritical: r.isCritical === true,
            assessed,
            current: assessed ? Number(r.actual) : null,
            gap: assessed ? Number(r.gap) : null,
        };
    });
}

/** Pure: measured gaps still open (a never-measured skill is not a gap). */
function openGapsOf(gapRows) {
    return (gapRows || []).filter((g) => g.assessed && Number(g.gap) > 0).length;
}

/**
 * Pure: the loop's development step (DevelopmentLoopService.nextDevelopmentStep
 * through EmployeeLoopAdapter) as a home step, or — without one — the measured
 * gaps still open, which beat « nothing waits for you ». `urgent` steps rank
 * before the others. A link the loop did not build from ids falls back to the
 * fixed destination of its key.
 */
function devStepOf(step, openGaps) {
    if (step && step.kind) {
        const v = step.vars || {};
        const extra = {};
        const title = v.title || v.skill || null;
        const date = v.dueOn || v.dueAt || null;
        if (title) extra.title = String(title);
        if (date) extra.date = String(date).slice(0, 10);
        const KEY = {
            action_due: ['dev_action_due', true],
            training: ['dev_training', true],
            gap_no_plan: ['dev_gap_no_plan', false],
            validate_wait: ['dev_validate_wait', false],
        }[step.kind];
        if (KEY) {
            const [key, urgent] = KEY;
            return { key, href: safeHref(step.href) || STEPS[key], extra, urgent };
        }
    }
    if (Number(openGaps) > 0) {
        return {
            key: 'dev_gaps_open',
            href: STEPS.dev_gaps_open,
            extra: { count: Number(openGaps) },
            urgent: false,
        };
    }
    return null;
}

/**
 * The step of one person and the locked campaign, when one blocks their work.
 * @returns {Promise<{next: {key, href, extra?}, locked: object|null}>}
 */
async function home(employeeId) {
    const id = Number(employeeId);
    if (!Number.isInteger(id) || id <= 0) {
        return { next: { key: 'results', href: STEPS.results }, locked: null };
    }
    const sa = await safe(() => selfAssessmentState(id));
    const locked = sa.ok ? sa.value.locked : null;
    if (sa.ok && sa.value.todo)
        return { next: { key: sa.value.todo, href: STEPS[sa.value.todo] }, locked };
    for (const fn of [answeredChange, safetyStep]) {
        const r = await safe(() => fn(id));
        if (r.ok && r.value) return { next: { key: r.value, href: STEPS[r.value] }, locked };
    }
    const Loop = require('./EmployeeLoopAdapter');
    const [step, gaps] = await Promise.all([
        safe(() => Loop.nextDevelopmentStep(id)),
        safe(() => gapRowsOf(id)),
    ]);
    const dev = devStepOf(step.ok ? step.value : null, gaps.ok ? openGapsOf(gaps.value) : 0);
    if (dev) {
        const next = { key: dev.key, href: dev.href };
        if (Object.keys(dev.extra || {}).length) next.extra = dev.extra;
        return { next, locked };
    }
    if (locked) return { next: { key: 'sa_locked', href: STEPS.sa_locked }, locked };
    return { next: { key: 'results', href: STEPS.results }, locked };
}

/**
 * The next step of one person (also read by the persona digest, which prints
 * `employee:next_<key>` as is: those sentences carry no placeholder).
 * @returns {Promise<{key: string, href: string, extra?: object}>}
 */
async function nextStep(employeeId) {
    return (await home(employeeId)).next;
}

/**
 * Where « What changed » starts: the last weekly point (persona digest) the
 * person was SENT before today; without one, the last 90 days. The page names
 * it either way, so the window is never a hidden assumption.
 */
async function sinceAnchor(employeeId, { now = new Date() } = {}) {
    const row = await db.get(
        `SELECT MAX(created_at) AS "at"
           FROM persona_digests
          WHERE user_type = 'employee' AND user_id = ? AND state = 'sent'
            AND created_at < date_trunc('day', now())`,
        [Number(employeeId)]
    );
    const at = row && row.at ? new Date(row.at) : null;
    if (at && !Number.isNaN(at.getTime())) {
        return { since: at.toISOString(), kind: 'digest', date: at.toISOString().slice(0, 10) };
    }
    const d = new Date(now.getTime() - CHANGES_WINDOW_DAYS * 86400000);
    return {
        since: d.toISOString(),
        kind: 'window',
        date: d.toISOString().slice(0, 10),
        days: CHANGES_WINDOW_DAYS,
    };
}

const SOURCES = ['training', 'observation', 'coaching', 'review'];

/**
 * « What changed » for the person since the anchor: levels VALIDATED (never a
 * self-rating or a draft), gaps closed (a MEASURED gap now at the required
 * level — a first measurement closes nothing), plan actions done, trainings
 * completed. Counts and their own skills only.
 * Null when the validated levels cannot be read: the block is then hidden
 * rather than claiming « nothing new ». A count that could not be read is
 * null, never 0.
 */
async function changesSince(employeeId, anchor, gapRows) {
    const since = anchor && anchor.since;
    if (!since) return null;
    const Loop = require('./EmployeeLoopAdapter');
    const uplifts = await Loop.validatedUpliftsSince(employeeId, since);
    if (!uplifts) return null;
    const reqBySkill = new Map();
    for (const g of gapRows || [])
        if (g.skillId != null && g.required != null)
            reqBySkill.set(Number(g.skillId), Number(g.required));
    const closed = new Set();
    for (const u of uplifts) {
        const req = reqBySkill.get(Number(u.skillId));
        if (req == null || u.from == null || u.to == null) continue;
        if (Number(u.from) < req && Number(u.to) >= req) closed.add(Number(u.skillId));
    }
    const done = await Loop.actionsDoneSince(employeeId, since);
    let trainingsDone = null;
    try {
        const items = (await require('./LmsService').listForEmployee(employeeId)) || [];
        const t0 = new Date(since).getTime();
        trainingsDone = items.filter(
            (i) =>
                i.status === 'completed' && i.completedAt && new Date(i.completedAt).getTime() >= t0
        ).length;
    } catch (_) {
        trainingsDone = null;
    }
    return {
        anchor,
        uplifts: uplifts.slice(0, 5).map((u) => ({
            skillName: u.skillName || null,
            from: u.from == null ? null : Number(u.from),
            to: u.to == null ? null : Number(u.to),
            at: u.at || null,
            source: SOURCES.includes(u.source) ? u.source : 'other',
        })),
        upliftsTotal: uplifts.length,
        gapsClosed: closed.size,
        actionsDone: Array.isArray(done) ? done.length : null,
        trainingsDone,
    };
}

/** « What changed » of one person, or null when it cannot be established. */
async function changesFor(employeeId) {
    const id = Number(employeeId);
    if (!Number.isInteger(id) || id <= 0) return null;
    try {
        const [anchor, gaps] = await Promise.all([sinceAnchor(id), gapRowsOf(id)]);
        return await changesSince(id, anchor, gaps);
    } catch (_) {
        return null;
    }
}

module.exports = {
    home,
    nextStep,
    sinceAnchor,
    changesSince,
    changesFor,
    devStepOf,
    gapRowsOf,
    openGapsOf,
    STEPS,
    ANSWERED_WINDOW_DAYS,
    CHANGES_WINDOW_DAYS,
    _safeHref: safeHref,
};
