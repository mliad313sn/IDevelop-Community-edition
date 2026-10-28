'use strict';

/**
 * DevelopmentLoopService — the READ side of the development loop (4.0.0 port,
 * wave 4): where a person's plan actions stand, what they proposed to their
 * line and what their closed plans achieved. The weekly reminder of due
 * actions (jobs/reminders.js), the proposal page and the person's development
 * page read it here; nothing else re-derives it. The employee home reads it
 * through EmployeeLoopAdapter (wave 5): the levels validated and the actions
 * done since a date, and the person's one development step.
 *
 * Rules:
 *   - the person reads only themself (callers pass their own id);
 *   - an unknown level is null ("not assessed"), never 0;
 *   - an action without a due date is never "due": absence is not a deadline;
 *   - the migrations 191 / 192 not applied yet: { available: false } / [],
 *     never a throw.
 *
 * Action states (codes; the screens translate them):
 *   awaiting_validation  the person reported it done, the line has not validated
 *   overdue              its due date is past
 *   in_progress          started
 *   to_do                not started
 */

const db = require('../config/database');

const ACTION_STATES = Object.freeze(['awaiting_validation', 'overdue', 'in_progress', 'to_do']);

function isoInstant(v) {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** A DATE column as YYYY-MM-DD in local time (pg returns a local-midnight Date). */
function isoDay(v) {
    if (!v) return null;
    if (typeof v === 'string') return v.slice(0, 10);
    const d = v instanceof Date ? v : new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function todayIso(now = new Date()) {
    return isoDay(now);
}

/** A schema not migrated yet answers `fallback`; any other error is real. */
async function tolerant(fn, fallback) {
    try {
        return await fn();
    } catch (e) {
        const code = e && e.code;
        if (code === '42703' || code === '42P01') return fallback; // undefined column / table
        throw e;
    }
}

function stateOf(a, today) {
    if (a.reportedDoneAt) return 'awaiting_validation';
    const due = isoDay(a.dueOn);
    if (due && due < today) return 'overdue';
    if (String(a.status) === 'in_progress') return 'in_progress';
    return 'to_do';
}

/** The open actions of the person's draft or active plan, with their state. */
async function actionStates(employeeId, { now = new Date() } = {}) {
    return tolerant(
        async () => {
            const rows = await db.all(
                `SELECT a.id, a.idp_id AS "idpId", a.title, a.type::text AS "type", a.status::text AS "status",
                        a.due_on AS "dueOn", a.started_at AS "startedAt", a.reported_done_at AS "reportedDoneAt",
                        a.place, a.estimated_hours AS "plannedHours", p.status::text AS "planStatus",
                        COALESCE((SELECT l.skill_id FROM action_skill_links l WHERE l.action_id = a.id
                                   ORDER BY l.skill_id LIMIT 1), o.skill_id) AS "skillId"
                   FROM idp_actions a
                   JOIN idp_plans p ON p.id = a.idp_id
                   LEFT JOIN idp_objectives o ON o.id = a.objective_id
                  WHERE p.employee_id = ? AND p.status IN ('draft', 'active')
                    AND a.status::text NOT IN ('completed', 'cancelled')
                  ORDER BY a.due_on NULLS LAST, a.id`,
                [Number(employeeId)]
            );
            const ids = (rows || []).map((r) => Number(r.id));
            const skillIds = [
                ...new Set((rows || []).map((r) => r.skillId).filter((x) => x != null)),
            ].map(Number);
            const names = skillIds.length
                ? await db.all('SELECT id, name FROM skills WHERE id = ANY(?)', [skillIds])
                : [];
            const nameOf = new Map((names || []).map((n) => [Number(n.id), n.name]));
            const enr = ids.length
                ? await db.all(
                      `SELECT e.source_action_id AS "actionId", c.title AS "courseTitle",
                              e.status::text AS "status", e.due_at AS "dueAt"
                         FROM lms_enrollments e JOIN lms_courses c ON c.id = e.course_id
                        WHERE e.source_action_id = ANY(?)`,
                      [ids]
                  )
                : [];
            const trainingOf = new Map((enr || []).map((e) => [Number(e.actionId), e]));
            const today = todayIso(now);
            const open = (rows || []).map((r) => {
                const t = trainingOf.get(Number(r.id));
                return {
                    id: Number(r.id),
                    idpId: Number(r.idpId),
                    title: r.title,
                    type: r.type,
                    status: r.status,
                    planStatus: r.planStatus,
                    state: stateOf(r, today),
                    dueOn: isoDay(r.dueOn),
                    startedAt: isoInstant(r.startedAt),
                    reportedDoneAt: isoInstant(r.reportedDoneAt),
                    skillId: r.skillId == null ? null : Number(r.skillId),
                    skillName: r.skillId == null ? null : nameOf.get(Number(r.skillId)) || null,
                    training: t
                        ? {
                              courseTitle: t.courseTitle,
                              status: t.status,
                              dueAt: isoInstant(t.dueAt),
                          }
                        : null,
                    place: r.place || null,
                    plannedHours: r.plannedHours == null ? null : Number(r.plannedHours),
                };
            });
            return {
                available: true,
                open,
                awaitingValidation: open.filter((a) => a.state === 'awaiting_validation').length,
                overdue: open.filter((a) => a.state === 'overdue').length,
            };
        },
        { available: false, open: [], awaitingValidation: 0, overdue: 0 }
    );
}

/**
 * The person's actions due within `days` or overdue that still wait on THEM
 * (one awaiting validation is the line's): { count, overdue, dueOn } or null.
 */
async function dueActions(employeeId, { days = 7, now = new Date() } = {}) {
    const st = await actionStates(employeeId, { now });
    if (!st || st.available === false) return null;
    const today = todayIso(now);
    const horizon = todayIso(new Date(now.getTime() + Number(days) * 86400000));
    let count = 0;
    let overdue = 0;
    let first = null;
    for (const a of st.open) {
        if (a.state === 'awaiting_validation' || a.planStatus !== 'active' || !a.dueOn) continue;
        if (a.dueOn > horizon) continue;
        count++;
        if (a.dueOn < today) overdue++;
        if (!first || a.dueOn < first) first = a.dueOn;
    }
    return count ? { count, overdue, dueOn: first } : null;
}

/** The person's own proposals, newest first, with who decided them. */
async function proposals(employeeId) {
    return tolerant(async () => {
        const rows = await db.all(
            `SELECT dp.id, dp.skill_id AS "skillId", s.name AS "skillName", dp.action_type AS "actionType",
                    dp.proposal_text AS "text", dp.status, dp.routed_to AS "routedTo",
                    dp.created_at AS "createdAt", dp.decided_at AS "decidedAt",
                    dp.decision_reason AS "decisionReason", dp.idp_id AS "idpId",
                    dp.created_action_id AS "createdActionId",
                    CASE dp.decided_by_type
                         WHEN 'admin' THEN (SELECT da.username FROM admins da WHERE da.id = dp.decided_by_id)
                         ELSE (SELECT NULLIF(btrim(concat_ws(' ', de.first_name, de.last_name)), '')
                                 FROM employees de WHERE de.id = dp.decided_by_id)
                    END AS "decidedByName"
               FROM dev_proposals dp LEFT JOIN skills s ON s.id = dp.skill_id
              WHERE dp.employee_id = ?
              ORDER BY dp.created_at DESC, dp.id DESC`,
            [Number(employeeId)]
        );
        return (rows || []).map((r) => ({
            id: Number(r.id),
            skillId: r.skillId == null ? null : Number(r.skillId),
            skillName: r.skillName || null,
            actionType: r.actionType,
            text: r.text,
            status: r.status,
            routedTo: r.routedTo,
            idpId: r.idpId == null ? null : Number(r.idpId),
            createdAt: isoInstant(r.createdAt),
            decidedAt: isoInstant(r.decidedAt),
            decisionReason: r.decisionReason || null,
            decidedByName: r.status === 'pending' ? null : r.decidedByName || null,
            createdActionId: r.createdActionId == null ? null : Number(r.createdActionId),
        }));
    }, []);
}

/** Closed plans (completed / archived) of one person, with what they achieved. */
async function planOutcomes(employeeId) {
    return tolerant(async () => {
        const plans = await db.all(
            `SELECT p.id, p.status::text AS "status", p.closed_at AS "closedAt",
                    (SELECT ev.detail FROM idp_plan_events ev WHERE ev.idp_id = p.id
                       AND ev.action = 'plan_completed' ORDER BY ev.id DESC LIMIT 1) AS "detail",
                    (SELECT COUNT(*)::int FROM idp_objectives o WHERE o.idp_id = p.id) AS "objectives",
                    (SELECT COUNT(DISTINCT ae.action_id)::int FROM action_effectiveness ae
                       JOIN idp_actions a ON a.id = ae.action_id
                      WHERE a.idp_id = p.id AND ae.official AND ae.uplift > 0) AS "skillsRaised"
               FROM idp_plans p
              WHERE p.employee_id = ? AND p.status IN ('completed', 'archived')
              ORDER BY p.closed_at DESC NULLS LAST, p.id DESC`,
            [Number(employeeId)]
        );
        return (plans || []).map((p) => {
            let d = p.detail;
            if (typeof d === 'string') {
                try {
                    d = JSON.parse(d);
                } catch (_) {
                    d = null;
                }
            }
            return {
                idpId: Number(p.id),
                status: p.status,
                closedAt: isoInstant(p.closedAt),
                objectives: Number(p.objectives) || 0,
                skillsMet: d && d.skillsMet != null ? Number(d.skillsMet) : null,
                skillsTotal: d && d.skillsTotal != null ? Number(d.skillsTotal) : null,
                skillsRaised: Number(p.skillsRaised) || 0,
            };
        });
    }, []);
}

/**
 * Where an official level came from, from the history row the trigger wrote
 * (fn_log_skill_assessment_change, migration 11): a training completion the
 * line accepted, a level observed on a plan action or a coaching, else a
 * review of the person's ratings. Anything unknown is 'other' — never an
 * invented provenance.
 */
function upliftSourceOf(source, notes) {
    const n = String(notes || '').toLowerCase();
    if (n.includes('training completion')) return 'training';
    if (n.startsWith('auto: coaching')) return 'coaching';
    if (source === 'action_uplift') return 'observation';
    if (source === 'self_assessment' || source === 'supervisor_review') return 'review';
    return 'other';
}

/**
 * The OFFICIAL levels that went up (or were set for the first time) since
 * `since`, newest first: [{skillId, skillName, from, to, at, source}].
 * Read from the assessment history, which only the validation paths write;
 * a self-rating or a draft never appears here. `from` is null for a first
 * measurement (never 0).
 */
async function validatedUpliftsSince(employeeId, since) {
    const t = isoInstant(since);
    if (!t) return [];
    const rows = await db.all(
        `SELECT h.skill_id AS "skillId", s.name AS "skillName",
                h.previous_level AS "from", h.new_level AS "to",
                h.assessed_at AS "at", h.source, h.notes
           FROM assessment_history h
           JOIN skills s ON s.id = h.skill_id
          WHERE h.employee_id = ? AND h.assessed_at >= ?::timestamptz
            AND (h.previous_level IS NULL OR h.new_level > h.previous_level)
          ORDER BY h.assessed_at DESC, h.id DESC`,
        [Number(employeeId), t]
    );
    return (rows || []).map((r) => ({
        skillId: Number(r.skillId),
        skillName: r.skillName || null,
        from: r.from == null ? null : Number(r.from),
        to: r.to == null ? null : Number(r.to),
        at: isoInstant(r.at),
        source: upliftSourceOf(r.source, r.notes),
    }));
}

/** The person's plan actions completed since `since`: [{id, idpId, title, completedAt}]. */
async function actionsDoneSince(employeeId, since) {
    const t = isoInstant(since);
    if (!t) return [];
    const rows = await db.all(
        `SELECT a.id, a.idp_id AS "idpId", a.title, a.completed_at AS "completedAt"
           FROM idp_actions a
           JOIN idp_plans p ON p.id = a.idp_id
          WHERE p.employee_id = ? AND a.status::text = 'completed'
            AND a.completed_at >= ?::timestamptz
          ORDER BY a.completed_at DESC, a.id DESC`,
        [Number(employeeId), t]
    );
    return (rows || []).map((r) => ({
        id: Number(r.id),
        idpId: Number(r.idpId),
        title: r.title,
        completedAt: isoInstant(r.completedAt),
    }));
}

/** The plan page of one action (ids from the database, digits only). */
function actionHref(a) {
    return `/v2/idp/${Number(a.idpId)}#action-${Number(a.id)}`;
}

/**
 * The person's ONE development step, or { kind: 'none' }:
 *   action_due     an action of their active plan due within 7 days, or overdue;
 *   training       a course assigned to them, due within 7 days or overdue;
 *   validate_wait  an action they reported done, waiting for their line;
 *   gap_no_plan    a MEASURED gap and no open plan: propose an action.
 * The first two are urgent (the home ranks them before a survey). Every link
 * is a fixed path built from database ids.
 */
async function nextDevelopmentStep(employeeId, { now = new Date(), days = 7 } = {}) {
    const me = Number(employeeId);
    const st = await actionStates(me, { now });
    if (!st || st.available === false) return { kind: 'none' };
    const today = todayIso(now);
    const horizon = todayIso(new Date(now.getTime() + Number(days) * 86400000));
    const due = st.open
        .filter(
            (a) =>
                a.state !== 'awaiting_validation' &&
                a.planStatus === 'active' &&
                a.dueOn &&
                a.dueOn <= horizon
        )
        .sort((x, y) => (x.dueOn < y.dueOn ? -1 : x.dueOn > y.dueOn ? 1 : x.id - y.id));
    if (due.length) {
        const a = due[0];
        return {
            kind: 'action_due',
            href: actionHref(a),
            vars: { title: a.title, dueOn: a.dueOn, overdue: a.dueOn < today },
        };
    }
    const course = await db
        .get(
            `SELECT c.title, e.due_at AS "dueAt"
               FROM lms_enrollments e JOIN lms_courses c ON c.id = e.course_id
              WHERE e.employee_id = ? AND e.status::text NOT IN ('completed', 'cancelled', 'failed')
                AND e.due_at IS NOT NULL AND e.due_at::date <= ?::date
              ORDER BY e.due_at, e.id LIMIT 1`,
            [me, horizon]
        )
        .catch(() => null);
    if (course) {
        return {
            kind: 'training',
            href: '/employee/my-learning',
            vars: { title: course.title, dueAt: isoInstant(course.dueAt) },
        };
    }
    const waiting = st.open.find((a) => a.state === 'awaiting_validation');
    if (waiting) {
        return { kind: 'validate_wait', href: actionHref(waiting), vars: { title: waiting.title } };
    }
    const hasPlan = await db.get(
        "SELECT 1 AS x FROM idp_plans WHERE employee_id = ? AND status IN ('draft', 'active') LIMIT 1",
        [me]
    );
    if (!hasPlan) {
        const gap = await db.get(
            `SELECT g.skill_id AS "skillId", g.skill_name AS "skillName"
               FROM v_employee_skill_gaps g
              WHERE g.employee_id = ? AND g.is_assessed = 1 AND g.gap > 0
              ORDER BY g.is_critical DESC, g.gap DESC, g.skill_name LIMIT 1`,
            [me]
        );
        if (gap) {
            return {
                kind: 'gap_no_plan',
                href: `/v2/idp/propose?skillId=${Number(gap.skillId)}`,
                vars: { skill: gap.skillName },
            };
        }
    }
    return { kind: 'none' };
}

module.exports = {
    ACTION_STATES,
    actionStates,
    dueActions,
    proposals,
    planOutcomes,
    validatedUpliftsSince,
    actionsDoneSince,
    nextDevelopmentStep,
    _stateOf: stateOf,
    _upliftSourceOf: upliftSourceOf,
};
