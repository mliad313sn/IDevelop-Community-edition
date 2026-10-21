'use strict';

/**
 * HseOpsService — the health-and-safety operations indicators of the
 * dashboard's « Safety » tab (4.0.0 port, wave 8). Five indicators of the KPI
 * module (KpiService CONTRACTS, contract kpi-2), all core:
 *
 *   K40  Waivers and contests       safety_gate_waivers / safety_gate_contests
 *   K41  Blocks per week, by cause  entries into an ENFORCED « blocked » status
 *                                   (safety_gate_status_history), 13 weeks
 *   K42  Expiry pipeline            required certificates expiring in the next
 *                                   12 months, by month and by site
 *   K43  Coverage rules in breach   now (v_coverage_status) and the rules that
 *                                   would break within 30 / 60 / 90 days if
 *                                   nothing is renewed (leave + expiry)
 *   K44  Certificate record quality the required certificates on record that
 *                                   carry an expiry, clean evidence, a field
 *                                   sign-off (VOC) and a number; the issuer
 *                                   (migration 196) beside them
 *
 * The rules every result follows (the KPI module's contract):
 *   - population = KpiService.resolvePopulation: active, not erased, inside
 *     the reader's clearance, narrowed by site or department;
 *   - counts and the labels of sites, months and reason codes only: no person
 *     id or name leaves this module (`drill` is always empty);
 *   - nothing measured is null with a status (not_measured / not_configured),
 *     never 0. A week without a nightly recompute is null, « not recomputed »;
 *   - a percentage needs 5 people behind it (small_n otherwise) and is rounded
 *     DOWN (displayedValue 'pct1Floor'), so it never reads 100 % while one
 *     record falls short;
 *   - K40 is never « compliant » while a waiver runs, K43 never while a rule is
 *     in breach, K44 never while one record lacks an element;
 *   - a site of fewer than 5 people is not named in K42: its certificates are
 *     counted in one « smaller sites » row.
 * Read-only: nothing is written anywhere.
 *
 * @module services/HseOpsService
 */

const db = require('../config/database');
const P = require('../utils/kpiPredicates');
const { displayedValue } = require('../utils/displayedValue');

const { STATUS, SMALL_N } = P;
const WEEKS = 13;
const MONTHS = 12;
const HORIZONS = Object.freeze([30, 60, 90]);
const TICK = 'safety-gate.tick';
const DAY_MS = 86400000;

const K = () => require('./KpiService');

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
function dayMs(key) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(key || ''));
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

function base(kpi) {
    return { kpi, freshness: 'live', asOf: new Date().toISOString(), drill: [] };
}

function emptyScope(kpi) {
    return {
        ...base(kpi),
        value: null,
        rawValue: null,
        numerator: 0,
        denominator: 0,
        n: 0,
        status: STATUS.NOT_MEASURED,
        emptyScope: true,
        breakdown: null,
    };
}

function notConfigured(kpi, extra = {}) {
    return {
        ...base(kpi),
        value: null,
        rawValue: null,
        numerator: null,
        denominator: 0,
        n: 0,
        status: STATUS.NOT_CONFIGURED,
        breakdown: null,
        ...extra,
    };
}

// ---------------------------------------------------------------------------
// Pure rules (exported for the tests)
// ---------------------------------------------------------------------------

/** K40: a running waiver is a known shortfall, so never « compliant » while one runs. */
function waiverStatus({ configured, everUsed, running }) {
    if (!configured && !everUsed) return STATUS.NOT_CONFIGURED;
    return running > 0 ? STATUS.WATCH : STATUS.COMPLIANT;
}

/** K43, decided on the rules in breach NOW: a critical one is at risk, a warning one watch. */
function coverageStatus({ active, breachedCritical, breachedWarning }) {
    if (!active) return STATUS.NOT_CONFIGURED;
    if (breachedCritical > 0) return STATUS.AT_RISK;
    if (breachedWarning > 0) return STATUS.WATCH;
    return STATUS.COMPLIANT;
}

/** A safety share rounded down: 99.96 % prints 99.9 %, never 100 %. */
const floorPct = (part, whole) => displayedValue((100 * part) / whole, 'pct1Floor');

/**
 * K44 value and status from the counts: `complete` of `recorded` records,
 * held by `people` people. Fewer than 5 people: no % (small_n), the counts
 * stay. Otherwise « watch » as soon as one record is incomplete.
 */
function qualityResult(recorded, complete, people) {
    if (!recorded) return { status: STATUS.NOT_MEASURED, value: null };
    if (people < SMALL_N) return { status: STATUS.SMALL_N, value: null };
    return {
        status: complete < recorded ? STATUS.WATCH : STATUS.COMPLIANT,
        value: floorPct(complete, recorded),
    };
}

/** One fill rate: the counts always, the % only from 5 people (rounded down). */
function rateOf(filled, recorded, people) {
    if (!recorded) return { filled: null, recorded: 0, pct: null };
    return { filled, recorded, pct: people < SMALL_N ? null : floorPct(filled, recorded) };
}

/** The `weeks` Monday-based week windows ending with the current (partial) week, oldest first. */
function weekWindows(today, weeks = WEEKS) {
    const t = dayMs(today);
    if (t === null) return [];
    const dow = (new Date(t).getUTCDay() + 6) % 7; // Monday = 0
    const monday = t - dow * DAY_MS;
    const out = [];
    for (let i = weeks - 1; i >= 0; i--) {
        const s = monday - i * 7 * DAY_MS;
        out.push({ start: isoDay(s), end: isoDay(s + 6 * DAY_MS), current: i === 0 });
    }
    return out;
}

/**
 * Entries into « blocked » per week. A week in which the nightly recompute
 * did not run and nothing was recorded on demand is null (« not
 * recomputed »): no recompute is not the same as no block.
 * @param {Array<{start,end}>} weeks
 * @param {string[]} entryDays      YYYY-MM-DD of each entry
 * @param {Set<string>} recomputed  YYYY-MM-DD of each day the gate was recomputed
 */
function bucketWeeks(weeks, entryDays, recomputed) {
    return weeks.map((w) => {
        let ran = false;
        for (const d of recomputed) if (d >= w.start && d <= w.end) ran = true;
        const n = entryDays.filter((d) => d >= w.start && d <= w.end).length;
        return { ...w, recomputed: ran, count: ran || n > 0 ? n : null };
    });
}

/** The `months` calendar months from today; the first one starts today. */
function monthWindows(today, months = MONTHS) {
    const t = dayMs(today);
    if (t === null) return [];
    const d = new Date(t);
    const out = [];
    for (let i = 0; i < months; i++) {
        const s = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + i, 1);
        const e = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + i + 1, 0);
        out.push({
            start: i === 0 ? isoDay(t) : isoDay(s),
            end: isoDay(e),
            month: isoDay(s).slice(0, 7),
        });
    }
    return out;
}

/** The blocking reason codes of one history row: enforced, not waived, not observe-only. */
function blockingCodes(reasons) {
    let arr = reasons;
    if (typeof arr === 'string') {
        try {
            arr = JSON.parse(arr);
        } catch (_) {
            arr = [];
        }
    }
    if (!Array.isArray(arr)) return [];
    const codes = new Set();
    for (const r of arr) {
        if (!r || typeof r.code !== 'string' || !r.code) continue;
        if (r.blocking === false || r.observe || r.waived) continue;
        codes.add(r.code);
    }
    return [...codes];
}

/**
 * K42: the required certificates on record that expire between today and the
 * end of the twelfth month, by month and by site. A certificate without an
 * expiry date is counted apart (`noDate`). A site of fewer than 5 people of
 * the population is not named: its certificates go to one `smallSites` row.
 */
function pipelineOf(rows, pop, today) {
    const months = monthWindows(today);
    const end = months.length ? months[months.length - 1].end : today;
    const person = new Map(pop.rows.map((r) => [r.id, r]));
    const headcount = new Map();
    for (const r of pop.rows) {
        const key = r.siteId == null ? 'none' : String(r.siteId);
        headcount.set(key, (headcount.get(key) || 0) + 1);
    }
    const groups = new Map();
    const totals = months.map(() => 0);
    let noDate = 0;
    let total = 0;
    for (const r of rows) {
        if (r.certId == null) continue;
        if (!r.expiresOn) {
            noDate++;
            continue;
        }
        if (r.expiresOn < today || r.expiresOn > end) continue;
        const i = months.findIndex((m) => r.expiresOn >= m.start && r.expiresOn <= m.end);
        if (i < 0) continue;
        const pr = person.get(Number(r.employeeId)) || {};
        const site = pr.siteId == null ? 'none' : String(pr.siteId);
        const small = site !== 'none' && (headcount.get(site) || 0) < SMALL_N;
        const key = small ? 'small' : site;
        if (!groups.has(key))
            groups.set(key, {
                key,
                siteId: small || site === 'none' ? null : pr.siteId,
                siteName: small || site === 'none' ? null : pr.siteName || null,
                noSite: key === 'none',
                smallSites: small,
                counts: months.map(() => 0),
                total: 0,
            });
        const g = groups.get(key);
        g.counts[i]++;
        g.total++;
        totals[i]++;
        total++;
    }
    const rank = (g) => (g.smallSites ? 2 : g.noSite ? 1 : 0);
    const sites = [...groups.values()].sort(
        (a, b) =>
            rank(a) - rank(b) ||
            b.total - a.total ||
            String(a.siteName || '').localeCompare(String(b.siteName || ''))
    );
    return { months, sites, totals, total, noDate };
}

/**
 * K43 from the visible rules and the first projected breach day of each rule
 * that holds today (Map ruleId → day offset).
 */
function coverageOf(rules, firstBreach) {
    const active = rules.length;
    const breached = rules.filter((r) => !r.satisfied);
    const breachedCritical = breached.filter((r) => r.severity === 'critical').length;
    const breachedWarning = breached.length - breachedCritical;
    const holding = rules.filter((r) => r.satisfied);
    const within = (r, h) => {
        const f = firstBreach.get(String(r.ruleId));
        return f !== undefined && f <= h;
    };
    const projected = {};
    for (const h of HORIZONS) projected[h] = holding.filter((r) => within(r, h)).length;
    const bySite = new Map();
    for (const r of rules) {
        const key = r.siteId == null ? 'all' : String(r.siteId);
        if (!bySite.has(key))
            bySite.set(key, {
                siteId: r.siteId == null ? null : Number(r.siteId),
                siteName: r.siteId == null ? null : r.siteName || null,
                allSites: r.siteId == null,
                active: 0,
                breached: 0,
                projected90: 0,
            });
        const g = bySite.get(key);
        g.active++;
        if (!r.satisfied) g.breached++;
        else if (within(r, 90)) g.projected90++;
    }
    const sites = [...bySite.values()].sort(
        (a, b) =>
            b.breached - a.breached ||
            b.projected90 - a.projected90 ||
            Number(a.allSites) - Number(b.allSites) ||
            String(a.siteName || '').localeCompare(String(b.siteName || ''))
    );
    return {
        status: coverageStatus({ active, breachedCritical, breachedWarning }),
        active,
        breached: breached.length,
        breachedCritical,
        breachedWarning,
        projected,
        sites,
    };
}

// ---------------------------------------------------------------------------
// Shared reads: one per population, whatever the number of indicators asked
// ---------------------------------------------------------------------------

/** People of `ids` on a role with at least one ENFORCED active gate rule. */
async function gatedCount(ids) {
    if (!ids.length) return 0;
    const r = await db.get(
        `SELECT COUNT(*)::int AS "n"
           FROM employees e
          WHERE e.id = ANY(?)
            AND EXISTS (SELECT 1 FROM safety_gate_rules gr
                         WHERE gr.is_active AND gr.mode = 'enforce' AND gr.role_id = e.role_id
                           AND (gr.site_id IS NULL OR gr.site_id = e.site_id))`,
        [ids]
    );
    return Number((r && r.n) || 0);
}

const SHARED = new WeakMap();

/** today, the gated headcount and the required certificates of a population, read once. */
function shared(pop) {
    if (!SHARED.has(pop)) {
        SHARED.set(
            pop,
            (async () => {
                const Kpi = K();
                const [today, gated, certRows] = [
                    await Kpi.dbToday(),
                    await gatedCount(pop.ids),
                    await Kpi.requiredCertRows(pop.ids),
                ];
                return { today, gated, certRows: certRows || [] };
            })()
        );
    }
    return SHARED.get(pop);
}

/** Days (YYYY-MM-DD) on which the nightly gate recompute ran, since `from`. */
async function recomputeDays(from) {
    const runs = await db.all(
        `SELECT DISTINCT to_char(started_at::date, 'YYYY-MM-DD') AS "d"
           FROM job_runs
          WHERE tick_name = ? AND ok IS TRUE AND started_at >= CAST(? AS date)
            AND COALESCE((result->>'recomputed')::int, 0) > 0`,
        [TICK, from]
    );
    const hist = await db.all(
        `SELECT DISTINCT to_char(changed_at::date, 'YYYY-MM-DD') AS "d"
           FROM safety_gate_status_history
          WHERE source = 'nightly' AND changed_at >= CAST(? AS date)`,
        [from]
    );
    const st = await db.get(
        `SELECT to_char(last_recompute_on, 'YYYY-MM-DD') AS "d" FROM safety_gate_settings WHERE id = 1`
    );
    const out = new Set();
    for (const r of runs || []) out.add(r.d);
    for (const r of hist || []) out.add(r.d);
    if (st && st.d && st.d >= from) out.add(st.d);
    return out;
}

/** The last nightly recompute: when the run finished, else the day it claimed; null when never. */
async function lastRecompute() {
    const run = await db.get(
        `SELECT COALESCE(finished_at, started_at) AS "at"
           FROM job_runs
          WHERE tick_name = ? AND ok IS TRUE AND COALESCE((result->>'recomputed')::int, 0) > 0
          ORDER BY started_at DESC LIMIT 1`,
        [TICK]
    );
    if (run && run.at) {
        const at = new Date(run.at);
        return { at: at.toISOString(), day: at.toISOString().slice(0, 10) };
    }
    const st = await db.get(
        `SELECT to_char(last_recompute_on, 'YYYY-MM-DD') AS "d" FROM safety_gate_settings WHERE id = 1`
    );
    return st && st.d ? { at: null, day: st.d } : null;
}

// ---------------------------------------------------------------------------
// K40 Waivers and contests
// ---------------------------------------------------------------------------

/**
 * K40: the waivers running now (value), how many renew an earlier one, the
 * age of the oldest, the waivers granted in 30 days by route, the open
 * contests and the contests decided in 90 days. A count, never a list.
 */
async function k40Waivers(scope) {
    const pop = await K().resolvePopulation(scope);
    if (!pop.ids.length) return emptyScope('K40');
    const { gated } = await shared(pop);
    const ids = pop.ids;
    const w = await db.get(
        `SELECT COUNT(*)::int AS "ever",
                COUNT(*) FILTER (WHERE w.state = 'active' AND w.expires_at > now())::int AS "running",
                COUNT(*) FILTER (WHERE w.state = 'active' AND w.expires_at > now()
                                   AND w.renewal_of IS NOT NULL)::int AS "renewed",
                MAX(EXTRACT(EPOCH FROM (now() - COALESCE(p.starts_at, w.starts_at))) / 3600)
                    FILTER (WHERE w.state = 'active' AND w.expires_at > now()) AS "oldestHours"
           FROM safety_gate_waivers w
           LEFT JOIN safety_gate_waivers p ON p.id = w.renewal_of
          WHERE w.employee_id = ANY(?)`,
        [ids]
    );
    const via = await db.all(
        `SELECT w.granted_via AS "via", COUNT(*)::int AS "n"
           FROM safety_gate_waivers w
          WHERE w.employee_id = ANY(?) AND w.created_at >= now() - interval '30 days'
          GROUP BY w.granted_via`,
        [ids]
    );
    const c = await db.get(
        `SELECT COUNT(*)::int AS "ever",
                COUNT(*) FILTER (WHERE c.state = 'open')::int AS "open",
                MAX(CURRENT_DATE - c.created_at::date) FILTER (WHERE c.state = 'open') AS "oldestDays"
           FROM safety_gate_contests c
          WHERE c.employee_id = ANY(?)`,
        [ids]
    );
    const outcomes = await db.all(
        `SELECT c.state AS "state", COUNT(*)::int AS "n"
           FROM safety_gate_contests c
          WHERE c.employee_id = ANY(?) AND c.state <> 'open'
            AND c.decided_at >= now() - interval '90 days'
          GROUP BY c.state`,
        [ids]
    );
    const running = Number(w.running) || 0;
    const everUsed = (Number(w.ever) || 0) + (Number(c.ever) || 0) > 0;
    const status = waiverStatus({ configured: gated > 0, everUsed, running });
    if (status === STATUS.NOT_CONFIGURED) return notConfigured('K40');
    const byVia = new Map([
        ['line', 0],
        ['hse', 0],
        ['contest', 0],
    ]);
    for (const r of via || []) if (byVia.has(r.via)) byVia.set(r.via, Number(r.n));
    const decided = new Map([
        ['upheld', 0],
        ['overturned', 0],
    ]);
    for (const r of outcomes || []) if (decided.has(r.state)) decided.set(r.state, Number(r.n));
    const open = Number(c.open) || 0;
    return {
        ...base('K40'),
        value: running,
        rawValue: running,
        numerator: running,
        denominator: gated,
        n: gated,
        status,
        breakdown: {
            running,
            renewed: Number(w.renewed) || 0,
            oldestHours:
                running > 0 && w.oldestHours != null ? Math.floor(Number(w.oldestHours)) : null,
            granted30Line: byVia.get('line'),
            granted30Hse: byVia.get('hse'),
            granted30Contest: byVia.get('contest'),
            granted30: byVia.get('line') + byVia.get('hse') + byVia.get('contest'),
            contestsOpen: open,
            contestOldestDays: open > 0 ? num(c.oldestDays) : null,
            upheld90: decided.get('upheld'),
            overturned90: decided.get('overturned'),
        },
    };
}

// ---------------------------------------------------------------------------
// K41 Blocks per week and their causes
// ---------------------------------------------------------------------------

/** Entries into an ENFORCED « blocked » status (not re-evaluations) since `from`. */
async function blockEntries(ids, from) {
    const rows = await db.all(
        `WITH h AS (
             SELECT h.employee_id, h.changed_at, h.reasons,
                    COALESCE(h.enforced_status, h.status) AS enf,
                    LAG(COALESCE(h.enforced_status, h.status))
                        OVER (PARTITION BY h.employee_id ORDER BY h.changed_at, h.id) AS prev
               FROM safety_gate_status_history h
              WHERE h.employee_id = ANY(?)
         )
         SELECT to_char(h.changed_at::date, 'YYYY-MM-DD') AS "day", h.reasons AS "reasons"
           FROM h
          WHERE h.enf = 'BLOCKED' AND (h.prev IS NULL OR h.prev <> 'BLOCKED')
            AND h.changed_at >= CAST(? AS date)`,
        [ids, from]
    );
    const meta = await db.get(
        `SELECT COUNT(*)::int AS "events", to_char(MIN(changed_at)::date, 'YYYY-MM-DD') AS "since"
           FROM safety_gate_status_history WHERE employee_id = ANY(?)`,
        [ids]
    );
    return {
        rows: rows || [],
        since: meta ? meta.since : null,
        events: meta ? Number(meta.events) || 0 : 0,
    };
}

/**
 * K41: entries into « blocked » over 13 weeks (value: the sum of the weeks
 * that were measured), the weekly series and the blocking causes. No gated
 * role: not configured. No gate history at all: not measured.
 */
async function k41Blocks(scope) {
    const pop = await K().resolvePopulation(scope);
    if (!pop.ids.length) return emptyScope('K41');
    const { gated, today } = await shared(pop);
    if (!gated) return notConfigured('K41');
    const weeks = weekWindows(today);
    const from = weeks[0].start;
    const entries = await blockEntries(pop.ids, from);
    const days = await recomputeDays(from);
    if (!entries.events) {
        return {
            ...base('K41'),
            value: null,
            rawValue: null,
            numerator: null,
            denominator: gated,
            n: gated,
            status: STATUS.NOT_MEASURED,
            breakdown: { gated },
        };
    }
    const series = bucketWeeks(
        weeks,
        entries.rows.map((r) => r.day),
        days
    );
    const reasons = new Map();
    for (const r of entries.rows)
        for (const code of blockingCodes(r.reasons))
            reasons.set(code, (reasons.get(code) || 0) + 1);
    const measured = series.filter((w) => w.count !== null);
    const total = measured.length ? measured.reduce((a, w) => a + w.count, 0) : null;
    return {
        ...base('K41'),
        value: total,
        rawValue: total,
        numerator: total,
        denominator: gated,
        n: gated,
        status: measured.length ? null : STATUS.NOT_MEASURED,
        since: entries.since,
        weeks: series,
        reasons: [...reasons.entries()]
            .map(([code, n]) => ({ code, n }))
            .sort((a, b) => b.n - a.n || a.code.localeCompare(b.code)),
        breakdown: {
            gated,
            measuredWeeks: measured.length,
            unrecomputedWeeks: series.length - measured.length,
        },
    };
}

// ---------------------------------------------------------------------------
// K42 Expiry pipeline, 12 months by site
// ---------------------------------------------------------------------------

/**
 * K42: the required certificates (KpiService.requiredCertRows, the K8 rule)
 * expiring in the next 12 months (value), by month and by site; « no expiry
 * date » apart. Nothing required in scope: not configured.
 */
async function k42ExpiryPipeline(scope) {
    const pop = await K().resolvePopulation(scope);
    if (!pop.ids.length) return emptyScope('K42');
    const { today, certRows } = await shared(pop);
    if (!certRows.length) return notConfigured('K42');
    const p = pipelineOf(certRows, pop, today);
    return {
        ...base('K42'),
        value: p.total,
        rawValue: p.total,
        numerator: p.total,
        denominator: certRows.filter((r) => r.certId != null).length,
        n: new Set(certRows.map((r) => Number(r.employeeId))).size,
        status: null,
        months: p.months,
        totals: p.totals,
        sites: p.sites,
        breakdown: { expiring12m: p.total, noDate: p.noDate },
    };
}

// ---------------------------------------------------------------------------
// K43 Coverage rules in breach, now and projected
// ---------------------------------------------------------------------------

/** The coverage rules the reader may see (CoverageService.status), narrowed to the scope. */
async function visibleRules(scope, pop) {
    const CoverageService = require('./CoverageService');
    const ids = pop.system
        ? null
        : await require('../utils/rbacScope').scopedEmployeeIds(scope.viewer);
    let rules = await CoverageService.status(ids);
    const sid = scope && scope.siteId;
    if (sid === 'none' || sid === null) rules = rules.filter((r) => r.siteId == null);
    else if (sid !== undefined && sid !== '')
        rules = rules.filter((r) => Number(r.siteId) === Number(sid));
    const did = scope && scope.departmentId;
    if (did !== undefined && did !== null && did !== '')
        rules = rules.filter((r) => Number(r.departmentId) === Number(did));
    return rules;
}

/**
 * The first day (1..horizon) on which each rule would break, counting on each
 * day only the people not on planned leave and, for a rule that requires a
 * certificate, still holding one not expired by that day. The « qualified »
 * definition of v_coverage_status and CoverageService.predictAll, on a longer
 * horizon; it assumes NOTHING is renewed.
 * @returns {Promise<Map<string, number>>} ruleId → day offset of the first breach
 */
async function projectRules(ruleIds, horizon) {
    const out = new Map();
    if (!ruleIds.length) return out;
    const rows = await db.all(
        `WITH days AS (SELECT i, (CURRENT_DATE + i)::date AS day FROM generate_series(1, ?) AS i)
         SELECT r.id AS "ruleId", MIN(d.i)::int AS "first"
           FROM coverage_rules r
           CROSS JOIN days d
           LEFT JOIN LATERAL (
               SELECT COUNT(*)::int AS qualified
                 FROM v_employee_details ed
                 JOIN v_resolved_assessments ra
                   ON ra.employee_id = ed.employee_id
                  AND ra.skill_id = r.skill_id
                  AND ra.level >= r.min_level
                WHERE (r.site_id       IS NULL OR ed.site_id       = r.site_id)
                  AND (r.department_id IS NULL OR ed.department_id = r.department_id)
                  AND (r.service_id    IS NULL OR ed.service_id    = r.service_id)
                  AND NOT EXISTS (
                        SELECT 1 FROM planned_absences pa
                         WHERE pa.employee_id = ed.employee_id AND pa.is_active
                           AND d.day BETWEEN pa.starts_on AND pa.ends_on)
                  AND (NOT r.require_valid_cert OR EXISTS (
                        SELECT 1 FROM v_certification_current cc
                         WHERE cc.employee_id = ed.employee_id
                           AND cc.skill_id = r.skill_id
                           AND cc.cert_status <> 'expired'
                           AND (cc.expires_on IS NULL OR cc.expires_on > d.day)))
           ) q ON true
          WHERE r.is_active AND r.id = ANY(?) AND COALESCE(q.qualified, 0) < r.min_headcount
          GROUP BY r.id`,
        [horizon, ruleIds]
    );
    for (const r of rows || []) out.set(String(r.ruleId), Number(r.first));
    return out;
}

/**
 * K43: the coverage rules in breach now (value) of the active rules the
 * reader sees, and the rules holding today that would break within 30, 60
 * and 90 days if nothing is renewed. No visible rule: not configured.
 */
async function k43CoverageBreaches(scope) {
    const pop = await K().resolvePopulation(scope);
    if (!pop.ids.length) return emptyScope('K43');
    const rules = await visibleRules(scope || {}, pop);
    if (!rules.length) return notConfigured('K43', { breakdown: { active: 0 } });
    const first = await projectRules(
        rules.filter((r) => r.satisfied).map((r) => Number(r.ruleId)),
        HORIZONS[HORIZONS.length - 1]
    );
    const c = coverageOf(rules, first);
    return {
        ...base('K43'),
        value: c.breached,
        rawValue: c.breached,
        numerator: c.breached,
        denominator: c.active,
        n: c.active,
        status: c.status,
        sites: c.sites,
        breakdown: {
            active: c.active,
            breached: c.breached,
            breachedCritical: c.breachedCritical,
            breachedWarning: c.breachedWarning,
            projected30: c.projected[30],
            projected60: c.projected[60],
            projected90: c.projected[90],
        },
    };
}

// ---------------------------------------------------------------------------
// K44 Certificate record quality
// ---------------------------------------------------------------------------

/** The elements of a complete record; the issuer is measured beside them. */
const QUALITY_ELEMENTS = Object.freeze(['dated', 'evidence', 'voc', 'numbered']);
const QUALITY_RATES = Object.freeze([...QUALITY_ELEMENTS, 'issuer']);

/**
 * K44: the share of the required certificates on record that are complete:
 * an expiry date (or a policy without expiry), evidence scanned clean, a
 * field sign-off and a number. The issuer (migration 196) is measured as its
 * own rate and is not part of « complete »: records made before 196 never
 * had the field, and they are not back-filled. A required certificate never
 * recorded is counted apart (`missing`), outside the share.
 */
async function k44CertificateQuality(scope) {
    const pop = await K().resolvePopulation(scope);
    if (!pop.ids.length) return emptyScope('K44');
    const { certRows } = await shared(pop);
    if (!certRows.length) return notConfigured('K44');
    const onRecord = certRows.filter((r) => r.certId != null);
    const missing = certRows.length - onRecord.length;
    const certIds = [...new Set(onRecord.map((r) => Number(r.certId)))];
    const people = new Set(onRecord.map((r) => Number(r.employeeId))).size;
    if (!certIds.length) {
        return {
            ...base('K44'),
            value: null,
            rawValue: null,
            numerator: 0,
            denominator: 0,
            n: 0,
            status: STATUS.NOT_MEASURED,
            breakdown: { recorded: 0, complete: 0, missing },
            rates: null,
        };
    }
    const facts = await db.all(
        `SELECT c.id AS "id",
                (c.expires_on IS NOT NULL OR (p.id IS NOT NULL AND p.validity_months IS NULL)) AS "dated",
                (c.file_uri IS NOT NULL AND c.av_status::text = 'clean') AS "evidence",
                (c.verified_at IS NOT NULL) AS "voc",
                (c.cert_number IS NOT NULL AND btrim(c.cert_number) <> '') AS "numbered",
                (c.issuer IS NOT NULL) AS "issuer"
           FROM employee_certifications c
           LEFT JOIN skill_certification_policies p ON p.skill_id = c.skill_id
          WHERE c.id = ANY(?)`,
        [certIds]
    );
    const yes = (v) => v === true || v === 't';
    const recorded = facts.length;
    const complete = facts.filter((f) => QUALITY_ELEMENTS.every((k) => yes(f[k]))).length;
    const q = qualityResult(recorded, complete, people);
    const rates = {};
    for (const k of QUALITY_RATES)
        rates[k] = rateOf(facts.filter((f) => yes(f[k])).length, recorded, people);
    return {
        ...base('K44'),
        value: q.value,
        rawValue: recorded ? floorPct(complete, recorded) : null,
        numerator: complete,
        denominator: recorded,
        n: people,
        status: q.status,
        rates,
        breakdown: { recorded, complete, incomplete: recorded - complete, missing },
    };
}

// ---------------------------------------------------------------------------
// The Safety tab block
// ---------------------------------------------------------------------------

/**
 * Everything the « Safety » tab shows of HSE operations, on ONE resolved
 * population: K40 to K44 and the last nightly recompute.
 * @param {object} scope  a KpiService scope (viewer or system, site /
 *                        department, optionally __population already resolved)
 */
async function forDashboard(scope) {
    const pop = await K().resolvePopulation(scope);
    const s = { ...(scope || {}), __population: pop };
    if (!pop.ids.length) return { people: 0 };
    return {
        people: pop.ids.length,
        recompute: await lastRecompute(),
        K40: await k40Waivers(s),
        K41: await k41Blocks(s),
        K42: await k42ExpiryPipeline(s),
        K43: await k43CoverageBreaches(s),
        K44: await k44CertificateQuality(s),
    };
}

module.exports = {
    WEEKS,
    MONTHS,
    HORIZONS,
    QUALITY_ELEMENTS,
    QUALITY_RATES,
    forDashboard,
    k40Waivers,
    k41Blocks,
    k42ExpiryPipeline,
    k43CoverageBreaches,
    k44CertificateQuality,
    // pure rules, exported for the tests
    waiverStatus,
    coverageStatus,
    qualityResult,
    rateOf,
    weekWindows,
    bucketWeeks,
    monthWindows,
    blockingCodes,
    pipelineOf,
    coverageOf,
};
