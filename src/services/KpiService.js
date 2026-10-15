'use strict';

/**
 * KpiService: the KPI module. ONE function per indicator (K1 to K16; there is
 * no K10). Reports, the report builder, the API, the Power BI feed and the
 * daily snapshots call these functions; nothing else computes an indicator.
 *
 * ---------------------------------------------------------------------------
 * CONTRACT (common to every indicator)
 *   Population   active employees, NOT erased, not a cancelled hire, inside
 *                the reader's clearance (RBACService.scopeFilter, the app's one
 *                clearance rule), narrowed by siteId / departmentId /
 *                employeeIds (never widened). Leavers and erased people are
 *                out for EVERY role, SuperAdmin included.
 *   Unmeasured   a separate count, never folded into a failure or a 0.
 *                Denominator 0 gives value null and status 'not_measured'.
 *   Small n      fewer than 5 PEOPLE behind a % gives value null and status
 *                'small_n'; numerator and denominator are still returned so a
 *                page can print "2 of 3".
 *   Bands        kpiPredicates.statusBand; threshold = app_readiness_threshold()
 *                (one source).
 *   Drill        `drill` is the exact list behind the figure: for a % the
 *                DENOMINATOR (numerator in `numeratorDrill`), for a count the
 *                counted items. drill.length is the count or the denominator.
 *   Freshness    'live' (computed on request); `asOf` ISO timestamp.
 *   Requirements the FULL requirement set the department designed for the
 *                role (role_skill_requirements, required_level > 0): nothing
 *                samples, tiers or trims it.
 *   Modules      each indicator belongs to the core or to one optional module
 *                (CONTRACTS[id].module). An indicator whose module is off is
 *                OMITTED (availableKpis / computeAvailable): it is never shown
 *                as "not measured", and no list link points into a module
 *                that is off.
 *
 * RESULT SHAPE (every K function)
 *   { kpi, value: number|null, rawValue, numerator, denominator, n,
 *     coverage?, status, breakdown?, drill: [], numeratorDrill?: [],
 *     emptyScope?: true, threshold?, freshness: 'live', asOf }
 *   status: compliant | watch | at_risk | not_measured | not_configured |
 *           small_n | null (null = informational, no band)
 *   rawValue = the % before small-n suppression (snapshots store it; pages
 *   print `value`).
 *
 * SCOPE
 *   { viewer: req.user-like, siteId?: number|'none', departmentId?: number,
 *     employeeIds?: number[], modules?: {module: boolean} }
 *   or { system: true } for the snapshot job (organisation truth, no reader).
 *   A scope with neither is refused (no silent unrestricted read).
 * ---------------------------------------------------------------------------
 */

const db = require('../config/database');
const P = require('../utils/kpiPredicates');

/**
 * Version of the KPI definitions. Written on every snapshot row
 * (kpi_snapshots.kpi_contract, migration 184): a change across versions is
 * never shown as a movement.
 */
const CONTRACT_VERSION = 'kpi-1';
const { STATUS, SMALL_N, READINESS: R } = P;

/**
 * Per-indicator contract: owner, freshness, unit, band source, the module it
 * belongs to (null = core) and `list`, the navigation entry
 * (src/config/navigation.js CATALOGUE id) that holds the list behind the
 * figure, or null when no page lists it yet.
 */
const CONTRACTS = Object.freeze({
    K1: Object.freeze({
        id: 'K1',
        module: null,
        owner: 'hr_director',
        freshness: 'live_snapshot',
        unit: 'pct',
        list: 'readiness',
    }),
    K2: Object.freeze({
        id: 'K2',
        module: null,
        owner: 'hr_director',
        freshness: 'live_snapshot',
        unit: 'pct',
        list: 'readiness',
    }),
    K3: Object.freeze({
        id: 'K3',
        module: null,
        owner: 'training',
        freshness: 'live_snapshot',
        unit: 'pct',
        list: 'readiness',
    }),
    K4: Object.freeze({
        id: 'K4',
        module: null,
        owner: 'hr_director_hse',
        freshness: 'live_snapshot',
        unit: 'pct',
        list: 'gaps_report',
    }),
    K5: Object.freeze({
        id: 'K5',
        module: 'talent',
        owner: 'hr_director',
        freshness: 'live',
        unit: 'pct',
        list: 'continuity',
    }),
    K6: Object.freeze({
        id: 'K6',
        module: 'talent',
        owner: 'hr_director',
        freshness: 'live',
        unit: 'count',
        list: 'continuity',
    }),
    K7: Object.freeze({
        id: 'K7',
        module: 'talent',
        owner: 'site',
        freshness: 'live',
        unit: 'count',
        list: 'key_people',
    }),
    K8: Object.freeze({
        id: 'K8',
        module: null,
        owner: 'hse',
        freshness: 'live_snapshot',
        unit: 'count',
        list: 'compliance',
    }),
    K9: Object.freeze({
        id: 'K9',
        module: null,
        owner: 'hse',
        freshness: 'live_snapshot',
        unit: 'pct',
        list: 'safety_gate',
    }),
    K11: Object.freeze({
        id: 'K11',
        module: 'campaigns',
        owner: 'hr_local',
        freshness: 'live',
        unit: 'pct',
        list: 'cycles',
    }),
    K12: Object.freeze({
        id: 'K12',
        module: 'development',
        owner: 'training',
        freshness: 'live',
        unit: 'level',
        list: null,
    }),
    K13: Object.freeze({
        id: 'K13',
        module: 'development',
        owner: 'training',
        freshness: 'live',
        unit: 'pct',
        list: 'dev_plans',
    }),
    K14: Object.freeze({
        id: 'K14',
        module: 'mobility',
        owner: 'hr_director',
        freshness: 'live',
        unit: 'days',
        list: null,
    }),
    K15: Object.freeze({
        id: 'K15',
        module: 'development',
        owner: 'training',
        freshness: 'live',
        unit: 'count',
        list: null,
    }),
    K16: Object.freeze({
        id: 'K16',
        module: null,
        owner: 'managers',
        freshness: 'live',
        unit: 'count',
        list: null,
    }),
});

/**
 * The plan types of K16. Development plans are core (the person's own plan
 * is core); performance plans and coaching belong to the development module.
 * A type whose module is off is left out of K16 entirely (not counted, no
 * list link).
 */
const PLAN_TYPES = Object.freeze([
    Object.freeze({ type: 'pip', module: 'development', list: 'pip' }),
    Object.freeze({ type: 'idp', module: null, list: 'dev_plans' }),
    Object.freeze({ type: 'coaching', module: 'development', list: 'coaching' }),
]);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;
const asOf = () => new Date().toISOString();
const truthy = (x) => x === true || x === 't';
const byId = (a, b) => a - b;

function base(kpi) {
    return { kpi, freshness: 'live', asOf: asOf() };
}

/** A % result with the common rules applied (denominator 0, small n, bands). */
function pctResult(kpi, numerator, denominator, n, { threshold, extra = {} } = {}) {
    const out = { ...base(kpi), numerator, denominator, n, ...extra };
    if (!denominator) {
        return { ...out, value: null, rawValue: null, status: STATUS.NOT_MEASURED };
    }
    // A safety or compliance % (K4, K9) rounds DOWN (1 999 fit of 2 000 is
    // 99.9 %, never "100.0 %") and is never compliant while one falls short.
    const safety = P.isSafetyPct(kpi);
    const exact = (100 * numerator) / denominator;
    const raw = safety
        ? require('../utils/displayedValue').displayedValue(exact, 'pct1Floor')
        : round1(exact);
    if (n < SMALL_N) return { ...out, value: null, rawValue: raw, status: STATUS.SMALL_N };
    let status = P.statusBand(raw, kpi, { threshold });
    if (safety && status === STATUS.COMPLIANT && Number(numerator) < Number(denominator))
        status = STATUS.WATCH;
    return { ...out, value: raw, rawValue: raw, status };
}

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

async function readinessThreshold() {
    const row = await db.get('SELECT app_readiness_threshold() AS "t"');
    const t = row ? Number(row.t) : NaN;
    return Number.isFinite(t) ? t : 80;
}

/** The database calendar day (CURRENT_DATE) as YYYY-MM-DD: one clock for every window. */
async function dbToday() {
    const row = await db.get(`SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS "d"`);
    return row ? row.d : null;
}

// ---------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------

/** The module of an indicator: null = core, undefined = unknown indicator. */
function moduleOf(kpiId) {
    const c = Object.prototype.hasOwnProperty.call(CONTRACTS, kpiId) ? CONTRACTS[kpiId] : null;
    return c ? c.module : undefined;
}

/** True when the indicator exists and its module (if any) is on in `flags`. */
function isAvailable(kpiId, flags) {
    const m = moduleOf(kpiId);
    if (m === undefined) return false;
    if (m === null) return true;
    return !!(flags && flags[m] === true);
}

/** The indicators shown under the given module flags, in catalogue order. */
function availableKpis(flags) {
    return Object.keys(CONTRACTS).filter((id) => isAvailable(id, flags));
}

/** The K16 plan types shown under the given module flags. */
function availablePlanTypes(flags) {
    return PLAN_TYPES.filter((t) => t.module === null || !!(flags && flags[t.module] === true));
}

/** The module flags of a scope: given by the caller, or the organisation's. */
async function scopeModules(scope) {
    if (scope && scope.system === true) return null; // organisation truth: every type
    if (scope && scope.modules && typeof scope.modules === 'object') return scope.modules;
    try {
        return await require('./ModuleService').flags();
    } catch (_) {
        return {};
    }
}

// ---------------------------------------------------------------------------
// Population
// ---------------------------------------------------------------------------

/**
 * Resolve the population of a scope ONCE: active, not erased, inside the
 * reader's clearance, narrowed by site / department / ids.
 * @returns {Promise<{ids:number[], rows:Array<{id,siteId,siteName,departmentId,roleId}>, system:boolean}>}
 */
async function resolvePopulation(scope = {}) {
    if (scope && scope.__population) return scope.__population;
    const s = scope || {};
    const system = s.system === true;
    if (!system && !s.viewer) throw new Error('KpiService: scope.viewer is required');

    let where = 'e.is_active = true AND e.erased_at IS NULL AND e.cancelled_at IS NULL';
    const params = [];
    if (!system) {
        const RBACService = require('./RBACService');
        const sc = await RBACService.scopeFilter(s.viewer, { empAlias: 'e' });
        where += sc.clause || '';
        params.push(...(sc.params || []));
    }
    if (s.siteId === 'none' || s.siteId === null) {
        where += ' AND e.site_id IS NULL';
    } else if (s.siteId !== undefined && s.siteId !== '') {
        const sid = Number(s.siteId);
        if (!Number.isFinite(sid)) return { ids: [], rows: [], system };
        where += ' AND e.site_id = ?';
        params.push(sid);
    }
    if (s.departmentId !== undefined && s.departmentId !== null && s.departmentId !== '') {
        const did = Number(s.departmentId);
        if (!Number.isFinite(did)) return { ids: [], rows: [], system };
        where += ' AND e.department_id = ?';
        params.push(did);
    }
    if (Array.isArray(s.employeeIds)) {
        const ids = s.employeeIds.map(Number).filter(Number.isFinite);
        if (!ids.length) return { ids: [], rows: [], system };
        where += ' AND e.id = ANY(?)';
        params.push(ids);
    }
    const rows = await db.all(
        `SELECT e.id AS "id", e.site_id AS "siteId", st.name AS "siteName",
                e.department_id AS "departmentId", e.role_id AS "roleId"
           FROM employees e
           LEFT JOIN sites st ON st.id = e.site_id
          WHERE ${where}
          ORDER BY e.id`,
        params
    );
    const norm = (rows || []).map((r) => ({
        id: Number(r.id),
        siteId: r.siteId == null ? null : Number(r.siteId),
        siteName: r.siteName || null,
        departmentId: r.departmentId == null ? null : Number(r.departmentId),
        roleId: r.roleId == null ? null : Number(r.roleId),
    }));
    return { ids: norm.map((r) => r.id), rows: norm, system };
}

/** A sub-population (already resolved, already cleared) usable as a scope. */
function subScope(pop, rows) {
    return { __population: { ids: rows.map((r) => r.id), rows, system: pop.system } };
}

// ---------------------------------------------------------------------------
// Readiness facts (K1 to K4 share ONE read of v_employee_skill_gaps)
// ---------------------------------------------------------------------------

/**
 * Per-person requirement facts over the FULL requirement set.
 * @returns {Promise<Map<number, object>>}
 */
async function readinessFacts(ids) {
    if (!ids.length) return new Map();
    const rows = await db.all(
        `SELECT g.employee_id AS "employeeId",
                COUNT(*)::int AS "totalReq",
                SUM(g.is_assessed)::int AS "assessed",
                SUM(LEAST(g.actual_level, g.required_level))::int AS "ptsGained",
                SUM(g.required_level)::int AS "ptsReq",
                SUM(CASE WHEN g.is_assessed = 1 THEN LEAST(g.actual_level, g.required_level) ELSE 0 END)::int AS "ptsGainedAssessed",
                SUM(CASE WHEN g.is_assessed = 1 THEN g.required_level ELSE 0 END)::int AS "ptsReqAssessed",
                SUM(CASE WHEN g.is_critical THEN 1 ELSE 0 END)::int AS "critTotal",
                SUM(CASE WHEN g.is_critical AND g.is_assessed = 1 THEN 1 ELSE 0 END)::int AS "critAssessed",
                SUM(CASE WHEN g.is_critical AND g.is_assessed = 1 AND g.is_met = 1 THEN 1 ELSE 0 END)::int AS "critMet"
           FROM v_employee_skill_gaps g
          WHERE g.employee_id = ANY(?)
          GROUP BY g.employee_id`,
        [ids]
    );
    const m = new Map();
    for (const r of rows || []) {
        m.set(Number(r.employeeId), {
            totalReq: Number(r.totalReq) || 0,
            assessed: Number(r.assessed) || 0,
            ptsGained: Number(r.ptsGained) || 0,
            ptsReq: Number(r.ptsReq) || 0,
            ptsGainedAssessed: Number(r.ptsGainedAssessed) || 0,
            ptsReqAssessed: Number(r.ptsReqAssessed) || 0,
            critTotal: Number(r.critTotal) || 0,
            critAssessed: Number(r.critAssessed) || 0,
            critMet: Number(r.critMet) || 0,
        });
    }
    return m;
}

/**
 * The four-state readiness of ONE person (pure).
 *   ready          every requirement assessed AND readiness >= threshold AND
 *                  every critical requirement met
 *   not_ready      an ASSESSED critical requirement not met (a known fail), OR
 *                  fully assessed and below
 *   not_assessed   requirements exist, none assessed
 *   partial        anything else (some evidence, no verdict)
 *   no_requirement no requirement for the person's role: not measurable,
 *                  outside the four states and outside every denominator.
 * readiness = points over the full set; readinessAssessed = over the assessed
 * requirements only (display variant).
 */
function classifyReadiness(f, threshold = 80) {
    if (!f || !f.totalReq) {
        return { state: R.NO_REQUIREMENT, readiness: null, readinessAssessed: null };
    }
    const readiness = f.ptsReq > 0 ? round1((100 * f.ptsGained) / f.ptsReq) : null;
    const readinessAssessed =
        f.ptsReqAssessed > 0 ? round1((100 * f.ptsGainedAssessed) / f.ptsReqAssessed) : null;
    const critFailed = f.critAssessed - f.critMet;
    let state;
    if (critFailed > 0) state = R.NOT_READY;
    else if (f.assessed >= f.totalReq) {
        const exact = f.ptsReq > 0 ? (100 * f.ptsGained) / f.ptsReq : 0;
        state = exact >= threshold && f.critMet === f.critTotal ? R.READY : R.NOT_READY;
    } else if (f.assessed === 0) state = R.NOT_ASSESSED;
    else state = R.PARTIAL;
    return { state, readiness, readinessAssessed };
}

async function readinessBundle(scope) {
    const pop = await resolvePopulation(scope);
    const threshold = await readinessThreshold();
    const facts = await readinessFacts(pop.ids);
    const people = pop.rows.map((r) => {
        const f = facts.get(r.id) || null;
        return { ...r, facts: f, ...classifyReadiness(f, threshold) };
    });
    return { pop, threshold, people };
}

function coverageOf(people) {
    let assessed = 0;
    let expected = 0;
    for (const p of people) {
        if (!p.facts) continue;
        assessed += p.facts.assessed;
        expected += p.facts.totalReq;
    }
    return { assessed, expected, pct: expected ? round1((100 * assessed) / expected) : null };
}

/** The state lists of a readiness bundle, keyed by the five fixed state codes. */
function byState(people) {
    const by = {
        ready: [],
        not_ready: [],
        partial: [],
        not_assessed: [],
        no_requirement: [],
    };
    for (const p of people) {
        if (p.state === R.READY) by.ready.push(p.id);
        else if (p.state === R.NOT_READY) by.not_ready.push(p.id);
        else if (p.state === R.PARTIAL) by.partial.push(p.id);
        else if (p.state === R.NOT_ASSESSED) by.not_assessed.push(p.id);
        else by.no_requirement.push(p.id);
    }
    return by;
}

// ---------------------------------------------------------------------------
// K1 Role-ready rate
// ---------------------------------------------------------------------------

/**
 * K1 Role-ready rate. Ready / (Ready + Not ready). "Partially assessed" and
 * "Not assessed" are counts beside it, never in the %. Printed with "of N
 * assessed, coverage Y %". Snapshot: role_ready_count, not_ready_count,
 * partial_count, unassessed_count.
 */
async function k1RoleReady(scope) {
    const { pop, threshold, people } = await readinessBundle(scope);
    if (!pop.ids.length) return emptyResult('K1', { threshold });
    const by = byState(people);
    const den = by.ready.length + by.not_ready.length;
    const cov = coverageOf(people);
    return {
        ...pctResult('K1', by.ready.length, den, den, {
            threshold,
            extra: {
                threshold,
                coverage: cov.pct,
                breakdown: {
                    ready: by.ready.length,
                    notReady: by.not_ready.length,
                    partial: by.partial.length,
                    notAssessed: by.not_assessed.length,
                    noRequirement: by.no_requirement.length,
                    population: pop.ids.length,
                },
                drillByState: by,
            },
        }),
        drill: [...by.ready, ...by.not_ready],
        numeratorDrill: by.ready,
    };
}

// ---------------------------------------------------------------------------
// K2 Average readiness
// ---------------------------------------------------------------------------

/**
 * K2 Average readiness: mean points-based readiness over the ASSESSED
 * requirements of the people with at least one assessed requirement.
 */
async function k2AvgReadiness(scope) {
    const { pop, threshold, people } = await readinessBundle(scope);
    if (!pop.ids.length) return emptyResult('K2', { threshold });
    const measured = people.filter(
        (p) => p.facts && p.facts.assessed > 0 && p.readinessAssessed != null
    );
    const n = measured.length;
    const out = {
        ...base('K2'),
        numerator: null,
        denominator: n,
        n,
        threshold,
        drill: measured.map((p) => p.id),
    };
    if (!n) return { ...out, value: null, rawValue: null, status: STATUS.NOT_MEASURED };
    const mean = round1(measured.reduce((a, p) => a + p.readinessAssessed, 0) / n);
    out.coverage = coverageOf(people).pct;
    if (n < SMALL_N) return { ...out, value: null, rawValue: mean, status: STATUS.SMALL_N };
    return { ...out, value: mean, rawValue: mean, status: P.statusBand(mean, 'K2', { threshold }) };
}

// ---------------------------------------------------------------------------
// K3 Assessment coverage
// ---------------------------------------------------------------------------

/**
 * K3 Assessment coverage: assessed (person x requirement) / expected (person x
 * requirement) over the FULL requirement set. Below 50 it is "insufficient
 * coverage" (amber, never red; `lowCoverage: true`).
 */
async function k3Coverage(scope) {
    const { pop, threshold, people } = await readinessBundle(scope);
    if (!pop.ids.length) return emptyResult('K3', { threshold });
    const withReq = people.filter((p) => p.facts && p.facts.totalReq > 0);
    const cov = coverageOf(withReq);
    const r = pctResult('K3', cov.assessed, cov.expected, withReq.length, {
        threshold,
        extra: {
            threshold,
            breakdown: { assessedRequirements: cov.assessed, expectedRequirements: cov.expected },
        },
    });
    if (r.rawValue != null && r.rawValue < 50) r.lowCoverage = true;
    return { ...r, drill: withReq.map((p) => p.id) };
}

// ---------------------------------------------------------------------------
// K4 Critical-skill compliance
// ---------------------------------------------------------------------------

/**
 * K4 Critical-skill compliance: critical requirements met / critical
 * requirements ASSESSED; "not demonstrated" (never assessed) is its own count
 * (criticalUnassessed), never a failure. No critical requirement in scope
 * gives 'not_configured'.
 */
async function k4CriticalCompliance(scope) {
    const { pop, threshold, people } = await readinessBundle(scope);
    if (!pop.ids.length) return emptyResult('K4');
    let met = 0;
    let assessed = 0;
    let total = 0;
    const den = [];
    const numIds = [];
    const notDemonstrated = [];
    for (const p of people) {
        if (!p.facts || !p.facts.critTotal) continue;
        total += p.facts.critTotal;
        if (p.facts.critAssessed < p.facts.critTotal) notDemonstrated.push(p.id);
        if (p.facts.critAssessed > 0) {
            assessed += p.facts.critAssessed;
            met += p.facts.critMet;
            den.push(p.id);
            if (p.facts.critMet === p.facts.critAssessed) numIds.push(p.id);
        }
    }
    const r = pctResult('K4', met, assessed, den.length, {
        threshold,
        extra: {
            breakdown: {
                criticalMet: met,
                criticalAssessed: assessed,
                criticalUnassessed: total - assessed,
                criticalTotal: total,
            },
        },
    });
    if (!total) r.status = STATUS.NOT_CONFIGURED;
    return { ...r, drill: den, numeratorDrill: numIds, drillNotDemonstrated: notDemonstrated };
}

// ---------------------------------------------------------------------------
// K7 Single points of failure
// ---------------------------------------------------------------------------

/**
 * K7 Single points of failure: (site x critical skill) cells held at the
 * required level by exactly ONE person of the scope. Holder = a person whose
 * role requires the skill, assessed at or above the required level,
 * certificate not lapsed (v_employee_skill_gaps.is_met). Holders are counted
 * INSIDE the reader's population only: a narrow scope can report a sole
 * holder the wider organisation covers. No critical cell gives
 * 'not_configured'; no holder measured gives 'not_measured'.
 * drill = cells [{siteId, skillId, employeeId}].
 */
async function k7SoleHolders(scope) {
    const pop = await resolvePopulation(scope);
    if (!pop.ids.length) return emptyResult('K7');
    const rows = await db.all(
        `SELECT e.site_id AS "siteId", g.skill_id AS "skillId",
                bool_or(g.is_critical) AS "critical",
                COUNT(*) FILTER (WHERE g.is_assessed = 1)::int AS "measured",
                COUNT(*) FILTER (WHERE g.is_assessed = 1 AND g.is_met = 1)::int AS "holders",
                MIN(g.employee_id) FILTER (WHERE g.is_assessed = 1 AND g.is_met = 1) AS "holderId"
           FROM v_employee_skill_gaps g
           JOIN employees e ON e.id = g.employee_id
          WHERE g.employee_id = ANY(?)
          GROUP BY e.site_id, g.skill_id`,
        [pop.ids]
    );
    const crit = (rows || []).filter((r) => truthy(r.critical));
    const cells = crit.filter((r) => Number(r.holders) === 1);
    const measuredCells = crit.filter((r) => Number(r.measured) > 0).length;
    const breakdown = {
        criticalCells: crit.length,
        measuredCells,
        neverMeasured: crit.length - measuredCells,
        noQualified: crit.filter((r) => Number(r.measured) > 0 && Number(r.holders) === 0).length,
        covered: crit.filter((r) => Number(r.holders) >= 2).length,
    };
    const drill = cells.map((r) => ({
        siteId: r.siteId == null ? null : Number(r.siteId),
        skillId: Number(r.skillId),
        employeeId: Number(r.holderId),
    }));
    const out = {
        ...base('K7'),
        numerator: cells.length,
        denominator: null,
        n: pop.ids.length,
        breakdown,
        drill,
    };
    if (!crit.length)
        return { ...out, value: null, rawValue: null, status: STATUS.NOT_CONFIGURED, drill: [] };
    if (!measuredCells)
        return { ...out, value: null, rawValue: null, status: STATUS.NOT_MEASURED, drill: [] };
    return {
        ...out,
        value: cells.length,
        rawValue: cells.length,
        status: P.statusBand(cells.length, 'K7'),
    };
}

// ---------------------------------------------------------------------------
// K8 Certifications expired / expiring within 90 days
// ---------------------------------------------------------------------------

/**
 * The REQUIRED certificates of a set of people, one row per (employee, skill)
 * with the latest non-revoked certificate (or none). Required = a requirement
 * of the person's role on a skill whose policy is a certification, or an
 * active safety-gate rule with cert_required (role, site or all sites).
 */
async function requiredCertRows(ids) {
    if (!ids.length) return [];
    return db.all(
        `WITH pop AS (
             SELECT e.id, e.role_id, e.site_id FROM employees e WHERE e.id = ANY(?)
         ), req AS (
             SELECT p.id AS employee_id, rsr.skill_id
               FROM pop p
               JOIN role_skill_requirements rsr ON rsr.role_id = p.role_id AND rsr.required_level > 0
               JOIN skill_certification_policies scp ON scp.skill_id = rsr.skill_id AND scp.is_certification
             UNION
             SELECT p.id, gr.skill_id
               FROM pop p
               JOIN safety_gate_rules gr ON gr.role_id = p.role_id AND gr.is_active AND gr.cert_required
                AND (gr.site_id IS NULL OR gr.site_id = p.site_id)
         )
         SELECT r.employee_id AS "employeeId", r.skill_id AS "skillId",
                c.certification_id AS "certId",
                to_char(c.expires_on, 'YYYY-MM-DD') AS "expiresOn"
           FROM req r
           LEFT JOIN v_certification_current c ON c.employee_id = r.employee_id AND c.skill_id = r.skill_id`,
        [ids]
    );
}

/**
 * K8 Certifications: PEOPLE with at least one required certificate expired
 * (value, drill), expiring within 90 days (drillExpiring, of which 30 days a
 * sub-set) and never recorded (drillMissing). Nothing required in scope gives
 * 'not_configured' (never 0). Expired >= 1 is at risk; otherwise a required
 * certificate never recorded is watch; compliant only when nothing is expired
 * and every required certificate is recorded.
 */
async function k8Certifications(scope) {
    const pop = await resolvePopulation(scope);
    if (!pop.ids.length) return emptyResult('K8', { drillExpiring: [] });
    const today = await dbToday();
    const rows = await requiredCertRows(pop.ids);
    if (!rows || !rows.length) {
        return {
            ...base('K8'),
            value: null,
            rawValue: null,
            numerator: null,
            denominator: 0,
            n: 0,
            status: STATUS.NOT_CONFIGURED,
            breakdown: null,
            drill: [],
            drillExpiring: [],
        };
    }
    const expiredP = new Set();
    const expiringP = new Set();
    const soonP = new Set();
    const requiredP = new Set();
    const missingP = new Set();
    let expiredCerts = 0;
    let expiringCerts = 0;
    let missingCerts = 0;
    for (const r of rows) {
        const id = Number(r.employeeId);
        requiredP.add(id);
        if (r.certId == null) {
            missingCerts++;
            missingP.add(id);
            continue;
        }
        const w = P.certWindow(r.expiresOn, today);
        if (w === 'expired') {
            expiredCerts++;
            expiredP.add(id);
        } else if (w === 'within_90d') {
            expiringCerts++;
            expiringP.add(id);
            if (P.certWithin30(r.expiresOn, today)) soonP.add(id);
        }
    }
    const value = expiredP.size;
    let status = P.statusBand(value, 'K8');
    if (status === STATUS.COMPLIANT && missingP.size > 0) status = STATUS.WATCH;
    return {
        ...base('K8'),
        value,
        rawValue: value,
        numerator: value,
        denominator: requiredP.size,
        n: requiredP.size,
        status,
        expiringWarn: expiringP.size > 0,
        breakdown: {
            expiredPeople: expiredP.size,
            expiringPeople: expiringP.size,
            expiring30People: soonP.size,
            missingPeople: missingP.size,
            expiredCerts,
            expiringCerts,
            missingCerts,
            requiredPeople: requiredP.size,
            requiredCerts: rows.length,
        },
        drill: [...expiredP].sort(byId),
        drillExpiring: [...expiringP].sort(byId),
        drillExpiring30: [...soonP].sort(byId),
        drillMissing: [...missingP].sort(byId),
    };
}

// ---------------------------------------------------------------------------
// K9 Safety-gate fitness
// ---------------------------------------------------------------------------

const SAFETY_UNDEMONSTRATED = new Set(['not_assessed', 'level_not_validated']);

/**
 * K9 Safety-gate fitness: share of the people on a safety-gated role who meet
 * every BLOCKING safety requirement today. Source: SafetyGateService.computeFor
 * (read-only, record: false), ENFORCED answer (observe-mode rules never block).
 * A running waiver is NOT fitness (counted in `waived`). A person whose only
 * blocking reasons are "not assessed / not validated" is "not demonstrated"
 * (its own count, outside the %); a KNOWN failure is in the denominator as
 * unfit even when another requirement is unassessed. No gated role in scope
 * gives 'not_configured'.
 */
async function k9SafetyFitness(scope) {
    const pop = await resolvePopulation(scope);
    if (!pop.ids.length) return emptyResult('K9');
    const SafetyGateService = require('./SafetyGateService');
    const results = await SafetyGateService.computeFor({ employeeIds: pop.ids }, null, {
        record: false,
    });
    const fit = [];
    const unfit = [];
    const undemonstrated = [];
    const waived = [];
    // Which blocking requirement each unfit person misses: ids and codes, no name.
    const unfitDetail = [];
    let gated = 0;
    for (const r of results || []) {
        const eff = r.enforcedStatus || r.status;
        if (eff === 'NOT_CONFIGURED') continue;
        gated++;
        const id = Number(r.employeeId);
        if (eff === 'CLEARED' || eff === 'EXPIRING') {
            fit.push(id);
            continue;
        }
        const blocking = (r.reasons || []).filter((x) => x.blocking && !x.observe);
        const knownFail = blocking.some((x) => !SAFETY_UNDEMONSTRATED.has(x.code));
        if (eff === 'WAIVED') waived.push(id);
        if (knownFail || eff === 'WAIVED') {
            unfit.push(id);
            unfitDetail.push({
                employeeId: id,
                waived: eff === 'WAIVED',
                reasons: blocking.map((x) => ({
                    code: x.code,
                    skillId: x.skillId == null ? null : Number(x.skillId),
                })),
            });
        } else undemonstrated.push(id);
    }
    if (!gated) {
        return {
            ...base('K9'),
            value: null,
            rawValue: null,
            numerator: null,
            denominator: 0,
            n: 0,
            status: STATUS.NOT_CONFIGURED,
            breakdown: { gated: 0 },
            drill: [],
        };
    }
    const den = fit.length + unfit.length;
    return {
        ...pctResult('K9', fit.length, den, den, {
            extra: {
                breakdown: {
                    gated,
                    fit: fit.length,
                    unfit: unfit.length,
                    notDemonstrated: undemonstrated.length,
                    waived: waived.length,
                },
                drillNotDemonstrated: undemonstrated,
                unfitDetail,
            },
        }),
        drill: [...fit, ...unfit],
        numeratorDrill: fit,
    };
}

// ---------------------------------------------------------------------------
// K11 Current campaign progress
// ---------------------------------------------------------------------------

/**
 * Approved self-assessment rounds of `ids` that belong to ANOTHER campaign or
 * to none, approved since the campaign opened (all of them when it has no
 * opening date). { rounds, people }: counts, work the campaign figure would
 * otherwise hide.
 */
async function approvedOutsideCampaign(ids, campaign) {
    if (!Array.isArray(ids) || !ids.length || !campaign || campaign.id == null)
        return { rounds: 0, people: 0 };
    const row = await db.get(
        `SELECT COUNT(*)::int AS "rounds", COUNT(DISTINCT r.employee_id)::int AS "people"
           FROM self_assessment_rounds r
          WHERE r.employee_id = ANY(?) AND r.status = 'approved'
            AND (r.cycle_id IS NULL OR r.cycle_id <> ?)
            AND (?::timestamptz IS NULL
                 OR COALESCE(r.approved_at, r.updated_at, r.created_at) >= ?::timestamptz)`,
        [ids, Number(campaign.id), campaign.openedAt || null, campaign.openedAt || null]
    );
    return { rounds: Number((row && row.rounds) || 0), people: Number((row && row.people) || 0) };
}

/**
 * K11 Current campaign progress: the funnel of each CURRENT campaign
 * (invited, started, submitted, validated), several returned separately and
 * never added up. None gives 'not_measured' with noCampaign: true ("No
 * campaign in progress", not 0 %). Headline = validated / invited; band
 * time-aware (campaignBand). When a campaign has activity but no step stamp
 * at all, started / submitted are null and stepsTracked false. The top-level
 * value is always null (see `campaigns[]`).
 */
async function k11CurrentCampaign(scope) {
    const pop = await resolvePopulation(scope);
    const campaigns = await P.currentCampaigns();
    const out = {
        ...base('K11'),
        value: null,
        rawValue: null,
        numerator: null,
        denominator: null,
        n: pop.ids.length,
    };
    if (!campaigns.length) {
        return { ...out, status: STATUS.NOT_MEASURED, noCampaign: true, campaigns: [], drill: [] };
    }
    const list = [];
    for (const c of campaigns) {
        const rows = pop.ids.length
            ? await db.all(
                  `SELECT p.employee_id AS "employeeId",
                          (p.started_at IS NOT NULL) AS "startedStamp",
                          (p.submitted_at IS NOT NULL) AS "submittedStamp",
                          v.participant_state AS "state",
                          EXISTS (SELECT 1 FROM self_assessments sa
                                   WHERE sa.cycle_id = p.cycle_id AND sa.employee_id = p.employee_id) AS "hasWork"
                     FROM cycle_participants p
                     JOIN v_cycle_participant_status v ON v.cycle_id = p.cycle_id AND v.employee_id = p.employee_id
                    WHERE p.cycle_id = ? AND p.excluded_at IS NULL AND p.employee_id = ANY(?)`,
                  [c.id, pop.ids]
              )
            : [];
        const invited = rows.map((r) => Number(r.employeeId));
        const validated = rows
            .filter((r) => r.state === 'approved')
            .map((r) => Number(r.employeeId));
        const anyStamp = rows.some((r) => truthy(r.startedStamp) || truthy(r.submittedStamp));
        const anyWork = rows.some((r) => truthy(r.hasWork));
        const stepsTracked = anyStamp || !anyWork;
        const started = stepsTracked
            ? rows.filter((r) => truthy(r.startedStamp) || truthy(r.submittedStamp)).length
            : null;
        const submitted = stepsTracked ? rows.filter((r) => truthy(r.submittedStamp)).length : null;
        const locked = String(c.status || '') === 'locked';
        const notStarted = rows.length
            ? rows.filter((r) => String(r.state) === 'not_started').length
            : null;
        let elapsedPct = null;
        const o = c.openedAt ? new Date(c.openedAt).getTime() : NaN;
        const e = c.closesAt ? new Date(c.closesAt).getTime() : NaN;
        if (Number.isFinite(o) && Number.isFinite(e) && e > o) {
            elapsedPct = round1(Math.min(100, Math.max(0, (100 * (Date.now() - o)) / (e - o))));
        }
        if (locked) elapsedPct = 100; // the employee window has ended
        const r = pctResult('K11', validated.length, invited.length, invited.length);
        if (r.value != null) r.status = P.campaignBand(r.value, elapsedPct);
        const outside = await approvedOutsideCampaign(pop.ids, c);
        list.push({
            ...r,
            campaign: c,
            state: locked ? 'locked' : 'open',
            elapsedPct,
            breakdown: {
                invited: invited.length,
                started,
                submitted,
                validated: validated.length,
                stepsTracked,
                notStarted,
                approvedOutsideCampaign: outside.rounds,
                peopleApprovedOutsideCampaign: outside.people,
            },
            drill: invited,
            numeratorDrill: validated,
        });
    }
    return { ...out, status: null, campaigns: list, drill: [] };
}

// ---------------------------------------------------------------------------
// K15 Level-ups (90 days)
// ---------------------------------------------------------------------------

/**
 * K15 Level-ups (90 days): distinct (employee, skill) whose last VALIDATED
 * level in the window (source other than 'self_assessment') is above the
 * level held when the window opened (else the first validated in-window
 * level): a NET increase, so 3 -> 1 -> 2 is not one. A first measurement is
 * never a level-up. No validated assessment event in the window gives
 * 'not_measured'. Informational. drill = [{employeeId, skillId}].
 */
async function k15LevelUps(scope) {
    const pop = await resolvePopulation(scope);
    if (!pop.ids.length) return emptyResult('K15');
    const VALIDATED = `h.source IS DISTINCT FROM 'self_assessment'`;
    const row = await db.get(
        `SELECT COUNT(*)::int AS "events",
                COUNT(*) FILTER (WHERE h.previous_level IS NULL)::int AS "firstMeasurements"
           FROM assessment_history h
          WHERE h.employee_id = ANY(?) AND h.assessed_at >= now() - interval '90 days'
            AND ${VALIDATED}`,
        [pop.ids]
    );
    const ups = await db.all(
        `WITH w AS (
             SELECT h.id, h.employee_id, h.skill_id, h.previous_level, h.new_level,
                    h.assessed_at, (${VALIDATED}) AS validated
               FROM assessment_history h
              WHERE h.employee_id = ANY(?) AND h.assessed_at >= now() - interval '90 days'
         ), opening AS (
             SELECT DISTINCT ON (employee_id, skill_id) employee_id, skill_id,
                    previous_level AS level
               FROM w ORDER BY employee_id, skill_id, assessed_at, id
         ), first_valid AS (
             SELECT DISTINCT ON (employee_id, skill_id) employee_id, skill_id,
                    new_level AS level
               FROM w WHERE validated ORDER BY employee_id, skill_id, assessed_at, id
         ), last_valid AS (
             SELECT DISTINCT ON (employee_id, skill_id) employee_id, skill_id,
                    new_level AS level
               FROM w WHERE validated ORDER BY employee_id, skill_id, assessed_at DESC, id DESC
         )
         SELECT l.employee_id AS "employeeId", l.skill_id AS "skillId"
           FROM last_valid l
           JOIN first_valid f ON f.employee_id = l.employee_id AND f.skill_id = l.skill_id
           JOIN opening o ON o.employee_id = l.employee_id AND o.skill_id = l.skill_id
          WHERE l.level > COALESCE(o.level, f.level)
          ORDER BY 1, 2`,
        [pop.ids]
    );
    const events = row ? Number(row.events) : 0;
    const drill = (ups || []).map((r) => ({
        employeeId: Number(r.employeeId),
        skillId: Number(r.skillId),
    }));
    const out = {
        ...base('K15'),
        numerator: drill.length,
        denominator: null,
        n: pop.ids.length,
        breakdown: { events, firstMeasurementsExcluded: row ? Number(row.firstMeasurements) : 0 },
        drill,
    };
    if (!events)
        return { ...out, value: null, rawValue: null, status: STATUS.NOT_MEASURED, drill: [] };
    return { ...out, value: drill.length, rawValue: drill.length, status: null };
}

// ---------------------------------------------------------------------------
// K16 Active plans
// ---------------------------------------------------------------------------

/**
 * The status of the late part of a volume: the volume carries no status, its
 * "of which N overdue" line does. null when nothing is late or the volume is
 * unknown; watch from 1 late; at risk above 10 % late.
 */
function overdueStatus(overdue, total) {
    const o = Number(overdue);
    const t = Number(total);
    if (!Number.isFinite(o) || o <= 0 || !Number.isFinite(t) || t <= 0) return null;
    return o / t > 0.1 ? STATUS.AT_RISK : STATUS.WATCH;
}

/** PIP counts honour clearance: SuperAdmin, dispute arbitrators, managers. */
function canSeePips(viewer) {
    if (!viewer) return false;
    const RBACService = require('./RBACService');
    if (RBACService.isSuperAdmin(viewer)) return true;
    if (RBACService.hasPermission(viewer, 'arbitrate_disputes')) return true;
    return viewer.userType === 'manager';
}

/** The fixed query of each plan type (no client value reaches the SQL text). */
const PLAN_SQL = Object.freeze({
    pip: `SELECT id, employee_id AS "employeeId", state::text AS "state",
                 to_char(ends_on, 'YYYY-MM-DD') AS "due"
            FROM pips WHERE employee_id = ANY(?)`,
    idp: `SELECT id, employee_id AS "employeeId", status::text AS "state",
                 to_char(ends_on, 'YYYY-MM-DD') AS "due"
            FROM idp_plans WHERE employee_id = ANY(?)`,
    coaching: `SELECT id, employee_id AS "employeeId", state::text AS "state",
                      to_char(target_date, 'YYYY-MM-DD') AS "due"
                 FROM coaching_plans WHERE employee_id = ANY(?)`,
});

/**
 * K16 Active plans (performance plans, development plans, coaching): one
 * count per type, ONE active predicate (kpiPredicates.isPlanActive); overdue
 * = due date before today. A type whose module is off is left out (not in
 * byType, not in the total). PIP counts only for readers cleared to see them;
 * otherwise the PIP block is { hidden: true, value: null } and is NOT in the
 * total. Status: overdue > 0 is watch. drill = [{type, planId, employeeId}].
 */
async function k16ActivePlans(scope) {
    const pop = await resolvePopulation(scope);
    const system = !!(scope && scope.system === true);
    const flags = await scopeModules(scope);
    const types = system ? PLAN_TYPES : availablePlanTypes(flags);
    const showPip = system || canSeePips(scope && scope.viewer);
    if (!pop.ids.length) {
        return emptyResult('K16', { byType: null, overdue: 0 });
    }
    const today = await dbToday();
    const byType = {};
    const drill = [];
    let overdue = 0;
    for (const t of types) {
        if (t.type === 'pip' && !showPip) {
            byType.pip = {
                hidden: true,
                value: null,
                overdue: null,
                drill: [],
                overdueDrill: [],
            };
            continue;
        }
        const rows = await db.all(PLAN_SQL[t.type], [pop.ids]);
        const active = (rows || []).filter((r) => P.isPlanActive(r.state));
        const late = active.filter((r) => P.isPlanOverdue(r.state, r.due, today));
        const item = (r) => ({
            type: t.type,
            planId: Number(r.id),
            employeeId: Number(r.employeeId),
        });
        const entry = {
            hidden: false,
            value: active.length,
            overdue: late.length,
            drill: active.map(item),
            overdueDrill: late.map(item),
        };
        if (t.type === 'pip') byType.pip = entry;
        else if (t.type === 'idp') byType.idp = entry;
        else byType.coaching = entry;
        drill.push(...entry.drill);
        overdue += late.length;
    }
    return {
        ...base('K16'),
        value: drill.length,
        rawValue: drill.length,
        numerator: drill.length,
        denominator: null,
        n: pop.ids.length,
        overdue,
        status: P.statusBand(overdue, 'K16'),
        overdueStatus: overdueStatus(overdue, drill.length),
        types: types.map((t) => t.type),
        byType,
        drill,
    };
}

// ---------------------------------------------------------------------------
// K5 / K6 Bench strength (talent module)
// ---------------------------------------------------------------------------

/**
 * The role ids (among `roleIds`) with at least one READY successor: the K1
 * rule (classifyReadiness) applied to the TARGET role's full requirement set
 * (a lapsed certificate counts as level 0). Candidate = active, not erased,
 * named on a non-archived plan of the role (successor state 'active'), not the
 * plan's incumbent. The manual readiness band of a successor is not the rule.
 * @returns {Promise<Set<number>>}
 */
async function rolesWithReadySuccessor(roleIds) {
    const out = new Set();
    if (!roleIds.length) return out;
    const pairs = await db.all(
        `SELECT DISTINCT p.position_role_id AS "roleId", s.candidate_employee_id AS "empId"
           FROM successors s
           JOIN succession_plans p ON p.id = s.plan_id AND p.status <> 'archived'
           JOIN employees c ON c.id = s.candidate_employee_id
                           AND c.is_active = true AND c.erased_at IS NULL
          WHERE p.position_role_id = ANY(?)
            AND s.state = 'active'
            AND s.candidate_employee_id IS DISTINCT FROM p.incumbent_employee_id`,
        [roleIds.map(Number)]
    );
    if (!pairs || !pairs.length) return out;
    const facts = await db.all(
        `WITH x AS (
             SELECT * FROM unnest(?::bigint[], ?::bigint[]) AS t(role_id, emp_id)
         ), g AS (
             SELECT x.role_id, x.emp_id, rsr.required_level AS req, rsr.is_critical AS crit,
                    (sa.level IS NOT NULL) AS assessed,
                    CASE WHEN cl.employee_id IS NOT NULL THEN 0
                         ELSE COALESCE(sa.level::integer, 0) END AS eff
               FROM x
               JOIN role_skill_requirements rsr ON rsr.role_id = x.role_id AND rsr.required_level > 0
               LEFT JOIN v_resolved_assessments sa ON sa.employee_id = x.emp_id AND sa.skill_id = rsr.skill_id
               LEFT JOIN v_certification_lapsed cl ON cl.employee_id = x.emp_id AND cl.skill_id = rsr.skill_id
         )
         SELECT role_id AS "roleId", emp_id AS "empId",
                COUNT(*)::int AS "totalReq",
                COUNT(*) FILTER (WHERE assessed)::int AS "assessed",
                SUM(LEAST(eff, req))::int AS "ptsGained",
                SUM(req)::int AS "ptsReq",
                COALESCE(SUM(LEAST(eff, req)) FILTER (WHERE assessed), 0)::int AS "ptsGainedAssessed",
                COALESCE(SUM(req) FILTER (WHERE assessed), 0)::int AS "ptsReqAssessed",
                COUNT(*) FILTER (WHERE crit)::int AS "critTotal",
                COUNT(*) FILTER (WHERE crit AND assessed)::int AS "critAssessed",
                COUNT(*) FILTER (WHERE crit AND assessed AND eff >= req)::int AS "critMet"
           FROM g GROUP BY role_id, emp_id`,
        [pairs.map((p) => Number(p.roleId)), pairs.map((p) => Number(p.empId))]
    );
    const threshold = await readinessThreshold();
    for (const f of facts || []) {
        const n = (v) => Number(v) || 0;
        const c = classifyReadiness(
            {
                totalReq: n(f.totalReq),
                assessed: n(f.assessed),
                ptsGained: n(f.ptsGained),
                ptsReq: n(f.ptsReq),
                ptsGainedAssessed: n(f.ptsGainedAssessed),
                ptsReqAssessed: n(f.ptsReqAssessed),
                critTotal: n(f.critTotal),
                critAssessed: n(f.critAssessed),
                critMet: n(f.critMet),
            },
            threshold
        );
        if (c.state === R.READY) out.add(Number(f.roleId));
    }
    return out;
}

/**
 * The critical roles of a scope with their bench (shared by K5 and K6).
 * Critical role = role_criticality.criticality_score >= 4 held by at least one
 * person of the scope. No successor NAME leaves this function: the bench is a
 * role-level fact and `namedSuccessors` is a count.
 */
async function benchFacts(scope) {
    const pop = await resolvePopulation(scope);
    if (!pop.ids.length) return { pop, roles: null };
    const occupants = new Map();
    for (const r of pop.rows) {
        if (r.roleId != null) occupants.set(r.roleId, (occupants.get(r.roleId) || 0) + 1);
    }
    const roleIds = [...occupants.keys()];
    if (!roleIds.length) return { pop, roles: [] };
    const rows = await db.all(
        `SELECT rc.role_id AS "roleId", r.name AS "roleName", rc.criticality_score AS "score",
                r.role_family_id AS "familyId", rf.name AS "familyName",
                (SELECT COUNT(DISTINCT s.candidate_employee_id)
                   FROM successors s
                   JOIN succession_plans p ON p.id = s.plan_id
                                          AND p.position_role_id = rc.role_id
                                          AND p.status <> 'archived'
                   JOIN employees c ON c.id = s.candidate_employee_id
                                   AND c.is_active = true AND c.erased_at IS NULL
                  WHERE s.state = 'active'
                    AND s.candidate_employee_id IS DISTINCT FROM p.incumbent_employee_id
                )::int AS "named"
           FROM role_criticality rc
           JOIN roles r ON r.id = rc.role_id
           LEFT JOIN role_families rf ON rf.id = r.role_family_id
          WHERE rc.criticality_score >= ? AND rc.role_id = ANY(?)
          ORDER BY rc.criticality_score DESC, r.name`,
        [P.CRITICAL_ROLE_MIN_SCORE, roleIds]
    );
    const list = rows || [];
    const ready = list.length
        ? await rolesWithReadySuccessor(list.map((r) => Number(r.roleId)))
        : new Set();
    const roles = list.map((r) => {
        const roleId = Number(r.roleId);
        return {
            roleId,
            roleName: r.roleName || null,
            score: num(r.score),
            familyId: r.familyId == null ? null : Number(r.familyId),
            familyName: r.familyName || null,
            incumbents: occupants.get(roleId) || 0,
            namedSuccessors: Number(r.named) || 0,
            ready: ready.has(roleId),
        };
    });
    return { pop, roles };
}

/** Critical roles grouped by role family. */
function benchByFamily(roles) {
    const m = new Map();
    for (const r of roles) {
        const key = r.familyId == null ? 'none' : String(r.familyId);
        if (!m.has(key))
            m.set(key, {
                familyId: r.familyId,
                familyName: r.familyName,
                noFamily: r.familyId == null,
                roles: 0,
                covered: 0,
                uncovered: 0,
            });
        const g = m.get(key);
        g.roles++;
        if (r.ready) g.covered++;
        else g.uncovered++;
    }
    return [...m.values()].sort(
        (a, b) =>
            b.uncovered - a.uncovered ||
            (a.noFamily === b.noFamily ? 0 : a.noFamily ? 1 : -1) ||
            String(a.familyName || '').localeCompare(String(b.familyName || ''))
    );
}

function benchBreakdown(roles) {
    const covered = roles.filter((r) => r.ready).length;
    return {
        criticalRoles: roles.length,
        covered,
        uncovered: roles.length - covered,
        namedNotReady: roles.filter((r) => !r.ready && r.namedSuccessors > 0).length,
        noSuccessorNamed: roles.filter((r) => !r.ready && r.namedSuccessors === 0).length,
    };
}

/**
 * K5 Bench strength: critical roles with at least one ready successor /
 * critical roles (score >= 4 with at least one incumbent in scope). Fewer
 * than 5 critical roles: counts, no %. No critical role gives
 * 'not_configured'. drill = critical role ids; numeratorDrill = covered ones.
 */
async function k5BenchStrength(scope) {
    const { pop, roles } = await benchFacts(scope);
    if (!pop.ids.length) return emptyResult('K5', { roles: [], byFamily: [] });
    const threshold = await readinessThreshold();
    if (!roles.length) {
        return {
            ...base('K5'),
            value: null,
            rawValue: null,
            numerator: null,
            denominator: 0,
            n: 0,
            threshold,
            status: STATUS.NOT_CONFIGURED,
            breakdown: benchBreakdown([]),
            roles: [],
            byFamily: [],
            drill: [],
            numeratorDrill: [],
        };
    }
    const covered = roles.filter((r) => r.ready).map((r) => r.roleId);
    return {
        ...pctResult('K5', covered.length, roles.length, roles.length, {
            threshold,
            extra: {
                threshold,
                breakdown: benchBreakdown(roles),
                roles,
                byFamily: benchByFamily(roles),
            },
        }),
        drill: roles.map((r) => r.roleId),
        numeratorDrill: covered,
    };
}

/**
 * K6 Critical roles without a ready successor: critical roles minus the K5
 * numerator (same facts, same scope). Bands 0 / 1-2 / >= 3. No critical role
 * gives 'not_configured' (never a green 0). drill = the uncovered role ids.
 */
async function k6CriticalRolesWithoutReady(scope) {
    const { pop, roles } = await benchFacts(scope);
    if (!pop.ids.length) return emptyResult('K6', { roles: [], byFamily: [] });
    const out = { ...base('K6'), denominator: null, n: roles.length };
    if (!roles.length) {
        return {
            ...out,
            value: null,
            rawValue: null,
            numerator: null,
            status: STATUS.NOT_CONFIGURED,
            breakdown: benchBreakdown([]),
            roles: [],
            byFamily: [],
            drill: [],
        };
    }
    const uncovered = roles.filter((r) => !r.ready);
    return {
        ...out,
        value: uncovered.length,
        rawValue: uncovered.length,
        numerator: uncovered.length,
        status: P.statusBand(uncovered.length, 'K6'),
        breakdown: benchBreakdown(roles),
        roles: uncovered,
        byFamily: benchByFamily(roles),
        drill: uncovered.map((r) => r.roleId),
    };
}

// ---------------------------------------------------------------------------
// K12 Self vs validated drift (development module)
// ---------------------------------------------------------------------------

/**
 * K12 Self vs validated drift: mean signed gap between the person's latest
 * non-draft, non-cancelled self level and the official level whose
 * provenance is NOT 'self' (skill_assessments.validation). A level whose
 * provenance is 'self' is never a "validated" level. Fewer than 5 PEOPLE
 * behind the pairs gives 'small_n'; no pair gives 'not_measured'. byDomain =
 * per domain mean self / mean validated, a domain under 5 people suppressed.
 */
async function k12Drift(scope) {
    const pop = await resolvePopulation(scope);
    if (!pop.ids.length) return emptyResult('K12', { byDomain: [] });
    const rows = await db.all(
        `WITH self AS (
             SELECT DISTINCT ON (sa.employee_id, sa.skill_id)
                    sa.employee_id, sa.skill_id, sa.self_rated_level AS lvl
               FROM self_assessments sa
              WHERE sa.employee_id = ANY(?)
                AND sa.self_rated_level IS NOT NULL
                AND sa.cancelled_at IS NULL
                AND COALESCE(sa.workflow_state, sa.status::text) <> 'draft'
              ORDER BY sa.employee_id, sa.skill_id,
                       COALESCE(sa.submitted_at, sa.updated_at) DESC NULLS LAST, sa.id DESC
         )
         SELECT s.employee_id AS "employeeId", s.skill_id AS "skillId",
                s.lvl::int AS "selfLevel", v.current_level::int AS "validatedLevel",
                sk.domain_id AS "domainId", d.name AS "domainName"
           FROM self s
           JOIN skill_assessments v ON v.employee_id = s.employee_id AND v.skill_id = s.skill_id
           JOIN skills sk ON sk.id = s.skill_id
           LEFT JOIN domains d ON d.id = sk.domain_id
          WHERE v.current_level IS NOT NULL
            AND v.validation IS NOT NULL AND v.validation::text <> 'self'
          ORDER BY s.employee_id, s.skill_id`,
        [pop.ids]
    );
    const pairs = (rows || []).map((r) => {
        const self = Number(r.selfLevel);
        const validated = Number(r.validatedLevel);
        return {
            employeeId: Number(r.employeeId),
            skillId: Number(r.skillId),
            domainId: r.domainId == null ? null : Number(r.domainId),
            domainName: r.domainName || null,
            self,
            validated,
            gap: self - validated,
        };
    });
    const out = { ...base('K12'), unit: 'level', denominator: pairs.length };
    if (!pairs.length) {
        return {
            ...out,
            value: null,
            rawValue: null,
            numerator: null,
            n: 0,
            status: STATUS.NOT_MEASURED,
            breakdown: { pairs: 0, people: 0, largeGapPairs: null, largeGapPct: null },
            byDomain: [],
            drill: [],
        };
    }
    const people = new Set(pairs.map((p) => p.employeeId)).size;
    const mean = round2(pairs.reduce((a, p) => a + p.gap, 0) / pairs.length);
    const large = pairs.filter((p) => Math.abs(p.gap) >= P.K12_LARGE_GAP).length;
    const small = people < SMALL_N;
    const dom = new Map();
    for (const p of pairs) {
        const key = p.domainId == null ? 'none' : String(p.domainId);
        if (!dom.has(key))
            dom.set(key, {
                domainId: p.domainId,
                domainName: p.domainName,
                pairs: 0,
                ids: new Set(),
                s: 0,
                v: 0,
            });
        const g = dom.get(key);
        g.pairs++;
        g.ids.add(p.employeeId);
        g.s += p.self;
        g.v += p.validated;
    }
    const byDomain = [...dom.values()]
        .map((g) => {
            const hidden = g.ids.size < SMALL_N;
            return {
                domainId: g.domainId,
                domainName: g.domainName,
                suppressed: hidden,
                pairs: hidden ? null : g.pairs,
                people: hidden ? null : g.ids.size,
                meanSelf: hidden ? null : round2(g.s / g.pairs),
                meanValidated: hidden ? null : round2(g.v / g.pairs),
                meanGap: hidden ? null : round2((g.s - g.v) / g.pairs),
            };
        })
        .sort((a, b) => {
            if (a.suppressed !== b.suppressed) return a.suppressed ? 1 : -1;
            if (!a.suppressed && Math.abs(b.meanGap) !== Math.abs(a.meanGap))
                return Math.abs(b.meanGap) - Math.abs(a.meanGap);
            return String(a.domainName || '').localeCompare(String(b.domainName || ''));
        });
    return {
        ...out,
        value: small ? null : mean,
        rawValue: mean,
        numerator: null,
        n: people,
        status: small ? STATUS.SMALL_N : P.k12Band(mean),
        breakdown: {
            pairs: pairs.length,
            people,
            largeGapPairs: large,
            largeGapPct: small ? null : round1((100 * large) / pairs.length),
        },
        byDomain: small ? [] : byDomain,
        drill: pairs.map((p) => ({
            employeeId: p.employeeId,
            skillId: p.skillId,
            self: p.self,
            validated: p.validated,
            gap: p.gap,
        })),
    };
}

// ---------------------------------------------------------------------------
// K13 Development uplift (development module)
// ---------------------------------------------------------------------------

/**
 * K13 Development uplift. Actions: completed development-plan actions that
 * TARGET a skill and completed training-plan items, in the last
 * UPLIFT_LOOKBACK_DAYS. Prior level = the last measured level at or before
 * completion; no prior level puts the action out (a first measurement is
 * never an uplift; counted in noPriorActions). Uplift = a VALIDATED level >=
 * prior + 1 within UPLIFT_WINDOW_DAYS after completion. % = people with an
 * uplift / people whose window is CLOSED or who already progressed; open
 * windows are "pending" (outside the %). Informational: never a band.
 */
async function k13Uplift(scope) {
    const pop = await resolvePopulation(scope);
    if (!pop.ids.length) return emptyResult('K13', { numeratorDrill: [], drillPending: [] });
    const rows = await db.all(
        `WITH acts AS (
             SELECT p.employee_id, o.skill_id, a.completed_at
               FROM idp_actions a
               JOIN idp_objectives o ON o.id = a.objective_id
               JOIN idp_plans p ON p.id = a.idp_id
              WHERE a.status::text = 'completed' AND a.completed_at IS NOT NULL
                AND o.skill_id IS NOT NULL AND p.employee_id = ANY(?)
                AND a.completed_at >= now() - (?::int * interval '1 day')
             UNION ALL
             SELECT tp.employee_id, ti.skill_id, ti.completed_at
               FROM training_plan_items ti
               JOIN training_plans tp ON tp.id = ti.training_plan_id
              WHERE ti.status::text = 'completed' AND ti.completed_at IS NOT NULL
                AND ti.skill_id IS NOT NULL AND tp.employee_id = ANY(?)
                AND ti.completed_at >= now() - (?::int * interval '1 day')
         ), prior AS (
             SELECT a.employee_id, a.skill_id, a.completed_at,
                    (SELECT h.new_level FROM assessment_history h
                      WHERE h.employee_id = a.employee_id AND h.skill_id = a.skill_id
                        AND h.assessed_at <= a.completed_at AND h.new_level IS NOT NULL
                      ORDER BY h.assessed_at DESC, h.id DESC LIMIT 1) AS prior_level
               FROM acts a
         )
         SELECT w.employee_id AS "employeeId", w.skill_id AS "skillId",
                w.prior_level AS "priorLevel",
                (w.completed_at + (?::int * interval '1 day') <= now()) AS "closed",
                EXISTS (
                    SELECT 1 FROM assessment_history h
                     WHERE h.employee_id = w.employee_id AND h.skill_id = w.skill_id
                       AND h.assessed_at > w.completed_at
                       AND h.assessed_at <= w.completed_at + (?::int * interval '1 day')
                       AND h.source IS DISTINCT FROM 'self_assessment'
                       AND w.prior_level IS NOT NULL
                       AND h.new_level >= w.prior_level + 1
                ) AS "uplift"
           FROM prior w`,
        [
            pop.ids,
            P.UPLIFT_LOOKBACK_DAYS,
            pop.ids,
            P.UPLIFT_LOOKBACK_DAYS,
            P.UPLIFT_WINDOW_DAYS,
            P.UPLIFT_WINDOW_DAYS,
        ]
    );
    const per = new Map();
    let noPrior = 0;
    let eligibleActions = 0;
    for (const r of rows || []) {
        if (r.priorLevel === null || r.priorLevel === undefined) {
            noPrior++;
            continue;
        }
        eligibleActions++;
        const id = Number(r.employeeId);
        const g = per.get(id) || { up: false, closed: false };
        if (truthy(r.uplift)) g.up = true;
        if (truthy(r.closed)) g.closed = true;
        per.set(id, g);
    }
    const up = [];
    const den = [];
    const pending = [];
    for (const [id, g] of per) {
        if (g.up) {
            up.push(id);
            den.push(id);
        } else if (g.closed) den.push(id);
        else pending.push(id);
    }
    up.sort(byId);
    den.sort(byId);
    pending.sort(byId);
    const r = pctResult('K13', up.length, den.length, den.length, {
        extra: {
            breakdown: {
                actions: (rows || []).length,
                eligibleActions,
                noPriorActions: noPrior,
                uplifted: up.length,
                people: den.length,
                pending: pending.length,
                windowDays: P.UPLIFT_WINDOW_DAYS,
                lookbackDays: P.UPLIFT_LOOKBACK_DAYS,
            },
            drillPending: pending,
        },
    });
    // informational: never a status band (never red), whatever the value
    if (r.status !== STATUS.NOT_MEASURED && r.status !== STATUS.SMALL_N) r.status = null;
    return { ...r, drill: den, numeratorDrill: up };
}

// ---------------------------------------------------------------------------
// K14 Time to competence (mobility module)
// ---------------------------------------------------------------------------

/** Does employees.role_start_date exist? Read each time (cheap catalogue read). */
async function hasRoleStartDate() {
    try {
        const row = await db.get(
            `SELECT 1 AS "ok" FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'employees'
                AND column_name = 'role_start_date'`
        );
        return !!row;
    } catch (_) {
        return false;
    }
}

const dayMs = 86400000;
const dayOf = (d) => {
    if (d === null || d === undefined) return null;
    if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) return Date.parse(d + 'T00:00:00Z');
    const x = d instanceof Date ? d : new Date(d);
    if (Number.isNaN(x.getTime())) return null;
    return Date.UTC(x.getFullYear(), x.getMonth(), x.getDate());
};

/**
 * Replay a person's levels to the FIRST moment the K1 rule says "ready" on or
 * after the role start (pure). `reqs` = [{skillId, required, critical}];
 * `events` = [{skillId, level, at}] sorted by time. Certificate lapses are not
 * replayed (the history holds levels only). Returns the day (ms, UTC
 * midnight) or null.
 */
function firstReadyDay(reqs, events, startDay, threshold) {
    if (!reqs.length || startDay === null) return null;
    const level = new Map();
    const factsNow = () => {
        const f = {
            totalReq: reqs.length,
            assessed: 0,
            ptsGained: 0,
            ptsReq: 0,
            ptsGainedAssessed: 0,
            ptsReqAssessed: 0,
            critTotal: 0,
            critAssessed: 0,
            critMet: 0,
        };
        for (const q of reqs) {
            const lv = level.has(q.skillId) ? level.get(q.skillId) : null;
            const got = lv === null ? 0 : Math.min(lv, q.required);
            f.ptsReq += q.required;
            f.ptsGained += got;
            if (lv !== null) {
                f.assessed++;
                f.ptsGainedAssessed += got;
                f.ptsReqAssessed += q.required;
            }
            if (q.critical) {
                f.critTotal++;
                if (lv !== null) {
                    f.critAssessed++;
                    if (lv >= q.required) f.critMet++;
                }
            }
        }
        return f;
    };
    const isReady = () => classifyReadiness(factsNow(), threshold).state === R.READY;
    let i = 0;
    for (; i < events.length; i++) {
        const d = dayOf(events[i].at);
        if (d === null || d >= startDay) break;
        level.set(events[i].skillId, events[i].level);
    }
    if (isReady()) return startDay;
    for (; i < events.length; i++) {
        level.set(events[i].skillId, events[i].level);
        if (isReady()) return dayOf(events[i].at);
    }
    return null;
}

/**
 * K14 Time to competence: median days from role start to the first "ready"
 * (K1 rule on the current role, replayed from assessment_history). Needs a
 * CAPTURED role start date (employees.role_start_date), never imputed. This
 * release does not capture it yet: until the column exists, K14 answers
 * 'not_measured' with notCaptured: true ("role start date not recorded yet").
 * Fewer than 5 people: 'small_n'. Informational.
 */
async function k14TimeToCompetence(scope) {
    const pop = await resolvePopulation(scope);
    if (!pop.ids.length) return emptyResult('K14', { breakdown: { captured: 0 } });
    const out = { ...base('K14'), unit: 'days', denominator: null };
    const unmeasured = (captured, extra = {}) => ({
        ...out,
        value: null,
        rawValue: null,
        numerator: null,
        n: 0,
        status: STATUS.NOT_MEASURED,
        breakdown: { captured, reached: 0, notYet: captured },
        drill: [],
        ...extra,
    });
    if (!(await hasRoleStartDate())) return unmeasured(0, { notCaptured: true });
    const people = await db.all(
        `SELECT e.id AS "id", e.role_id AS "roleId",
                to_char(e.role_start_date, 'YYYY-MM-DD') AS "start"
           FROM employees e
          WHERE e.id = ANY(?) AND e.role_start_date IS NOT NULL AND e.role_id IS NOT NULL
          ORDER BY e.id`,
        [pop.ids]
    );
    const captured = (people || []).length;
    if (!captured) return unmeasured(0, { notCaptured: true });
    const threshold = await readinessThreshold();
    const roleIds = [...new Set(people.map((p) => Number(p.roleId)))];
    const reqRows = await db.all(
        `SELECT role_id AS "roleId", skill_id AS "skillId", required_level AS "required",
                is_critical AS "critical"
           FROM role_skill_requirements
          WHERE role_id = ANY(?) AND required_level > 0`,
        [roleIds]
    );
    const reqsByRole = new Map();
    for (const r of reqRows || []) {
        const k = Number(r.roleId);
        if (!reqsByRole.has(k)) reqsByRole.set(k, []);
        reqsByRole.get(k).push({
            skillId: Number(r.skillId),
            required: Number(r.required),
            critical: truthy(r.critical),
        });
    }
    const skillIds = [...new Set((reqRows || []).map((r) => Number(r.skillId)))];
    const hist = skillIds.length
        ? await db.all(
              `SELECT employee_id AS "employeeId", skill_id AS "skillId", new_level AS "level",
                      assessed_at AS "at"
                 FROM assessment_history
                WHERE employee_id = ANY(?) AND skill_id = ANY(?) AND new_level IS NOT NULL
                ORDER BY employee_id, assessed_at, id`,
              [people.map((p) => Number(p.id)), skillIds]
          )
        : [];
    const evBy = new Map();
    for (const h of hist || []) {
        const k = Number(h.employeeId);
        if (!evBy.has(k)) evBy.set(k, []);
        evBy.get(k).push({ skillId: Number(h.skillId), level: Number(h.level), at: h.at });
    }
    const drill = [];
    for (const p of people) {
        const start = dayOf(p.start);
        const reqs = reqsByRole.get(Number(p.roleId)) || [];
        const day = firstReadyDay(reqs, evBy.get(Number(p.id)) || [], start, threshold);
        if (day === null) continue;
        drill.push({
            employeeId: Number(p.id),
            days: Math.max(0, Math.round((day - start) / dayMs)),
        });
    }
    const n = drill.length;
    const breakdown = { captured, reached: n, notYet: captured - n, minN: P.K14_MIN_N };
    if (!n) return { ...unmeasured(captured), breakdown };
    const d = drill.map((x) => x.days).sort((a, b) => a - b);
    const median =
        d.length % 2
            ? d[(d.length - 1) / 2]
            : Math.round((d[d.length / 2 - 1] + d[d.length / 2]) / 2);
    const small = n < P.K14_MIN_N;
    return {
        ...out,
        value: small ? null : median,
        rawValue: median,
        numerator: null,
        n,
        status: small ? STATUS.SMALL_N : null,
        breakdown,
        drill,
    };
}

// ---------------------------------------------------------------------------
// Registry, per-site breakdown, snapshot metrics
// ---------------------------------------------------------------------------

const KPI_FUNCTIONS = Object.freeze({
    K1: k1RoleReady,
    K2: k2AvgReadiness,
    K3: k3Coverage,
    K4: k4CriticalCompliance,
    K5: k5BenchStrength,
    K6: k6CriticalRolesWithoutReady,
    K7: k7SoleHolders,
    K8: k8Certifications,
    K9: k9SafetyFitness,
    K11: k11CurrentCampaign,
    K12: k12Drift,
    K13: k13Uplift,
    K14: k14TimeToCompetence,
    K15: k15LevelUps,
    K16: k16ActivePlans,
});

function fnOf(kpiId) {
    return Object.prototype.hasOwnProperty.call(KPI_FUNCTIONS, kpiId) ? KPI_FUNCTIONS[kpiId] : null;
}

async function compute(kpiId, scope) {
    const fn = fnOf(kpiId);
    if (!fn) throw new Error('KpiService: unknown KPI');
    return fn(scope);
}

/**
 * Every indicator the organisation's modules allow, computed on ONE resolved
 * population. An indicator whose module is off is absent from the result:
 * never computed, never shown as "not measured".
 * @returns {Promise<Array<object>>} results in catalogue order
 */
async function computeAvailable(scope, { flags } = {}) {
    const f = flags || (await scopeModules(scope)) || {};
    const pop = await resolvePopulation(scope);
    const s = { ...(scope || {}), modules: f, __population: pop };
    const out = [];
    for (const id of availableKpis(f)) out.push(await compute(id, s));
    return out;
}

/**
 * Per-site rows plus a "No site" row (people without a site), computed on the
 * SAME resolved population as the organisation figure, so the sum of the
 * sites equals the organisation for every count, numerator and denominator.
 */
async function bySite(kpiId, scope) {
    if (!fnOf(kpiId)) throw new Error('KpiService: unknown KPI');
    const pop = await resolvePopulation(scope);
    const viewerScope = { ...(scope || {}), __population: pop };
    const org = await compute(kpiId, viewerScope);
    const groups = new Map();
    for (const r of pop.rows) {
        const key = r.siteId == null ? 'none' : String(r.siteId);
        if (!groups.has(key)) groups.set(key, { siteId: r.siteId, siteName: r.siteName, rows: [] });
        groups.get(key).rows.push(r);
    }
    const rows = [];
    for (const [key, g] of groups) {
        const sub = { ...(scope || {}), ...subScope(pop, g.rows) };
        rows.push({
            siteId: g.siteId,
            siteName: g.siteName,
            noSite: key === 'none',
            ...(key === 'none' ? { labelKey: P.VOCAB.noSite } : {}),
            result: await compute(kpiId, sub),
        });
    }
    rows.sort((a, b) => {
        if (a.noSite !== b.noSite) return a.noSite ? 1 : -1;
        return String(a.siteName || '').localeCompare(String(b.siteName || ''));
    });
    return { kpi: kpiId, org, rows };
}

/**
 * The kpi_snapshots metrics of a scope (jobs/kpi-snapshot.js), computed by
 * the K functions above: the snapshot of the day IS the indicator.
 * Percentages are rawValue (before small-n suppression); NULL is never 0.
 */
async function snapshotMetrics(scope) {
    const pop = await resolvePopulation(scope);
    const s = { ...(scope || {}), __population: pop };
    const k1 = await k1RoleReady(s);
    const k2 = await k2AvgReadiness(s);
    const k3 = await k3Coverage(s);
    const k4 = await k4CriticalCompliance(s);
    const k7 = await k7SoleHolders(s);
    const k8 = await k8Certifications(s);
    const k9 = await k9SafetyFitness(s);
    const b1 = k1.breakdown || {};
    const b3 = k3.breakdown || {};
    const b4 = k4.breakdown || {};
    const configured8 = k8.status !== STATUS.NOT_CONFIGURED && !k8.emptyScope;
    return {
        kpiContract: CONTRACT_VERSION,
        totalEmployees: pop.ids.length,
        measuredEmployees: k2.denominator == null ? null : k2.denominator,
        avgReadiness: k2.rawValue,
        assessmentCoverage: k3.rawValue,
        assessedRequirements: b3.assessedRequirements == null ? null : b3.assessedRequirements,
        expectedRequirements: b3.expectedRequirements == null ? null : b3.expectedRequirements,
        criticalCompliance: k4.rawValue,
        criticalUnassessed: b4.criticalUnassessed == null ? null : b4.criticalUnassessed,
        roleReadyCount: k1.emptyScope ? null : num(b1.ready),
        notReadyCount: k1.emptyScope ? null : num(b1.notReady),
        partialCount: k1.emptyScope ? null : num(b1.partial),
        unassessedCount: k1.emptyScope ? null : num(b1.notAssessed),
        soleHolderCount: k7.value,
        noQualifiedCount: k7.value == null ? null : k7.breakdown.noQualified,
        certsExpired: configured8 ? k8.breakdown.expiredPeople : null,
        certsExpiring90d: configured8 ? k8.breakdown.expiringPeople : null,
        safetyFitPct: k9.rawValue,
    };
}

module.exports = {
    CONTRACT_VERSION,
    CONTRACTS,
    PLAN_TYPES,
    // one function per indicator
    k1RoleReady,
    k2AvgReadiness,
    k3Coverage,
    k4CriticalCompliance,
    k5BenchStrength,
    k6CriticalRolesWithoutReady,
    k7SoleHolders,
    k8Certifications,
    k9SafetyFitness,
    k11CurrentCampaign,
    k12Drift,
    k13Uplift,
    k14TimeToCompetence,
    k15LevelUps,
    k16ActivePlans,
    approvedOutsideCampaign,
    overdueStatus,
    firstReadyDay,
    rolesWithReadySuccessor,
    // modules
    moduleOf,
    isAvailable,
    availableKpis,
    availablePlanTypes,
    computeAvailable,
    // generic access
    KPI_FUNCTIONS,
    compute,
    bySite,
    snapshotMetrics,
    // shared building blocks
    pctResult,
    resolvePopulation,
    classifyReadiness,
    readinessBundle,
    readinessThreshold,
    canSeePips,
};
