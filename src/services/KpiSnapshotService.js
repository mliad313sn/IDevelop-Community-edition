'use strict';

/**
 * KpiSnapshotService — writes and reads the stored history of the headline KPIs
 * (table kpi_snapshots, migration 82).
 *
 * WHY THIS EXISTS
 *   Before this, the schema held exactly ONE stored KPI history —
 *   benchmark_fit_history, which is per-ROLE benchmark fit, not the executive
 *   strip. So no KPI card could say "82 % (+3 since last month)", and the one
 *   surface that tried (the executive trend chart) manufactured its history by
 *   subtracting raw 0-4 skill-level deltas from a sum of readiness PERCENTAGES.
 *
 * THE ABSENT-DELTA RULE (the reason this service is careful)
 *   `delta` returns null — not 0 — whenever there is no comparable prior
 *   snapshot, or when either side of the comparison is NULL (unmeasured). The
 *   dashboard renders nothing at all in that case. This is a development machine
 *   with almost no history; a confident "+0.0 since last month" drawn from a
 *   single day of data would be a fabricated trend, which is worse than no
 *   trend. Callers must treat null as "do not render".
 *
 * IDEMPOTENCY
 *   One row per (snapshot_date, scope_type, scope_id), enforced by a unique
 *   index and written with ON CONFLICT DO NOTHING — exactly the contract
 *   jobs/fit-history.js has proven with 736 live rows. The tick can therefore
 *   run hourly and only the first run of a day writes.
 */

const db = require('../config/database');

/** Numeric metrics that carry a delta on the dashboard. */
const METRICS = [
    'avgReadiness',
    'assessmentCoverage',
    'criticalCompliance',
    'roleReadyCount',
    'measuredEmployees',
    'soleHolderCount',
    'certsExpiring90d',
    // KPI module (migration 184)
    'notReadyCount',
    'partialCount',
    'unassessedCount',
    'criticalUnassessed',
    'certsExpired',
    'safetyFitPct',
    // K5 / K6 (migration 189)
    'benchStrengthPct',
    'criticalRolesWithoutReady',
];

/** The scopes a snapshot row may describe (department from migration 187). */
const SCOPE_TYPES = Object.freeze(['org', 'site', 'department']);

/** Every metric column of a row, camelCase, for the narrative reads. */
const ROW_COLUMNS = `snapshot_date        AS "date",
                    total_employees      AS "totalEmployees",
                    measured_employees   AS "measuredEmployees",
                    avg_readiness        AS "avgReadiness",
                    assessment_coverage  AS "assessmentCoverage",
                    critical_compliance  AS "criticalCompliance",
                    role_ready_count     AS "roleReadyCount",
                    sole_holder_count    AS "soleHolderCount",
                    certs_expiring_90d   AS "certsExpiring90d",
                    not_ready_count      AS "notReadyCount",
                    partial_count        AS "partialCount",
                    unassessed_count     AS "unassessedCount",
                    critical_unassessed  AS "criticalUnassessed",
                    certs_expired        AS "certsExpired",
                    safety_fit_pct       AS "safetyFitPct",
                    safety_fit_n         AS "safetyFitN",
                    bench_strength_pct   AS "benchStrengthPct",
                    bench_critical_roles AS "benchCriticalRoles",
                    critical_roles_without_ready AS "criticalRolesWithoutReady",
                    kpi_contract         AS "kpiContract"`;

/** A row with an ISO date and every numeric column as a number or null. */
function normRow(row) {
    if (!row) return null;
    const out = { ...row };
    for (const [k, v] of Object.entries(row)) {
        if (k === 'date' || k === 'kpiContract') continue;
        out[k] = numOrNull(v);
    }
    out.date = row.date instanceof Date ? toDay(row.date) : String(row.date).slice(0, 10);
    return out;
}

/** YYYY-MM-DD of a DATE column read by node-pg (local midnight). */
function toDay(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Metrics whose definition is the SAME before and after the KPI module
 * (kpi_snapshots.kpi_contract NULL vs KpiService.CONTRACT_VERSION). IDevelop's
 * dashboard already computed them the KPI way (assessed-only readiness, real
 * coverage, critical met over critical assessed, people with an assessed
 * requirement), and c326-DK-kpi-reconciliation-db.test.js proves both sides
 * agree. Only these may be compared across a contract change; every other
 * metric changed meaning (four-state "Ready", K7 critical cells, K8 people
 * with a REQUIRED certificate) and is compared within one contract only.
 */
const CONTRACT_STABLE_METRICS = Object.freeze([
    'avgReadiness',
    'assessmentCoverage',
    'criticalCompliance',
    'measuredEmployees',
]);

/** null-preserving number coercion: '' / null / undefined / NaN all stay null. */
function numOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/** The KPI contract the KPI module writes (KpiService.CONTRACT_VERSION). */
function currentContract() {
    return require('./KpiService').CONTRACT_VERSION;
}

const KpiSnapshotService = {
    METRICS,
    SCOPE_TYPES,
    CONTRACT_STABLE_METRICS,
    currentContract,

    /**
     * Capture today's snapshot for one scope. Idempotent per day.
     * @returns {Promise<{written: boolean}>}
     */
    async capture(scopeType, scopeId, scopeLabel, metrics) {
        const type = SCOPE_TYPES.includes(scopeType) ? scopeType : 'org';
        const id = type === 'org' ? 0 : Number(scopeId) || 0;
        const m = metrics || {};

        // COUNTS DERIVED FROM MEASUREMENT ARE NULL WHEN NOTHING WAS MEASURED.
        //
        // The averages already come back null for an empty scope, but COUNT
        // cannot: a site nobody has assessed reports roleReadyCount 0,
        // rolesAtRisk 0. Stored as 0 they are indistinguishable from a measured
        // zero, and the day the site IS assessed the delta reads "+4
        // role-ready" — four people who did not become ready, they became
        // visible. totalEmployees and measuredEmployees stay as they are: those
        // ARE facts about an empty scope, and they are what makes the null
        // above readable.
        const nothingMeasured = numOrNull(m.measuredEmployees) === 0;
        const measuredCount = (v) => (nothingMeasured ? null : numOrNull(v));
        const res = await db.run(
            `INSERT INTO kpi_snapshots (
                 snapshot_date, scope_type, scope_id, scope_label,
                 total_employees, measured_employees,
                 avg_readiness, avg_readiness_all, assessment_coverage,
                 assessed_requirements, expected_requirements,
                 critical_compliance, role_ready_count, roles_at_risk, roles_unmeasured,
                 sole_holder_count, no_qualified_count, certs_expiring_90d, measured_signature,
                 not_ready_count, partial_count, unassessed_count, critical_unassessed,
                 certs_expired, safety_fit_pct, kpi_contract, safety_fit_n,
                 bench_strength_pct, bench_critical_roles, critical_roles_without_ready)
             VALUES (CURRENT_DATE, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                     ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (snapshot_date, scope_type, scope_id) DO NOTHING`,
            [
                type,
                id,
                scopeLabel || null,
                numOrNull(m.totalEmployees),
                numOrNull(m.measuredEmployees),
                numOrNull(m.avgReadiness),
                numOrNull(m.avgReadinessAll),
                numOrNull(m.assessmentCoverage),
                numOrNull(m.assessedRequirements),
                numOrNull(m.expectedRequirements),
                numOrNull(m.criticalCompliance),
                measuredCount(m.roleReadyCount),
                // roles_at_risk is a MEASURED finding; roles_unmeasured is the
                // coverage that makes it readable (migration 106). Stored as a
                // pair from the same KPI call so a day can never disagree with itself.
                measuredCount(m.rolesAtRisk),
                numOrNull(m.rolesUnmeasured),
                numOrNull(m.soleHolderCount),
                numOrNull(m.noQualifiedCount),
                numOrNull(m.certsExpiring90d),
                // Fingerprint of WHO was measured: null when nobody was.
                nothingMeasured ? null : m.measuredSignature || null,
                // KPI module (migration 184). The verdict counts derive from
                // measurement (NULL when nothing was measured); "Not assessed"
                // and "Not demonstrated" are facts about the scope.
                measuredCount(m.notReadyCount),
                measuredCount(m.partialCount),
                numOrNull(m.unassessedCount),
                numOrNull(m.criticalUnassessed),
                numOrNull(m.certsExpired),
                numOrNull(m.safetyFitPct),
                m.kpiContract ? String(m.kpiContract) : null,
                // K9 denominator (migration 187) and K5 / K6 (migration 189):
                // NULL stays NULL (unknown n, no critical role designated).
                numOrNull(m.safetyFitN),
                numOrNull(m.benchStrengthPct),
                numOrNull(m.benchCriticalRoles),
                numOrNull(m.criticalRolesWithoutReady),
            ]
        );
        return { written: Boolean(res && (res.changes === undefined || res.changes > 0)) };
    },

    /** True when a snapshot for this scope already exists today. */
    async hasToday(scopeType = 'org', scopeId = 0) {
        const row = await db.get(
            `SELECT 1 AS x FROM kpi_snapshots
              WHERE snapshot_date = CURRENT_DATE AND scope_type = ? AND scope_id = ? LIMIT 1`,
            [scopeType, Number(scopeId) || 0]
        );
        return Boolean(row);
    },

    /**
     * The full stored series for a scope, oldest first.
     * Rows come back with camelCase metric keys and an ISO `date`.
     */
    async series(scopeType = 'org', scopeId = 0, days = 400) {
        const rows = await db.all(
            `SELECT snapshot_date        AS "date",
                    total_employees      AS "totalEmployees",
                    measured_employees   AS "measuredEmployees",
                    avg_readiness        AS "avgReadiness",
                    avg_readiness_all    AS "avgReadinessAll",
                    assessment_coverage  AS "assessmentCoverage",
                    critical_compliance  AS "criticalCompliance",
                    role_ready_count     AS "roleReadyCount",
                    roles_at_risk        AS "rolesAtRisk",
                    roles_unmeasured     AS "rolesUnmeasured",
                    sole_holder_count    AS "soleHolderCount",
                    no_qualified_count   AS "noQualifiedCount",
                    certs_expiring_90d   AS "certsExpiring90d",
                    not_ready_count      AS "notReadyCount",
                    partial_count        AS "partialCount",
                    unassessed_count     AS "unassessedCount",
                    critical_unassessed  AS "criticalUnassessed",
                    certs_expired        AS "certsExpired",
                    safety_fit_pct       AS "safetyFitPct",
                    bench_strength_pct   AS "benchStrengthPct",
                    critical_roles_without_ready AS "criticalRolesWithoutReady",
                    kpi_contract         AS "kpiContract"
               FROM kpi_snapshots
              WHERE scope_type = ? AND scope_id = ?
                AND snapshot_date >= CURRENT_DATE - ?::int
              ORDER BY snapshot_date ASC`,
            [scopeType, Number(scopeId) || 0, Math.max(1, Math.min(3650, Number(days) || 400))]
        );
        return (rows || []).map((r) => ({
            ...r,
            date:
                r.date instanceof Date
                    ? r.date.toISOString().slice(0, 10)
                    : String(r.date).slice(0, 10),
            // Every metric stays null when it was null in the table.
            avgReadiness: numOrNull(r.avgReadiness),
            avgReadinessAll: numOrNull(r.avgReadinessAll),
            assessmentCoverage: numOrNull(r.assessmentCoverage),
            criticalCompliance: numOrNull(r.criticalCompliance),
            safetyFitPct: numOrNull(r.safetyFitPct),
            benchStrengthPct: numOrNull(r.benchStrengthPct),
            criticalRolesWithoutReady: numOrNull(r.criticalRolesWithoutReady),
        }));
    },

    /**
     * How much older than `beforeDays` a snapshot may be and still serve as the
     * comparison point, as a multiple of `beforeDays`.
     *
     * There used to be no upper bound at all: the query asked for the most
     * recent snapshot at least 28 days old and took whatever came back, so a
     * chip captioned as a month-on-month movement compared against a snapshot
     * 300 days old in testing. The date rides in the tooltip, but a reader who
     * does not hover sees a month's change that is nothing of the kind.
     *
     * Beyond this window there is no honest month-on-month delta to show, and
     * the caller renders nothing — the same as a fresh install.
     */
    MAX_PRIOR_AGE_FACTOR: 3,

    /**
     * The most recent snapshot STRICTLY OLDER than `beforeDays` days and no
     * older than MAX_PRIOR_AGE_FACTOR x that, used as the comparison point for
     * a delta. Returns null when there is none — the normal state on a fresh
     * install, and it MUST render as no delta.
     *
     * Same contract only by default (migration 184): `contract` null = a row
     * written before the KPI module; KpiService.CONTRACT_VERSION = a row the
     * KPI module wrote. `anyContract: true` drops that filter; deltas() uses
     * it for CONTRACT_STABLE_METRICS only.
     */
    async priorSnapshot(
        scopeType = 'org',
        scopeId = 0,
        beforeDays = 28,
        contract = null,
        { anyContract = false } = {}
    ) {
        const days = Math.max(0, Number(beforeDays) || 28);
        const row = await db.get(
            `SELECT snapshot_date        AS "date",
                    measured_employees   AS "measuredEmployees",
                    avg_readiness        AS "avgReadiness",
                    assessment_coverage  AS "assessmentCoverage",
                    critical_compliance  AS "criticalCompliance",
                    role_ready_count     AS "roleReadyCount",
                    sole_holder_count    AS "soleHolderCount",
                    certs_expiring_90d   AS "certsExpiring90d",
                    measured_signature   AS "measuredSignature",
                    not_ready_count      AS "notReadyCount",
                    partial_count        AS "partialCount",
                    unassessed_count     AS "unassessedCount",
                    critical_unassessed  AS "criticalUnassessed",
                    certs_expired        AS "certsExpired",
                    safety_fit_pct       AS "safetyFitPct",
                    bench_strength_pct   AS "benchStrengthPct",
                    critical_roles_without_ready AS "criticalRolesWithoutReady",
                    kpi_contract         AS "kpiContract"
               FROM kpi_snapshots
              WHERE scope_type = ? AND scope_id = ?
                AND snapshot_date <= CURRENT_DATE - ?::int
                AND snapshot_date >= CURRENT_DATE - ?::int
                AND (?::boolean OR kpi_contract IS NOT DISTINCT FROM ?::text)
              ORDER BY snapshot_date DESC
              LIMIT 1`,
            [
                scopeType,
                Number(scopeId) || 0,
                days,
                days * this.MAX_PRIOR_AGE_FACTOR,
                anyContract === true,
                contract ? String(contract) : null,
            ]
        );
        if (!row) return null;
        return {
            ...row,
            date:
                row.date instanceof Date
                    ? row.date.toISOString().slice(0, 10)
                    : String(row.date).slice(0, 10),
        };
    },

    /**
     * Compute per-metric deltas of `current` against the prior snapshot.
     *
     * ABSENT, NOT ZERO: a metric is omitted from the returned object entirely
     * when there is no prior snapshot, when the prior value is NULL, or when the
     * current value is NULL. The caller renders only the keys that are present.
     *
     * ONE CONTRACT: `current.kpiContract` (set by KpiService.snapshotMetrics)
     * picks the rows of the same contract; a caller without it (today's
     * dashboard) compares with rows written before the KPI module. When no
     * same-contract row is in the window, only CONTRACT_STABLE_METRICS are
     * compared with the most recent row of any contract: a metric whose
     * definition changed never shows a movement across the change.
     *
     * @returns {Promise<{since: string|null, values: Object}>}
     */
    async deltas(current, scopeType = 'org', scopeId = 0, beforeDays = 28) {
        const contract = current && current.kpiContract ? String(current.kpiContract) : null;
        let prior = await this.priorSnapshot(scopeType, scopeId, beforeDays, contract);
        let keys = METRICS;
        if (!prior) {
            prior = await this.priorSnapshot(scopeType, scopeId, beforeDays, contract, {
                anyContract: true,
            });
            keys = CONTRACT_STABLE_METRICS;
        }
        if (!prior) return { since: null, values: {}, populationChanged: false };

        const values = {};
        for (const key of keys) {
            const now = numOrNull(current ? current[key] : null);
            const then = numOrNull(prior[key]);
            // Both sides must be real numbers. An unmeasured side yields no delta.
            if (now === null || then === null) continue;
            values[key] = Math.round((now - then) * 10) / 10;
        }
        // did the delta compare the SAME people? A movement in an average can
        // be a change in WHO is averaged rather than in anyone's capability. The
        // net head count catches part of it, but five leavers replaced by five
        // joiners moves nobody's count — only the fingerprint of the measured set
        // reveals it. populationChanged is true when either the count moved OR the
        // fingerprints differ, so the caller can caveat the delta visibly.
        const nowSig = current ? current.measuredSignature : null;
        const thenSig = prior.measuredSignature;
        const netMoved = values.measuredEmployees != null && values.measuredEmployees !== 0;
        const cohortChanged = !!(nowSig && thenSig && nowSig !== thenSig);
        return { since: prior.date, values, populationChanged: netMoved || cohortChanged };
    },

    // ---- Reads for the « What changed » narrative (NarrativeService) ----------
    // Relative to the LATEST row of the scope, not to CURRENT_DATE: the job
    // writes once a day, and a narrative read before it ran must compare
    // yesterday's row with the row `days` before IT.

    /** The most recent row of a scope under one KPI contract, or null. */
    async latest(scopeType, scopeId, contract) {
        if (!SCOPE_TYPES.includes(scopeType)) return null;
        const row = await db.get(
            `SELECT ${ROW_COLUMNS}
               FROM kpi_snapshots
              WHERE scope_type = ? AND scope_id = ?
                AND kpi_contract IS NOT DISTINCT FROM ?::text
                AND snapshot_date <= CURRENT_DATE
              ORDER BY snapshot_date DESC
              LIMIT 1`,
            [scopeType, Number(scopeId) || 0, contract || null]
        );
        return normRow(row);
    },

    /**
     * The comparison row: the most recent row at least `days` before
     * `refDate` and no older than MAX_PRIOR_AGE_FACTOR x days, SAME contract.
     * Null when there is none (fresh install, contract change, a gap).
     */
    async priorTo(scopeType, scopeId, refDate, days, contract) {
        if (!SCOPE_TYPES.includes(scopeType)) return null;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(refDate || ''))) return null;
        const d = Math.max(1, Math.min(366, Number(days) || 7));
        const row = await db.get(
            `SELECT ${ROW_COLUMNS}
               FROM kpi_snapshots
              WHERE scope_type = ? AND scope_id = ?
                AND kpi_contract IS NOT DISTINCT FROM ?::text
                AND snapshot_date <= ?::date - ?::int
                AND snapshot_date >= ?::date - ?::int
              ORDER BY snapshot_date DESC
              LIMIT 1`,
            [
                scopeType,
                Number(scopeId) || 0,
                contract || null,
                refDate,
                d,
                refDate,
                d * this.MAX_PRIOR_AGE_FACTOR,
            ]
        );
        return normRow(row);
    },

    /** The first day a scope has a row under one contract (YYYY-MM-DD), or null. */
    async firstDate(scopeType, scopeId, contract) {
        if (!SCOPE_TYPES.includes(scopeType)) return null;
        const row = await db.get(
            `SELECT to_char(MIN(snapshot_date), 'YYYY-MM-DD') AS "d"
               FROM kpi_snapshots
              WHERE scope_type = ? AND scope_id = ?
                AND kpi_contract IS NOT DISTINCT FROM ?::text`,
            [scopeType, Number(scopeId) || 0, contract || null]
        );
        return row && row.d ? String(row.d) : null;
    },
};

module.exports = KpiSnapshotService;
