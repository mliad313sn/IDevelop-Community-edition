'use strict';

/**
 * ExecutiveKpiService — four indicators of the KPI module written for the
 * board pack (4.0.0 port, wave 9), registered in KpiService CONTRACTS and
 * born on contract kpi-2:
 *
 *   K17  Validation lead time            core
 *        How long a submitted self-assessment waits for its decision: a
 *        Kaplan–Meier median (the rounds still waiting are CENSORED at their
 *        age, never dropped), a P90 from 10 approvals, and the backlog in age
 *        bands. Targetable, lower is better, in days.
 *   K19  Capability lost to departures   talent module
 *        What the leavers took away, as CAPTURED at the leaver event
 *        (captureLeaverCapability, called by LifecycleService.onLeaver into
 *        lifecycle_events.payload.capability). Never reconstructed from
 *        today's requirements: before the first capture, « insufficient
 *        history ».
 *   K20  Legal safety exposure           core
 *        People on a legally mandatory safety requirement who do not meet
 *        it. Never « compliant » while anyone is exposed.
 *   K21  Key roles exposed               talent module
 *        Critical roles without a ready successor whose holder is at high
 *        risk of leaving. A flight risk never reviewed is « not assessed »,
 *        never « low ».
 *
 * Every function follows the contract of KpiService (population of the
 * reader's clearance, not measured is null and never 0, fewer than 5 people
 * give counts and no figure that could identify, bands from kpiPredicates).
 * NO PERSON NAME and no person id leaves a result: counts, and the ids of
 * sites and role families only.
 */

const db = require('../config/database');
const P = require('../utils/kpiPredicates');

const K = () => require('./KpiService');
const { STATUS, SMALL_N, READINESS } = P;
const round1 = (v) => Math.round(v * 10) / 10;
const base = (kpi) => ({ kpi, freshness: 'live', asOf: new Date().toISOString() });

function emptyResult(kpi, extra = {}) {
    return {
        ...base(kpi),
        value: null,
        rawValue: null,
        numerator: 0,
        denominator: 0,
        n: 0,
        status: STATUS.NOT_MEASURED,
        emptyScope: true,
        drill: [],
        ...extra,
    };
}

// ---------------------------------------------------------------------------
// K17 Validation lead time
// ---------------------------------------------------------------------------

/** Workflow states of a round SUBMITTED and still waiting for its decision. */
const K17_WAITING_STATES = Object.freeze(['submitted', 'under_review', 'reviewed', 'arbitration']);
/** Waiting longer than this is late (the dashboard's validation rule). */
const K17_LATE_DAYS = 7;
const K17_WINDOWS = Object.freeze([30, 90, 365]);
/** No P90 from fewer approvals than this (the P90 of 5 is the maximum). */
const K17_P90_MIN_N = 10;

/** Linear-interpolation quantile of a SORTED array; null when empty. Pure. */
function quantile(sorted, q) {
    if (!sorted.length) return null;
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return round1(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo));
}

/** Backlog age bands in days: up to 7, 8 to 30, over 30. Pure. */
function k17Bands(waitingDays) {
    const b = { total: 0, upTo7: 0, d8to30: 0, over30: 0 };
    for (const d of waitingDays || []) {
        if (d === null || d === undefined || !Number.isFinite(Number(d))) continue;
        const x = Number(d);
        b.total++;
        if (x <= K17_LATE_DAYS) b.upTo7++;
        else if (x <= 30) b.d8to30++;
        else b.over30++;
    }
    return b;
}

/**
 * The K17 figures from its facts. Pure.
 *   approvedLead  lead times (days) of the rounds submitted in the window and approved
 *   waitingRounds ages (days) of the rounds submitted in the window and still waiting
 *   backlogPeople ages (days) of the PEOPLE waiting now (oldest submission), whatever the window
 */
function k17FromFacts({ approvedLead, waitingRounds, backlogPeople }) {
    const lead = (approvedLead || [])
        .map(Number)
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
    const censored = (waitingRounds || []).map(Number).filter(Number.isFinite);
    const backlog = k17Bands(backlogPeople);
    const late = backlog.d8to30 + backlog.over30;
    const n = lead.length;
    const out = {
        numerator: null,
        denominator: n,
        n,
        p90: null,
        medianBeyond: null,
        censored: censored.length,
        backlog,
        late,
    };
    const submitted = n + censored.length + backlog.total;
    if (!submitted) return { ...out, value: null, rawValue: null, status: STATUS.NOT_MEASURED };
    const km = K().kmQuantile(lead, censored, 0.5);
    // the median is not reached when fewer than half were decided: « beyond »
    const median = km !== null ? km : censored.length ? null : quantile(lead, 0.5);
    const status = late > 0 ? STATUS.WATCH : null;
    if (n < SMALL_N) {
        return { ...out, value: null, rawValue: median, status: n ? STATUS.SMALL_N : status };
    }
    return {
        ...out,
        value: median,
        rawValue: median,
        medianBeyond:
            median === null
                ? round1(Math.max(...lead, ...(censored.length ? censored : [0])))
                : null,
        p90: n >= K17_P90_MIN_N ? K().kmQuantile(lead, censored, 0.9) : null,
        status,
    };
}

/**
 * K17 « Validation lead time ». Rounds of the population submitted in the
 * window (30, 90 or 365 days; 90 by default), neither cancelled nor
 * superseded. A round never submitted is not in the population (never
 * « 0 days »). Value: the median days from submission to approval. The
 * backlog is THE « waiting for validation » of the Assessments tab: people
 * with a self-assessment in state 'submitted', since their oldest
 * submission. Status: « watch » when someone waits more than 7 days;
 * informational otherwise. Counts per site, never a reviewer.
 */
async function k17ValidationLeadTime(scope, { windowDays = 90 } = {}) {
    const win = K17_WINDOWS.includes(Number(windowDays)) ? Number(windowDays) : 90;
    const pop = await K().resolvePopulation(scope);
    if (!pop.ids.length) return emptyResult('K17', { window: win, backlog: k17Bands([]) });
    const rows = await db.all(
        `SELECT r.employee_id AS "employeeId", r.workflow_state AS "state",
                EXTRACT(EPOCH FROM (r.approved_at - r.submitted_at)) / 86400.0 AS "leadDays",
                EXTRACT(EPOCH FROM (now() - r.submitted_at)) / 86400.0 AS "waitDays"
           FROM self_assessment_rounds r
          WHERE r.employee_id = ANY(?)
            AND r.submitted_at IS NOT NULL
            AND r.submitted_at >= now() - make_interval(days => ?::int)
            AND r.cancelled_at IS NULL
            AND r.superseded_at IS NULL`,
        [pop.ids, win]
    );
    const pending = await db.all(
        `SELECT sa.employee_id AS "employeeId",
                MIN(COALESCE(sa.submitted_at, sa.updated_at, sa.created_at)) AS "since"
           FROM self_assessments sa
          WHERE sa.employee_id = ANY(?) AND sa.workflow_state = 'submitted'
            AND sa.cancelled_at IS NULL
          GROUP BY sa.employee_id`,
        [pop.ids]
    );
    const siteKey = (id) => (id == null ? 'none' : String(id));
    const siteOf = new Map(pop.rows.map((p) => [p.id, siteKey(p.siteId)]));
    const siteName = new Map(pop.rows.map((p) => [siteKey(p.siteId), p.siteName]));
    const perSite = new Map();
    const cell = (k) => {
        if (!perSite.has(k)) perSite.set(k, { lead: [], waiting: [] });
        return perSite.get(k);
    };
    const approvedLead = [];
    const waitingRounds = [];
    for (const r of rows || []) {
        if (r.state === 'approved' && r.leadDays !== null) {
            const d = Math.max(0, Number(r.leadDays));
            approvedLead.push(d);
            cell(siteOf.get(Number(r.employeeId))).lead.push(d);
        } else if (K17_WAITING_STATES.includes(r.state) && r.waitDays !== null) {
            waitingRounds.push(Math.max(0, Number(r.waitDays)));
        }
    }
    const backlogPeople = [];
    const now = Date.now();
    for (const r of pending || []) {
        const t = r.since ? new Date(r.since).getTime() : NaN;
        if (!Number.isFinite(t)) continue;
        const d = Math.max(0, (now - t) / 86400000);
        backlogPeople.push(d);
        cell(siteOf.get(Number(r.employeeId))).waiting.push(d);
    }
    const bySite = [...perSite.entries()]
        .map(([k, c]) => {
            const s = [...c.lead].sort((a, b) => a - b);
            const bands = k17Bands(c.waiting);
            return {
                siteId: k === 'none' ? null : Number(k),
                noSite: k === 'none',
                siteName: k === 'none' ? null : siteName.get(k) || null,
                approved: s.length,
                median: s.length >= SMALL_N ? quantile(s, 0.5) : null,
                smallN: s.length > 0 && s.length < SMALL_N,
                waiting: bands.total,
                late: bands.d8to30 + bands.over30,
            };
        })
        .sort(
            (a, b) =>
                b.late - a.late || String(a.siteName || '').localeCompare(String(b.siteName || ''))
        );
    return {
        ...base('K17'),
        window: win,
        unit: 'days',
        ...k17FromFacts({ approvedLead, waitingRounds, backlogPeople }),
        bySite,
        drill: [],
    };
}

// ---------------------------------------------------------------------------
// K19 Capability lost to departures (talent module)
// ---------------------------------------------------------------------------

/** Version of the capture written into lifecycle_events.payload.capability. */
const K19_CAPTURE_VERSION = 'kpi-2';
const K19_WINDOWS = Object.freeze([90, 365]);

/**
 * What a LEAVER takes away, read AT THE EVENT and before the person is
 * switched off. Called by LifecycleService.onLeaver; the result is written
 * into lifecycle_events.payload.capability. Ids and counts only:
 *   { v, capturedAt, readiness ('ready' | 'not_ready' | 'partial' |
 *     'not_assessed' | 'no_requirement'), soleCritical (critical skills of the
 *     person's site that nobody else active holds at the required level),
 *     siteId, departmentId, roleId }
 * Returns null when the person cannot be read (the event stays « not measured »).
 */
async function captureLeaverCapability(employeeId) {
    const id = Number(employeeId);
    if (!Number.isInteger(id) || id <= 0) return null;
    const emp = await db.get(
        `SELECT id, site_id AS "siteId", department_id AS "departmentId", role_id AS "roleId"
           FROM employees WHERE id = ?`,
        [id]
    );
    if (!emp) return null;
    const Kpi = K();
    const threshold = await Kpi.readinessThreshold();
    const facts = await Kpi.readinessFacts([id]);
    const state = Kpi.classifyReadiness(facts.get(id) || null, threshold).state;
    const site = emp.siteId == null ? null : Number(emp.siteId);
    const sole = await db.get(
        `WITH mine AS (
             SELECT g.skill_id FROM v_employee_skill_gaps g
              WHERE g.employee_id = ? AND g.is_critical AND g.is_assessed = 1 AND g.is_met = 1
         )
         SELECT COUNT(*)::int AS "n" FROM mine m
          WHERE NOT EXISTS (
                SELECT 1 FROM v_employee_skill_gaps g
                  JOIN employees e ON e.id = g.employee_id
                 WHERE g.skill_id = m.skill_id AND g.employee_id <> ?
                   AND g.is_assessed = 1 AND g.is_met = 1
                   AND e.is_active = true AND e.erased_at IS NULL AND e.cancelled_at IS NULL
                   AND e.site_id IS NOT DISTINCT FROM ?::bigint)`,
        [id, id, site]
    );
    return {
        v: K19_CAPTURE_VERSION,
        capturedAt: new Date().toISOString(),
        readiness: state,
        soleCritical: sole ? Number(sole.n) || 0 : 0,
        siteId: site,
        departmentId: emp.departmentId == null ? null : Number(emp.departmentId),
        roleId: emp.roleId == null ? null : Number(emp.roleId),
    };
}

/** The captured capability of an event payload, or null. Pure. */
function capabilityOf(payload) {
    const c = payload && typeof payload === 'object' ? payload.capability : null;
    return c && typeof c === 'object' && !Array.isArray(c) && typeof c.readiness === 'string'
        ? c
        : null;
}

/** Does a leaver row fall in the scope's site / department (as captured)? Pure. */
function leaverInScope(row, scope) {
    const s = scope || {};
    const cap = capabilityOf(row.payload);
    const site =
        cap && 'siteId' in cap ? cap.siteId : row.siteId == null ? null : Number(row.siteId);
    const dept =
        cap && 'departmentId' in cap
            ? cap.departmentId
            : row.departmentId == null
              ? null
              : Number(row.departmentId);
    if (s.siteId === 'none' || s.siteId === null) {
        if (site !== null) return false;
    } else if (s.siteId !== undefined && s.siteId !== '') {
        if (site === null || Number(site) !== Number(s.siteId)) return false;
    }
    if (s.departmentId !== undefined && s.departmentId !== null && s.departmentId !== '') {
        if (dept === null || Number(dept) !== Number(s.departmentId)) return false;
    }
    return true;
}

/** The K19 figures from the leaver rows in scope. Pure. */
function k19FromRows(list, captureSince) {
    let measured = 0;
    let ready = 0;
    let soleHolder = 0;
    for (const r of list) {
        const cap = capabilityOf(r.payload);
        if (!cap) continue;
        measured++;
        if (cap.readiness === READINESS.READY) ready++;
        if (Number(cap.soleCritical) > 0) soleHolder++;
    }
    const out = {
        leavers: list.length,
        measured,
        unmeasured: list.length - measured,
        readyAtDeparture: measured ? ready : null,
        soleHolderAtDeparture: measured ? soleHolder : null,
        captureSince: captureSince || null,
        insufficientHistory: !captureSince,
        numerator: null,
        denominator: list.length,
        n: list.length,
    };
    if (!captureSince || (list.length && !measured))
        return { ...out, value: null, rawValue: null, status: STATUS.NOT_MEASURED };
    return {
        ...out,
        value: measured ? ready : null,
        rawValue: measured ? ready : null,
        status: null,
    };
}

/**
 * K19 « Capability lost to departures ». Leaver events processed and not
 * reverted, effective in the window (90 days or 12 months; 12 months by
 * default), of people inside the reader's clearance (leavers included), not
 * erased, narrowed by the site and department CAPTURED at the event. Counts:
 * leavers; ready for their role when they left; sole holders of a critical
 * skill of their site when they left; leavers processed before the capture
 * existed, apart (« not measured before … »). Informational.
 */
async function k19CapabilityLost(scope, { windowDays = 365 } = {}) {
    const win = K19_WINDOWS.includes(Number(windowDays)) ? Number(windowDays) : 365;
    const s = scope || {};
    if (!s.system && !s.viewer) throw new Error('ExecutiveKpiService: scope.viewer is required');
    let where = 'e.erased_at IS NULL AND e.cancelled_at IS NULL';
    const params = [win];
    if (!s.system) {
        const RBACService = require('./RBACService');
        const sc = await RBACService.scopeFilter(s.viewer, {
            empAlias: 'e',
            includeInactive: true,
        });
        where += sc.clause || '';
        params.push(...(sc.params || []));
    }
    if (Array.isArray(s.employeeIds)) {
        const ids = s.employeeIds.map(Number).filter(Number.isFinite);
        if (!ids.length) return emptyResult('K19', { window: win, freshness: 'captured' });
        where += ' AND e.id = ANY(?)';
        params.push(ids);
    }
    const rows = await db.all(
        `SELECT e.site_id AS "siteId", e.department_id AS "departmentId", le.payload AS "payload"
           FROM lifecycle_events le
           JOIN employees e ON e.id = le.employee_id
          WHERE le.kind = 'leaver' AND le.processed_at IS NOT NULL AND le.reverted_at IS NULL
            AND COALESCE(le.effective_at, le.occurred_at) >= now() - make_interval(days => ?::int)
            AND ${where}`,
        params
    );
    const since = await db.get(
        `SELECT to_char(MIN(le.processed_at), 'YYYY-MM-DD') AS "d"
           FROM lifecycle_events le
          WHERE le.kind = 'leaver' AND jsonb_typeof(le.payload->'capability') = 'object'`
    );
    const list = (rows || []).filter((r) => leaverInScope(r, s));
    return {
        ...base('K19'),
        freshness: 'captured',
        window: win,
        ...k19FromRows(list, since && since.d ? since.d : null),
        drill: [],
    };
}

// ---------------------------------------------------------------------------
// K20 Legal safety exposure
// ---------------------------------------------------------------------------

/** Blocking reasons that say « not shown », not « known to fail ». */
const UNDEMONSTRATED = new Set(['not_assessed', 'level_not_validated']);

/**
 * K20 « Legal safety exposure ». Population: people whose role (and site,
 * when the rule is bound to one) carries an active, legally mandatory safety
 * rule. Value: those with a blocking reason on such a rule — failed, lapsed,
 * missing, too old or NOT SHOWN (a legal duty without evidence is an
 * exposure). A legally mandatory rule cannot be waived, so no waiver hides
 * anyone here. Beside it: the waivers in force (any rule), their count,
 * people and the age of the oldest chain. No legally mandatory rule for
 * anyone in scope: « not configured », never 0. Band: 0 compliant, 1 or
 * more at risk: never « compliant » while one person is exposed. Counts per
 * site; a site under 5 people is folded into one row.
 */
async function k20LegalSafetyExposure(scope) {
    const pop = await K().resolvePopulation(scope);
    if (!pop.ids.length) return emptyResult('K20', { waivers: null, bySite: [] });
    const rules = await db.all(
        `SELECT role_id AS "roleId", site_id AS "siteId", mode
           FROM safety_gate_rules
          WHERE is_active = true AND legally_mandatory = true`
    );
    const covered = pop.rows.filter((p) =>
        (rules || []).some(
            (r) =>
                p.roleId != null &&
                Number(r.roleId) === p.roleId &&
                (r.siteId == null || Number(r.siteId) === p.siteId)
        )
    );
    const waivers = await k20Waivers(pop.ids);
    const out = {
        ...base('K20'),
        numerator: null,
        denominator: covered.length,
        n: covered.length,
        waivers,
        legalRules: (rules || []).length,
        // stored as « observe » but enforced anyway: a legal rule always is
        observeStored: (rules || []).filter((r) => r.mode === 'observe').length,
        drill: [],
    };
    if (!covered.length) {
        return {
            ...out,
            value: null,
            rawValue: null,
            status: STATUS.NOT_CONFIGURED,
            breakdown: { covered: 0, exposed: 0, knownFail: 0, notShown: 0 },
            bySite: [],
        };
    }
    const results = await require('./SafetyGateService').computeFor(
        { employeeIds: covered.map((p) => p.id) },
        null,
        { record: false }
    );
    const exposed = new Set();
    let knownFail = 0;
    let notShown = 0;
    for (const r of results || []) {
        const legal = (r.reasons || []).filter(
            (x) => x.blocking && x.legallyMandatory && !x.waived
        );
        if (!legal.length) continue;
        exposed.add(Number(r.employeeId != null ? r.employeeId : r.id));
        if (legal.some((x) => !UNDEMONSTRATED.has(x.code))) knownFail++;
        else notShown++;
    }
    return {
        ...out,
        ...k20FromCounts(covered, exposed),
        breakdown: { covered: covered.length, exposed: exposed.size, knownFail, notShown },
    };
}

/** Value, status and the per-site counts (small sites folded together). Pure. */
function k20FromCounts(covered, exposedIds) {
    const sites = new Map();
    for (const p of covered) {
        const k = p.siteId == null ? 'none' : String(p.siteId);
        if (!sites.has(k))
            sites.set(k, {
                siteId: p.siteId == null ? null : p.siteId,
                noSite: p.siteId == null,
                siteName: p.siteId == null ? null : p.siteName || null,
                covered: 0,
                exposed: 0,
            });
        const s = sites.get(k);
        s.covered++;
        if (exposedIds.has(p.id)) s.exposed++;
    }
    const big = [];
    const small = {
        siteId: null,
        noSite: false,
        folded: true,
        siteName: null,
        covered: 0,
        exposed: 0,
    };
    for (const s of sites.values()) {
        if (s.covered < SMALL_N) {
            small.covered += s.covered;
            small.exposed += s.exposed;
        } else big.push(s);
    }
    big.sort(
        (a, b) =>
            b.exposed - a.exposed ||
            String(a.siteName || '').localeCompare(String(b.siteName || ''))
    );
    if (small.covered) big.push(small);
    const value = exposedIds.size;
    return {
        value,
        rawValue: value,
        status: value > 0 ? STATUS.AT_RISK : STATUS.COMPLIANT,
        bySite: big,
    };
}

/** The waivers in force for a set of people: { count, people, oldestDays }, counts only. */
async function k20Waivers(ids) {
    if (!ids || !ids.length) return { count: 0, people: 0, oldestDays: null };
    const row = await db.get(
        `WITH RECURSIVE live AS (
             SELECT w.id, w.employee_id, w.renewal_of, w.starts_at
               FROM safety_gate_waivers w
              WHERE w.employee_id = ANY(?) AND w.state = 'active'
                AND w.starts_at <= now() AND w.expires_at > now()
         ), chain AS (
             SELECT l.id AS leaf, l.renewal_of, l.starts_at, 0 AS depth FROM live l
             UNION ALL
             SELECT c.leaf, p.renewal_of, p.starts_at, c.depth + 1
               FROM chain c JOIN safety_gate_waivers p ON p.id = c.renewal_of
              WHERE c.depth < 200
         ), firsts AS (
             SELECT leaf, MIN(starts_at) AS first_start FROM chain GROUP BY leaf
         )
         SELECT (SELECT COUNT(*) FROM live)::int AS "count",
                (SELECT COUNT(DISTINCT employee_id) FROM live)::int AS "people",
                (SELECT FLOOR(EXTRACT(EPOCH FROM (now() - MIN(first_start))) / 86400)::int
                   FROM firsts) AS "oldestDays"`,
        [ids]
    );
    const count = row ? Number(row.count) || 0 : 0;
    return {
        count,
        people: row ? Number(row.people) || 0 : 0,
        oldestDays: count && row && row.oldestDays !== null ? Number(row.oldestDays) : null,
    };
}

// ---------------------------------------------------------------------------
// K21 Key roles exposed (talent module)
// ---------------------------------------------------------------------------

/** Flight-risk levels that make a holder « at risk of leaving » (enum risk_level). */
const K21_FLIGHT_RISK = Object.freeze(['high']);

/** May this reader see a flight-risk aggregate (K21)? The retention-risk clearance. */
function canSeeFlightRisk(user) {
    const RBACService = require('./RBACService');
    const u = user || {};
    if (RBACService.isSuperAdmin(u)) return true;
    if (u.userType !== 'admin') return false;
    return (
        RBACService.hasPermission(u, 'view_retention_risk') ||
        RBACService.hasPermission(u, 'manage_retention_risk')
    );
}

/**
 * Classify the critical roles without a ready successor by what is known of
 * their holders' flight risk. `flight` maps a holder id to 'low' | 'medium' |
 * 'high' | null (null: never reviewed). Pure.
 */
function k21Classify(uncovered, holders, flight) {
    const fam = new Map();
    let exposed = 0;
    let notAssessed = 0;
    let controlled = 0;
    for (const role of uncovered) {
        const levels = holders
            .filter((p) => p.roleId === role.roleId)
            .map((p) => (flight.has(p.id) ? flight.get(p.id) : null));
        let kind;
        if (levels.some((l) => K21_FLIGHT_RISK.includes(l))) kind = 'exposed';
        else if (levels.some((l) => l === null || l === undefined)) kind = 'notAssessed';
        else kind = 'controlled';
        if (kind === 'exposed') exposed++;
        else if (kind === 'notAssessed') notAssessed++;
        else controlled++;
        const k = role.familyId == null ? 'none' : String(role.familyId);
        if (!fam.has(k))
            fam.set(k, {
                familyId: role.familyId == null ? null : role.familyId,
                familyName: role.familyId == null ? null : role.familyName || null,
                noFamily: role.familyId == null,
                exposed: 0,
                notAssessed: 0,
                controlled: 0,
            });
        fam.get(k)[kind]++;
    }
    const byFamily = [...fam.values()].sort(
        (a, b) =>
            b.exposed - a.exposed ||
            b.notAssessed - a.notAssessed ||
            String(a.familyName || '').localeCompare(String(b.familyName || ''))
    );
    return { exposed, notAssessed, controlled, byFamily };
}

/**
 * K21 « Key roles exposed ». Population: the critical roles with a holder in
 * the scope (the K5 / K6 facts, so K21 never exceeds K6). Value: critical
 * roles WITHOUT a ready successor whose holder in scope has a HIGH flight
 * risk. A flight risk never reviewed (no row, or NULL) is « not assessed »
 * and counted apart, never taken as « low ». No critical role: « not
 * configured ». Every uncovered role not assessed: « not measured », never a
 * green 0. Bands as K6; a 0 with roles not assessed carries no chip.
 */
async function k21KeyRolesExposed(scope) {
    const Kpi = K();
    const { pop, roles } = await Kpi.benchFacts(scope);
    if (!pop.ids.length) return emptyResult('K21', { byFamily: [], breakdown: null });
    const out = { ...base('K21'), numerator: null, denominator: null, drill: [] };
    if (!roles || !roles.length) {
        return {
            ...out,
            value: null,
            rawValue: null,
            n: 0,
            status: STATUS.NOT_CONFIGURED,
            breakdown: {
                criticalRoles: 0,
                uncovered: 0,
                exposed: 0,
                notAssessed: 0,
                controlled: 0,
            },
            byFamily: [],
        };
    }
    const uncovered = roles.filter((r) => !r.ready);
    const uncoveredIds = new Set(uncovered.map((r) => r.roleId));
    const holders = pop.rows.filter((p) => p.roleId != null && uncoveredIds.has(p.roleId));
    const risks = holders.length
        ? await db.all(
              `SELECT employee_id AS "employeeId", flight_risk::text AS "flight"
                 FROM retention_risk WHERE employee_id = ANY(?)`,
              [holders.map((p) => p.id)]
          )
        : [];
    // NULL (never reviewed) stays NULL: never the column default 'low'
    const flight = new Map((risks || []).map((r) => [Number(r.employeeId), r.flight || null]));
    const c = k21Classify(uncovered, holders, flight);
    const breakdown = {
        criticalRoles: roles.length,
        uncovered: uncovered.length,
        exposed: c.exposed,
        notAssessed: c.notAssessed,
        controlled: c.controlled,
    };
    if (uncovered.length && !c.exposed && c.notAssessed === uncovered.length) {
        return {
            ...out,
            value: null,
            rawValue: null,
            n: roles.length,
            status: STATUS.NOT_MEASURED,
            breakdown,
            byFamily: c.byFamily,
        };
    }
    let status = P.statusBand(c.exposed, 'K6');
    if (c.exposed === 0 && c.notAssessed > 0) status = null;
    return {
        ...out,
        value: c.exposed,
        rawValue: c.exposed,
        n: roles.length,
        status,
        breakdown,
        byFamily: c.byFamily,
    };
}

module.exports = {
    K17_WAITING_STATES,
    K17_LATE_DAYS,
    K17_WINDOWS,
    K17_P90_MIN_N,
    K19_WINDOWS,
    K19_CAPTURE_VERSION,
    K21_FLIGHT_RISK,
    quantile,
    k17Bands,
    k17FromFacts,
    k17ValidationLeadTime,
    captureLeaverCapability,
    capabilityOf,
    leaverInScope,
    k19FromRows,
    k19CapabilityLost,
    k20LegalSafetyExposure,
    k20FromCounts,
    k20Waivers,
    canSeeFlightRisk,
    k21Classify,
    k21KeyRolesExposed,
};
