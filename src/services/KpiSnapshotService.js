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
];

/** null-preserving number coercion: '' / null / undefined / NaN all stay null. */
function numOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

const KpiSnapshotService = {
    METRICS,

    /**
     * Capture today's snapshot for one scope. Idempotent per day.
     * @returns {Promise<{written: boolean}>}
     */
    async capture(scopeType, scopeId, scopeLabel, metrics) {
        const type = scopeType === 'site' ? 'site' : 'org';
        const id = type === 'site' ? Number(scopeId) || 0 : 0;
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
                 sole_holder_count, no_qualified_count, certs_expiring_90d, measured_signature)
             VALUES (CURRENT_DATE, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                    certs_expiring_90d   AS "certsExpiring90d"
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
     */
    async priorSnapshot(scopeType = 'org', scopeId = 0, beforeDays = 28) {
        const row = await db.get(
            `SELECT snapshot_date        AS "date",
                    measured_employees   AS "measuredEmployees",
                    avg_readiness        AS "avgReadiness",
                    assessment_coverage  AS "assessmentCoverage",
                    critical_compliance  AS "criticalCompliance",
                    role_ready_count     AS "roleReadyCount",
                    sole_holder_count    AS "soleHolderCount",
                    certs_expiring_90d   AS "certsExpiring90d",
                    measured_signature   AS "measuredSignature"
               FROM kpi_snapshots
              WHERE scope_type = ? AND scope_id = ?
                AND snapshot_date <= CURRENT_DATE - ?::int
                AND snapshot_date >= CURRENT_DATE - ?::int
              ORDER BY snapshot_date DESC
              LIMIT 1`,
            [
                scopeType,
                Number(scopeId) || 0,
                Math.max(0, Number(beforeDays) || 28),
                Math.max(0, Number(beforeDays) || 28) * this.MAX_PRIOR_AGE_FACTOR,
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
     * @returns {Promise<{since: string|null, values: Object}>}
     */
    async deltas(current, scopeType = 'org', scopeId = 0, beforeDays = 28) {
        const prior = await this.priorSnapshot(scopeType, scopeId, beforeDays);
        if (!prior) return { since: null, values: {}, populationChanged: false };

        const values = {};
        for (const key of METRICS) {
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
};

module.exports = KpiSnapshotService;
