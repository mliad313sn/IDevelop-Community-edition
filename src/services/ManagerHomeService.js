'use strict';

/**
 * ManagerHomeService — the three reads the manager's home adds beside the team
 * tiles (4.0.0 port, wave 10). COUNTS AND AGES ONLY: no name, no person id
 * leaves this module; the names stay on the module pages each line opens,
 * under those pages' own rules.
 *
 *   backlog   « Waiting on me »: what waits on the manager, one line per kind,
 *             with the age of the oldest item in whole days and how many are
 *             older than a week:
 *               validations  people with a submitted self-assessment
 *               disputes     level-0 disputes with no proposal yet
 *               changes      change requests on the team (not the manager's own)
 *               actions      plan actions reported done, not validated (development)
 *               proposals    actions the team proposed to the line (development)
 *               plans        development / coaching plans late by more than
 *                            90 days (development)
 *               handovers    open handovers past their due date with an open
 *                            item (talent)
 *               safety       people blocked by the safety gate (mandatory: it
 *                            ignores preferences; no status row for anybody =
 *                            « not configured », never « 0 blocked »)
 *   expiry    « Expiring in my team »: the required certificates of the team
 *             (KpiService K8, people counts), « not configured » when no role
 *             of the team requires one.
 *   ready     « Ready to move on »: the people ready in their own role who also
 *             meet the readiness rule on a TARGET role (an active succession
 *             nomination — talent — or the person's own wish — mobility), each
 *             skill re-scored against THAT role (credited level, never above
 *             the requirement). A target not fully assessed (and with no
 *             critical gap) is « to assess », never « not ready ».
 *
 * Honesty rules: a source that cannot be read is `unavailable` (null), never
 * 0; an age of 0 days is « today », never « 0 days »; a module that is off
 * leaves its line out, it is not « not measured ».
 */

const db = require('../config/database');

const LATE_DAYS = 7;
const PLAN_LATE_DAYS = 90;
/** The order of the lines — and of the manager's top task (the first one waiting). */
const BACKLOG_ORDER = Object.freeze([
    'safety',
    'validations',
    'disputes',
    'actions',
    'proposals',
    'changes',
    'plans',
    'handovers',
]);
/** The page each line opens (fixed paths). */
const HREF = Object.freeze({
    safety: '/safety-gate',
    validations: '/supervisor/self-assessment-reviews',
    disputes: '/v2/slf/disputes',
    actions: '/v2/idp/manage',
    proposals: '/v2/idp/manage',
    changes: '/assessment-changes',
    plans: '/v2/idp/manage',
    handovers: '/v2/continuity',
    expiry: '/compliance',
    ready: '/talent/career-path',
});
/** The module a line needs (null = core). */
const LINE_MODULE = Object.freeze({
    safety: null,
    validations: null,
    disputes: null,
    changes: null,
    actions: 'development',
    proposals: 'development',
    plans: 'development',
    handovers: 'talent',
});

const K = () => require('./KpiService');
const on = (flags, m) => m === null || !!(flags && flags[m] === true);

/** { count, oldestDays, over7 } from ages in whole days. Pure. */
function ageLine(ages) {
    const list = (ages || [])
        .map((x) => (x === null || x === undefined || x === '' ? NaN : Number(x)))
        .filter((x) => Number.isFinite(x));
    if (!list.length) return { count: 0, oldestDays: null, over7: null };
    return {
        count: list.length,
        oldestDays: Math.max(0, Math.max(...list)),
        over7: list.filter((x) => x > LATE_DAYS).length,
    };
}

/** A read that fails is « unavailable », never 0. */
async function safely(fn) {
    try {
        return await fn();
    } catch (_) {
        return null;
    }
}

const ages = (rows) => (rows || []).map((r) => r.age);

/** The fixed query of each backlog line (no client value reaches the SQL text). */
const BACKLOG_SQL = Object.freeze({
    validations: `SELECT GREATEST(0, CURRENT_DATE - MIN(COALESCE(sa.submitted_at, sa.updated_at, sa.created_at))::date)::int AS "age"
                    FROM self_assessments sa
                   WHERE sa.employee_id = ANY(?) AND sa.employee_id <> ?
                     AND sa.workflow_state = 'submitted' AND sa.cancelled_at IS NULL
                   GROUP BY sa.employee_id`,
    disputes: `SELECT GREATEST(0, CURRENT_DATE - ad.opened_at::date)::int AS "age"
                 FROM assessment_disputes ad
                WHERE ad.employee_id = ANY(?) AND ad.employee_id <> ?
                  AND ad.level = 'L0' AND ad.state = 'open' AND ad.proposed_at IS NULL`,
    changes: `SELECT GREATEST(0, CURRENT_DATE - cr.created_at::date)::int AS "age"
                FROM assessment_change_requests cr
               WHERE cr.employee_id = ANY(?) AND cr.employee_id <> ?
                 AND cr.status = 'pending' AND cr.requester_ref IS DISTINCT FROM ('employee:' || ?::text)`,
    actions: `SELECT GREATEST(0, CURRENT_DATE - a.reported_done_at::date)::int AS "age"
                FROM idp_actions a JOIN idp_plans p ON p.id = a.idp_id
               WHERE p.employee_id = ANY(?) AND p.employee_id <> ?
                 AND a.reported_done_at IS NOT NULL AND a.status::text NOT IN ('completed', 'cancelled')`,
    proposals: `SELECT GREATEST(0, CURRENT_DATE - dp.created_at::date)::int AS "age"
                  FROM dev_proposals dp
                 WHERE dp.employee_id = ANY(?) AND dp.employee_id <> ?
                   AND dp.status = 'pending' AND dp.routed_to = 'line'`,
    plans: `SELECT x.state, x.late FROM (
                SELECT status::text AS "state", (CURRENT_DATE - ends_on)::int AS "late", employee_id
                  FROM idp_plans WHERE ends_on IS NOT NULL
                UNION ALL
                SELECT state::text, (CURRENT_DATE - target_date)::int, employee_id
                  FROM coaching_plans WHERE target_date IS NOT NULL
            ) x WHERE x.employee_id = ANY(?) AND x.employee_id <> ?`,
    handovers: `SELECT GREATEST(0, CURRENT_DATE - hp.due_date)::int AS "age"
                  FROM handover_plans hp
                 WHERE hp.status::text IN ('open', 'in_progress') AND hp.due_date < CURRENT_DATE
                   AND (hp.outgoing_employee_id = ANY(?) OR hp.incoming_employee_id = ANY(?))
                   AND EXISTS (SELECT 1 FROM handover_items hi
                                WHERE hi.handover_id = hp.id AND hi.status::text IN ('open', 'in_progress'))`,
    safety: `SELECT COALESCE(s.enforced_status, s.status) AS "enforced",
                    GREATEST(0, CURRENT_DATE - s.changed_at::date)::int AS "age"
               FROM safety_gate_status s
              WHERE s.employee_id = ANY(?) AND s.employee_id <> ?`,
});

/**
 * « Waiting on me ». `ids`: the manager's resolved, cleared population.
 * @returns {Promise<{lines:Array, total:number, oldestDays:number|null, top:object|null}>}
 */
async function backlog({ viewer, ids, flags = {}, caps = {} }) {
    const me = viewer && viewer.id != null ? Number(viewer.id) : 0;
    const list = (ids || []).map(Number).filter(Number.isFinite);
    const lines = [];
    const line = (key, measured, extra = {}) => {
        const base = { key, href: HREF[key], ...extra };
        if (measured === null) lines.push({ ...base, unavailable: true, count: null });
        else lines.push({ ...base, ...measured });
    };
    for (const key of BACKLOG_ORDER) {
        if (!on(flags, LINE_MODULE[key])) continue;
        if (key === 'safety') {
            if (!caps.safety) continue;
            const rows = await safely(() => db.all(BACKLOG_SQL.safety, [list, me]));
            if (rows === null) line(key, null, { mandatory: true });
            else if (!rows.length)
                lines.push({
                    key,
                    href: HREF[key],
                    mandatory: true,
                    notConfigured: true,
                    count: null,
                });
            else
                line(
                    key,
                    ageLine(
                        rows
                            .filter((r) => String(r.enforced).toUpperCase() === 'BLOCKED')
                            .map((r) => r.age)
                    ),
                    { mandatory: true }
                );
            continue;
        }
        if (key === 'plans') {
            const rows = await safely(() => db.all(BACKLOG_SQL.plans, [list, me]));
            const P = require('../utils/kpiPredicates');
            line(
                key,
                rows === null
                    ? null
                    : ageLine(
                          rows
                              .filter(
                                  (r) => P.isPlanActive(r.state) && Number(r.late) > PLAN_LATE_DAYS
                              )
                              .map((r) => Number(r.late))
                      ),
                { ageKind: 'late' }
            );
            continue;
        }
        if (key === 'handovers') {
            const rows = await safely(() => db.all(BACKLOG_SQL.handovers, [list, list]));
            line(key, rows === null ? null : ageLine(ages(rows)), { ageKind: 'late' });
            continue;
        }
        const params = key === 'changes' ? [list, me, me] : [list, me];
        const rows = await safely(() => db.all(BACKLOG_SQL[key], params));
        line(key, rows === null ? null : ageLine(ages(rows)));
    }
    return summarise(lines);
}

/** Totals and the top task (the first line, in BACKLOG_ORDER, with something waiting). Pure. */
function summarise(lines) {
    const waiting = (lines || []).filter((l) => Number(l.count) > 0);
    const known = waiting.map((l) => l.oldestDays).filter((x) => x !== null && x !== undefined);
    const top = waiting[0] || null;
    return {
        lines: lines || [],
        total: waiting.reduce((s, l) => s + Number(l.count), 0),
        oldestDays: known.length ? Math.max(...known) : null,
        top: top
            ? {
                  key: top.key,
                  count: top.count,
                  oldestDays: top.oldestDays,
                  href: top.href,
                  ageKind: top.ageKind || null,
              }
            : null,
    };
}

/** « Expiring in my team » from the K8 result (people counts). Pure. */
function expiry(k8) {
    if (!k8 || k8.emptyScope) return { state: 'no_population' };
    if (k8.status === 'not_configured' || !k8.breakdown) return { state: 'not_configured' };
    const b = k8.breakdown;
    return {
        state: 'ok',
        expiring90: Number(b.expiringPeople) || 0,
        expiring30: Number(b.expiring30People) || 0,
        expired: Number(b.expiredPeople) || 0,
        missing: Number(b.missingPeople) || 0,
        requiredPeople: Number(b.requiredPeople) || 0,
        href: HREF.expiry,
    };
}

/** The best outcome per person over their target roles: ready > to_assess > gap. Pure. */
function bestPerPerson(classified) {
    const rank = { ready: 3, to_assess: 2, gap: 1 };
    const per = new Map();
    for (const c of classified || []) {
        if (!c || !rank[c.outcome]) continue;
        const prev = per.get(c.empId);
        if (!prev || rank[c.outcome] > rank[prev]) per.set(c.empId, c.outcome);
    }
    let ready = 0;
    let toAssess = 0;
    for (const v of per.values()) {
        if (v === 'ready') ready++;
        else if (v === 'to_assess') toAssess++;
    }
    return { withTarget: per.size, readyForTarget: ready, toAssess };
}

/** One person × target role facts → 'ready' | 'to_assess' | 'gap' | null (no requirement). Pure. */
function targetOutcome(f, threshold) {
    const c = K().classifyReadiness(f, threshold);
    if (c.state === 'ready') return 'ready';
    if (c.state === 'partial' || c.state === 'not_assessed')
        return f.critAssessed - f.critMet > 0 ? 'gap' : 'to_assess';
    if (c.state === 'not_ready') return 'gap';
    return null;
}

/**
 * « Ready to move on ». `people`: KpiService.readinessBundle(...).people of the
 * manager's population. null when neither the talent nor the mobility module
 * is on (no target role can exist): the block is left out.
 */
async function readyToGrow({ people, threshold, flags = {} }) {
    const succession = on(flags, 'talent');
    const wishes = on(flags, 'mobility');
    if (!succession && !wishes) return null;
    const ready = (people || []).filter((p) => p.state === 'ready');
    const out = {
        readyNow: ready.length,
        withTarget: 0,
        readyForTarget: 0,
        toAssess: 0,
        href: HREF.ready,
    };
    if (!ready.length) return out;
    const rIds = ready.map((p) => Number(p.id));
    const current = new Map(
        ready.map((p) => [Number(p.id), p.roleId == null ? null : Number(p.roleId)])
    );
    const parts = [];
    const params = [];
    if (succession) {
        parts.push(`SELECT s.candidate_employee_id AS emp_id, sp.position_role_id AS role_id
                      FROM successors s
                      JOIN succession_plans sp ON sp.id = s.plan_id AND sp.status::text <> 'archived'
                     WHERE s.state = 'active' AND s.candidate_employee_id = ANY(?)
                       AND s.candidate_employee_id IS DISTINCT FROM sp.incumbent_employee_id`);
        params.push(rIds);
    }
    if (wishes) {
        parts.push(`SELECT a.employee_id AS emp_id, a.target_role_id AS role_id
                      FROM employee_aspirations a
                     WHERE a.employee_id = ANY(?) AND a.target_role_id IS NOT NULL`);
        params.push(rIds);
    }
    const targets = await db.all(
        `SELECT DISTINCT t.emp_id AS "empId", t.role_id AS "roleId"
           FROM (${parts.join(' UNION ')}) t WHERE t.role_id IS NOT NULL`,
        params
    );
    const pairs = (targets || [])
        .map((r) => ({ empId: Number(r.empId), roleId: Number(r.roleId) }))
        .filter((r) => r.roleId !== current.get(r.empId));
    if (!pairs.length) return out;
    const credited = require('../utils/capability').creditedSql('g.eff', 'g.req');
    const facts = await db.all(
        `WITH x AS (
             SELECT * FROM unnest(?::bigint[], ?::bigint[]) AS t(role_id, emp_id)
         ), g AS (
             SELECT x.role_id, x.emp_id, rsr.required_level AS req, rsr.is_critical AS crit,
                    (ra.level IS NOT NULL) AS assessed,
                    CASE WHEN cl.employee_id IS NOT NULL THEN 0
                         ELSE COALESCE(ra.level::integer, 0) END AS eff
               FROM x
               JOIN role_skill_requirements rsr ON rsr.role_id = x.role_id AND rsr.required_level > 0
               LEFT JOIN v_resolved_assessments ra ON ra.employee_id = x.emp_id AND ra.skill_id = rsr.skill_id
               LEFT JOIN v_certification_lapsed cl ON cl.employee_id = x.emp_id AND cl.skill_id = rsr.skill_id
         )
         SELECT g.emp_id AS "empId", g.role_id AS "roleId",
                COUNT(*)::int AS "totalReq",
                COUNT(*) FILTER (WHERE g.assessed)::int AS "assessed",
                SUM(${credited})::int AS "ptsGained",
                SUM(g.req)::int AS "ptsReq",
                COALESCE(SUM(${credited}) FILTER (WHERE g.assessed), 0)::int AS "ptsGainedAssessed",
                COALESCE(SUM(g.req) FILTER (WHERE g.assessed), 0)::int AS "ptsReqAssessed",
                COUNT(*) FILTER (WHERE g.crit)::int AS "critTotal",
                COUNT(*) FILTER (WHERE g.crit AND g.assessed)::int AS "critAssessed",
                COUNT(*) FILTER (WHERE g.crit AND g.assessed AND g.eff >= g.req)::int AS "critMet"
           FROM g GROUP BY g.emp_id, g.role_id`,
        [pairs.map((p) => p.roleId), pairs.map((p) => p.empId)]
    );
    const classified = (facts || []).map((f) => {
        const n = {};
        for (const [k, v] of Object.entries(f)) n[k] = Number(v) || 0;
        return { empId: n.empId, outcome: targetOutcome(n, threshold) };
    });
    return { ...out, ...bestPerPerson(classified) };
}

/**
 * The manager home's extra reads on the context of DashboardHomeService.
 * @param {object} ctx  DashboardHomeService.context(...) of a manager
 * @param {object} o    { k8: the K8 result already computed (or undefined),
 *                        bundle: KpiService.readinessBundle result }
 */
async function forManager(ctx, { k8, bundle } = {}) {
    const ids = (ctx && ctx.pop && ctx.pop.ids) || [];
    if (!ids.length) return { empty: true };
    const flags = (ctx && ctx.flags) || {};
    const caps = (ctx && ctx.caps) || {};
    const [bl, rd] = await Promise.all([
        backlog({ viewer: ctx.user, ids, flags, caps }),
        bundle
            ? readyToGrow({ people: bundle.people, threshold: bundle.threshold, flags }).catch(
                  () => ({ unavailable: true })
              )
            : Promise.resolve(null),
    ]);
    return {
        empty: false,
        backlog: bl,
        expiry: caps.safety ? expiry(k8) : null,
        ready: rd,
    };
}

module.exports = {
    LATE_DAYS,
    PLAN_LATE_DAYS,
    BACKLOG_ORDER,
    HREF,
    LINE_MODULE,
    ageLine,
    summarise,
    expiry,
    bestPerPerson,
    targetOutcome,
    backlog,
    readyToGrow,
    forManager,
};
