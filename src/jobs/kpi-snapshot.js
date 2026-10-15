'use strict';

/**
 * kpi-snapshot — daily capture of the headline indicators into kpi_snapshots
 * (migrations 82 and 184), organisation-wide and per site.
 *
 * Shaped exactly like the proven jobs/fit-history.js: unscoped organisation
 * truth, idempotent per day (unique key + ON CONFLICT DO NOTHING), cheap early
 * exit, registered hourly so the first run of the day is the one that writes.
 *
 * WHERE THE FIGURES COME FROM
 *   KpiService.snapshotMetrics, the same functions every report, the API and
 *   the Power BI feed call: the snapshot of the day IS the indicator for the
 *   same population. Each row carries the contract it was computed under
 *   (kpi_contract), so a movement is never shown across a change of
 *   definition (KpiSnapshotService.deltas).
 *
 * WHY UNSCOPED
 *   A snapshot is a fact about the organisation, not about whoever happened to
 *   trigger the tick. Reads are scoped at query time; storing a per-reader
 *   history would make the same day disagree with itself.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   It never substitutes 0 for an unmeasured metric. avg_readiness stays NULL
 *   for a scope where nobody has an assessed requirement, certs_expired and
 *   certs_expiring_90d stay NULL where no certification is required, so the
 *   delta layer renders nothing instead of inventing a movement.
 */

const db = require('../config/database');

async function tick() {
    const KpiSnapshotService = require('../services/KpiSnapshotService');

    // Cheap skip: only when TODAY IS ACTUALLY COMPLETE.
    //
    // This used to test the org row alone. The org row is written first, so the
    // moment any later site threw, the day was left with a hole AND the guard
    // reported "already_today" on every retry — the missing sites could never
    // be captured for that date, and a gap in a trend line is permanent.
    if (await isDayComplete(KpiSnapshotService)) {
        return { captured: 0, skipped: 'already_today' };
    }

    const DashboardModel = require('../models/DashboardModel');
    let captured = 0;

    // ---- Org-wide ----------------------------------------------------------
    await KpiSnapshotService.capture('org', 0, null, await metricsFor(DashboardModel, null));
    captured++;

    // ---- Per site ----------------------------------------------------------
    const sites = await db.all('SELECT id, name FROM sites ORDER BY name');
    const failed = [];
    for (const site of sites || []) {
        // One site must not cost the others their day. An unhandled throw here
        // abandoned every remaining site, and because the org row was already
        // written the retry skipped the whole tick.
        try {
            await KpiSnapshotService.capture(
                'site',
                Number(site.id),
                site.name,
                await metricsFor(DashboardModel, Number(site.id))
            );
            captured++;
        } catch (e) {
            failed.push({ site: site.name, error: String((e && e.message) || e).slice(0, 200) });
        }
    }

    // Say what is missing rather than reporting a clean run over a hole.
    return failed.length ? { captured, failed } : { captured };
}

/**
 * The metrics of one scope (siteId null = the organisation).
 *
 * The indicators come from KpiService.snapshotMetrics. The legacy columns the
 * KPI module does not define (avg_readiness_all, roles_at_risk,
 * roles_unmeasured) and the fingerprint of the measured population still come
 * from the dashboard model, each degrading to null rather than failing the
 * capture.
 */
async function metricsFor(DashboardModel, siteId) {
    const KpiService = require('../services/KpiService');
    const scope = siteId == null ? { system: true } : { system: true, siteId };
    const m = await KpiService.snapshotMetrics(scope);
    const filters = siteId == null ? {} : { siteIds: [siteId] };
    let legacy = null;
    try {
        legacy = await DashboardModel.getOverviewKPIs(filters);
    } catch (_) {
        legacy = null;
    }
    return {
        ...m,
        measuredSignature: await safeSignature(DashboardModel, filters),
        avgReadinessAll: legacy ? legacy.avgReadinessAllRequirements : null,
        rolesAtRisk: legacy ? legacy.rolesAtRisk : null,
        rolesUnmeasured: legacy ? legacy.rolesUnmeasured : null,
    };
}

/**
 * True when today's org row AND a row for every site already exist.
 * A day with any site missing is NOT complete and must be retried.
 */
async function isDayComplete(KpiSnapshotService) {
    if (!(await KpiSnapshotService.hasToday('org', 0))) return false;
    const row = await db.get(
        `SELECT (SELECT COUNT(*) FROM sites)::int AS expected,
                (SELECT COUNT(*) FROM kpi_snapshots
                  WHERE snapshot_date = CURRENT_DATE AND scope_type = 'site')::int AS got`
    );
    return Number(row.got) >= Number(row.expected);
}

/**
 * Fingerprint of the measured employee-id set for a scope. Best-effort: a
 * failure returns null (the snapshot simply carries no fingerprint, and the delta
 * falls back to the head-count check), never aborts the capture.
 */
async function safeSignature(DashboardModel, filters) {
    try {
        return await DashboardModel.getMeasuredSignature(filters);
    } catch (_) {
        return null;
    }
}

module.exports = { tick, __test: { metricsFor } };
