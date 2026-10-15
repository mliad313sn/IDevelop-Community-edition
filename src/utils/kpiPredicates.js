'use strict';

/**
 * kpiPredicates: the shared predicates and vocabulary of the KPI module.
 *
 * One definition per concept, used by every indicator, list, report, export
 * and snapshot ("active plan", "current campaign", "overdue", "critical" used
 * to mean different things on different pages). Pure functions plus one DB
 * helper (currentCampaigns). Nothing here turns an absence of measurement
 * into 0.
 *
 * Codes are English and stable: they travel in the API, the Power BI feed and
 * the snapshots. People read them through the `kpi` locale namespace
 * (VOCAB), in French or in English.
 *
 *   PLAN_DRAFT_STATES, PLAN_TERMINAL_STATES, PLAN_INACTIVE_STATES
 *   isPlanActive(state)                    -> boolean
 *   isPlanOverdue(state, dueDate, today?)  -> boolean ("overdue")
 *   currentCampaigns({ today? })           -> Promise<Campaign[]>
 *   CERT_WINDOW_DAYS (90), CERT_SOON_DAYS (30)
 *   certWindow(date, today?)               -> 'expired'|'within_90d'|'valid'|null
 *   certWithin30(date, today?)             -> boolean (a SUB-SET of within_90d)
 *   STATUS   compliant, watch, at_risk, not_measured, not_configured, small_n
 *   READINESS ready, not_ready, partial, not_assessed, no_requirement
 *   VOCAB    the label keys in the `kpi` namespace
 *   SMALL_N  (5)
 *   BANDS    per-KPI thresholds
 *   statusBand(value, kpiId, { threshold? }) -> a STATUS code or null
 */

// ---------------------------------------------------------------------------
// "Active" for a performance plan (PIP), a development plan (IDP) or a
// coaching plan: neither draft nor terminal. One list for the three plan
// types. A state that is not listed and not blank is active: a new
// non-terminal state added later counts as active by default, the cautious
// reading for a "plans to follow" figure. A proposed PIP is a silent proposal
// the manager has not activated yet: a draft.
// ---------------------------------------------------------------------------
const PLAN_DRAFT_STATES = Object.freeze(['draft', 'proposed']);
const PLAN_TERMINAL_STATES = Object.freeze([
    'completed',
    'closed',
    'closed_success',
    'closed_failure',
    'cancelled',
    'withdrawn',
    'rejected',
    'archived',
]);
const PLAN_INACTIVE_STATES = Object.freeze([...PLAN_DRAFT_STATES, ...PLAN_TERMINAL_STATES]);

function isPlanActive(state) {
    if (state === null || state === undefined) return false;
    const s = String(state).trim().toLowerCase();
    if (!s) return false;
    if (PLAN_INACTIVE_STATES.includes(s)) return false;
    // any later "closed_*" outcome is terminal too
    if (s.startsWith('closed')) return false;
    return true;
}

/** YYYY-MM-DD of a Date / string / null, in local calendar terms. */
function dayKey(d) {
    if (d === null || d === undefined || d === '') return null;
    if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10);
    const x = d instanceof Date ? d : new Date(d);
    if (Number.isNaN(x.getTime())) return null;
    const p = (n) => String(n).padStart(2, '0');
    return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
}

function todayKey(today) {
    return dayKey(today || new Date());
}

function addDays(key, n) {
    const [y, m, d] = key.split('-').map(Number);
    const x = new Date(Date.UTC(y, m - 1, d + n));
    return x.toISOString().slice(0, 10);
}

/** "Overdue": an ACTIVE plan whose due date is strictly before today. */
function isPlanOverdue(state, dueDate, today) {
    if (!isPlanActive(state)) return false;
    const due = dayKey(dueDate);
    if (!due) return false; // no due date: never overdue
    return due < todayKey(today);
}

// ---------------------------------------------------------------------------
// Certification windows.
//   expired      valid until < today
//   within_90d   today <= valid until <= today + 90
//   "of which 30 days" is a SUB-SET of the 90-day figure, never a rival number.
// ---------------------------------------------------------------------------
const CERT_WINDOW_DAYS = 90;
const CERT_SOON_DAYS = 30;

/** Window of a certificate's expiry date; null when it has no expiry. */
function certWindow(date, today) {
    const exp = dayKey(date);
    if (!exp) return null;
    const t = todayKey(today);
    if (exp < t) return 'expired';
    if (exp <= addDays(t, CERT_WINDOW_DAYS)) return 'within_90d';
    return 'valid';
}

function certWithin30(date, today) {
    const exp = dayKey(date);
    if (!exp) return false;
    const t = todayKey(today);
    return exp >= t && exp <= addDays(t, CERT_SOON_DAYS);
}

// ---------------------------------------------------------------------------
// "Current campaign": open AND its window contains today, or locked (the
// employee window has ended and the reviews are in progress) until it is
// closed or cancelled. Several are shown separately, never added up. None is
// an explicit state ("No campaign in progress"), never 0 %.
// ---------------------------------------------------------------------------
function isCurrentCampaign(cycle, today) {
    if (!cycle) return false;
    const status = String(cycle.status);
    if (status === 'locked') return true;
    if (status !== 'open') return false;
    const t = todayKey(today);
    const opens = dayKey(cycle.openedAt || cycle.opened_at);
    const closes = dayKey(cycle.closesAt || cycle.closes_at);
    if (opens && opens > t) return false;
    if (closes && closes < t) return false;
    return true;
}

async function currentCampaigns({ today } = {}) {
    const db = require('../config/database');
    const rows = await db.all(
        `SELECT c.id, c.code, c.label, c.status, c.opened_at AS "openedAt", c.closes_at AS "closesAt"
           FROM assessment_cycles c
          WHERE c.status IN ('open', 'locked')
          ORDER BY (c.status = 'open') DESC, c.opened_at DESC NULLS LAST, c.id DESC`
    );
    return (rows || [])
        .filter((c) => isCurrentCampaign(c, today))
        .map((c) => ({
            id: Number(c.id),
            code: c.code || null,
            label: c.label || null,
            status: String(c.status || 'open'),
            openedAt: c.openedAt || null,
            closesAt: c.closesAt || null,
        }));
}

// ---------------------------------------------------------------------------
// Vocabulary. "critical" is reserved for criticality (role or skill).
// Urgency: overdue (past due) / due soon (<= 30 days). Status: compliant,
// watch, at risk. Values are English codes; VOCAB holds their label keys.
// ---------------------------------------------------------------------------
const STATUS = Object.freeze({
    COMPLIANT: 'compliant',
    WATCH: 'watch',
    AT_RISK: 'at_risk',
    NOT_MEASURED: 'not_measured',
    NOT_CONFIGURED: 'not_configured',
    SMALL_N: 'small_n',
});

/** The four readiness states of one person, plus "no requirement defined". */
const READINESS = Object.freeze({
    READY: 'ready',
    NOT_READY: 'not_ready',
    PARTIAL: 'partial',
    NOT_ASSESSED: 'not_assessed',
    NO_REQUIREMENT: 'no_requirement',
});
const READINESS_STATES = Object.freeze(Object.values(READINESS));

const VOCAB = Object.freeze({
    status: Object.freeze({
        compliant: 'kpi:status_compliant',
        watch: 'kpi:status_watch',
        at_risk: 'kpi:status_at_risk',
        not_measured: 'kpi:status_not_measured',
        not_configured: 'kpi:status_not_configured',
        small_n: 'kpi:status_small_n',
    }),
    urgency: Object.freeze({
        overdue: 'kpi:urgency_overdue',
        due_soon: 'kpi:urgency_due_soon',
    }),
    readiness: Object.freeze({
        ready: 'kpi:state_ready',
        not_ready: 'kpi:state_not_ready',
        partial: 'kpi:state_partial',
        not_assessed: 'kpi:state_not_assessed',
        no_requirement: 'kpi:state_no_requirement',
    }),
    criticality: Object.freeze({
        critical_role: 'kpi:crit_role', // role_criticality.criticality_score >= 4
        critical_skill: 'kpi:crit_skill', // requirement flag is_critical
        blocking_safety_requirement: 'kpi:crit_safety_blocking', // safety gate
    }),
    noSite: 'kpi:no_site',
    noCampaign: 'kpi:no_campaign',
    lowCoverage: 'kpi:coverage_insufficient',
});

/** A "critical role". */
const CRITICAL_ROLE_MIN_SCORE = 4;

/** Below this many people a percentage is not printed. */
const SMALL_N = 5;

/**
 * Thresholds. `good` is the lowest "compliant" value, `warn` the lowest
 * "watch" value. `good: 'threshold'` = the readiness threshold of the
 * settings (app_readiness_threshold(), one source). Count KPIs carry their
 * own rule.
 */
const BANDS = Object.freeze({
    K1: Object.freeze({ good: 'threshold', warn: 50 }),
    K2: Object.freeze({ good: 'threshold', warn: 50 }),
    // K3 below 50 is "insufficient coverage": amber, NEVER red.
    K3: Object.freeze({ good: 'threshold', warn: 50, neverRisk: true }),
    K4: Object.freeze({ good: 100, warn: 95 }),
    K5: Object.freeze({ good: 'threshold', warn: 50 }),
    K9: Object.freeze({ good: 100, warn: 95 }),
    // counts: value <= good compliant, <= warn watch, else at risk
    K6: Object.freeze({ count: true, good: 0, warn: 2 }),
    K7: Object.freeze({ count: true, good: 0, warn: 3 }),
    K8: Object.freeze({ count: true, good: 0, warn: 0 }), // expired: 0 compliant, >= 1 at risk
    K16: Object.freeze({ count: true, good: 0, warn: Infinity }), // overdue > 0: watch
});

/**
 * The safety and compliance percentages (K4 critical requirements met, K9
 * people fit for their assignment). A shortfall means somebody is not
 * compliant, so their % never rounds UP (utils/displayedValue 'pct1Floor')
 * and they are never "compliant" while one falls short (KpiService.pctResult
 * decides on the raw counts).
 */
const SAFETY_PCT_KPIS = Object.freeze(['K4', 'K9']);
const isSafetyPct = (kpiId) => SAFETY_PCT_KPIS.includes(kpiId);

/**
 * Status band of a value. null / undefined / NaN gives null: the caller
 * decides between "not measured" and "not configured", a missing value never
 * gets a colour. Informational KPIs (K11 time-aware, K13, K14, K15) give null.
 */
function statusBand(value, kpiId, { threshold = 80 } = {}) {
    if (value === null || value === undefined || value === '') return null;
    const v = Number(value);
    if (!Number.isFinite(v)) return null;
    const b = BANDS[kpiId];
    if (!b) return null;
    if (b.count) {
        if (v <= b.good) return STATUS.COMPLIANT;
        if (v <= b.warn) return STATUS.WATCH;
        return STATUS.AT_RISK;
    }
    const thr = Number(threshold);
    const good = b.good === 'threshold' ? (Number.isFinite(thr) ? thr : 80) : b.good;
    if (v >= good) return STATUS.COMPLIANT;
    if (v >= b.warn) return STATUS.WATCH;
    return b.neverRisk ? STATUS.WATCH : STATUS.AT_RISK;
}

/**
 * K11 time-aware band: validated % >= elapsed % is compliant; more than 20
 * points below the elapsed % is at risk; otherwise watch. null when either
 * side is unknown.
 */
function campaignBand(validatedPct, elapsedPct) {
    if (validatedPct == null || elapsedPct == null) return null;
    const v = Number(validatedPct);
    const e = Number(elapsedPct);
    if (!Number.isFinite(v) || !Number.isFinite(e)) return null;
    if (v >= e) return STATUS.COMPLIANT;
    if (v < e - 20) return STATUS.AT_RISK;
    return STATUS.WATCH;
}

/** K12: a "large" self-vs-validated gap, in levels (|gap| >= 2). */
const K12_LARGE_GAP = 2;
/** K13: an uplift counts when it happens within this many days after completion. */
const UPLIFT_WINDOW_DAYS = 180;
/** K13: completions considered (rolling window ending today). */
const UPLIFT_LOOKBACK_DAYS = 365;
/** K14: the median is printed only from this many people. */
const K14_MIN_N = 5;

/**
 * K12 band on the MEAN SIGNED gap (self - validated), by its absolute value:
 * |mean| <= 0.3 compliant, <= 0.7 watch, > 0.7 at risk. null gives null.
 */
function k12Band(meanGap) {
    if (meanGap === null || meanGap === undefined || meanGap === '') return null;
    const v = Math.abs(Number(meanGap));
    if (!Number.isFinite(v)) return null;
    if (v <= 0.3) return STATUS.COMPLIANT;
    if (v <= 0.7) return STATUS.WATCH;
    return STATUS.AT_RISK;
}

module.exports = {
    K12_LARGE_GAP,
    UPLIFT_WINDOW_DAYS,
    UPLIFT_LOOKBACK_DAYS,
    K14_MIN_N,
    k12Band,
    PLAN_DRAFT_STATES,
    PLAN_TERMINAL_STATES,
    PLAN_INACTIVE_STATES,
    isPlanActive,
    isPlanOverdue,
    CERT_WINDOW_DAYS,
    CERT_SOON_DAYS,
    certWindow,
    certWithin30,
    currentCampaigns,
    STATUS,
    READINESS,
    READINESS_STATES,
    VOCAB,
    CRITICAL_ROLE_MIN_SCORE,
    SMALL_N,
    BANDS,
    SAFETY_PCT_KPIS,
    isSafetyPct,
    statusBand,
    campaignBand,
    _internal: { dayKey, addDays, isCurrentCampaign },
};
