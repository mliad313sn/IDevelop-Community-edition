'use strict';

/**
 * kpi-snapshot — daily capture of the executive KPI strip into kpi_snapshots
 * (migration 82), org-wide and per site.
 *
 * Shaped exactly like the proven jobs/fit-history.js: unscoped org truth,
 * idempotent per day (unique key + ON CONFLICT DO NOTHING), cheap early exit,
 * registered hourly so the first run of the day is the one that writes.
 *
 * WHY UNSCOPED
 *   A snapshot is a fact about the organisation, not about whoever happened to
 *   trigger the tick. Reads are scoped at query time by the dashboard; storing
 *   a per-viewer history would make the same day disagree with itself.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   It never substitutes 0 for an unmeasured metric. avg_readiness stays NULL
 *   for a scope where nobody has an assessed requirement, so the delta layer can
 *   correctly render nothing instead of inventing a movement.
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
    const KeyPersonRiskService = require('../services/KeyPersonRiskService');
    const CertificationService = safeRequire('../services/CertificationService');

    // Superadmin-equivalent principal: org truth, no scoping.
    const orgPrincipal = { userType: 'admin', role: 'superadmin', id: null };

    let captured = 0;

    // ---- Org-wide ----------------------------------------------------------
    const orgKpis = await DashboardModel.getOverviewKPIs({});
    const orgExposure = await safeSummary(KeyPersonRiskService, orgPrincipal, null);
    const orgCerts = await safeCertExpiring(CertificationService, null);
    const orgSignature = await safeSignature(DashboardModel, {});

    await KpiSnapshotService.capture('org', 0, null, {
        measuredSignature: orgSignature,
        totalEmployees: orgKpis && orgKpis.totalEmployees,
        measuredEmployees: orgKpis && orgKpis.measuredEmployees,
        avgReadiness: orgKpis && orgKpis.avgReadiness,
        avgReadinessAll: orgKpis && orgKpis.avgReadinessAllRequirements,
        assessmentCoverage: orgKpis && orgKpis.assessmentCoverage,
        assessedRequirements: orgKpis && orgKpis.assessedRequirements,
        expectedRequirements: orgKpis && orgKpis.expectedRequirements,
        criticalCompliance: orgKpis && orgKpis.criticalCompliance,
        roleReadyCount: orgKpis && orgKpis.roleReadyCount,
        rolesAtRisk: orgKpis && orgKpis.rolesAtRisk,
        rolesUnmeasured: orgKpis && orgKpis.rolesUnmeasured,
        soleHolderCount: orgExposure.soleHolder,
        noQualifiedCount: orgExposure.noQualified,
        certsExpiring90d: orgCerts,
    });
    captured++;

    // ---- Per site ----------------------------------------------------------
    // Per-site exposure comes from ONE org-wide sweep rolled up by site, so the
    // site rows and the org row can never disagree about the same cell.
    let exposureBySite = [];
    try {
        exposureBySite = await KeyPersonRiskService.exposureByUnit(orgPrincipal, { unit: 'site' });
    } catch (_) {
        exposureBySite = [];
    }
    const expIndex = new Map(exposureBySite.map((e) => [Number(e.unitId), e]));

    const sites = await db.all('SELECT id, name FROM sites ORDER BY name');
    const failed = [];
    for (const site of sites || []) {
        // One site must not cost the others their day. An unhandled throw here
        // abandoned every remaining site, and because the org row was already
        // written the retry skipped the whole tick.
        try {
            await captureSite(
                KpiSnapshotService,
                DashboardModel,
                CertificationService,
                expIndex,
                site
            );
            captured++;
        } catch (e) {
            failed.push({ site: site.name, error: String((e && e.message) || e).slice(0, 200) });
        }
    }

    // Say what is missing rather than reporting a clean run over a hole.
    return failed.length ? { captured, failed } : { captured };
}

/** Capture one site's row. Extracted so a failure is catchable per site. */
async function captureSite(
    KpiSnapshotService,
    DashboardModel,
    CertificationService,
    expIndex,
    site
) {
    {
        const kpis = await DashboardModel.getOverviewKPIs({ siteIds: [Number(site.id)] });
        const exp = expIndex.get(Number(site.id)) || {};
        const certs = await safeCertExpiring(CertificationService, Number(site.id));
        const sig = await safeSignature(DashboardModel, { siteIds: [Number(site.id)] });
        await KpiSnapshotService.capture('site', Number(site.id), site.name, {
            measuredSignature: sig,
            totalEmployees: kpis && kpis.totalEmployees,
            measuredEmployees: kpis && kpis.measuredEmployees,
            avgReadiness: kpis && kpis.avgReadiness,
            avgReadinessAll: kpis && kpis.avgReadinessAllRequirements,
            assessmentCoverage: kpis && kpis.assessmentCoverage,
            assessedRequirements: kpis && kpis.assessedRequirements,
            expectedRequirements: kpis && kpis.expectedRequirements,
            criticalCompliance: kpis && kpis.criticalCompliance,
            roleReadyCount: kpis && kpis.roleReadyCount,
            rolesAtRisk: kpis && kpis.rolesAtRisk,
            rolesUnmeasured: kpis && kpis.rolesUnmeasured,
            soleHolderCount: exp.soleHolder,
            noQualifiedCount: exp.noQualified,
            certsExpiring90d: certs,
        });
    }
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

function safeRequire(p) {
    try {
        return require(p);
    } catch (_) {
        return null;
    }
}

/** Exposure counts, degrading to nulls rather than failing the whole tick. */
async function safeSummary(KeyPersonRiskService, principal, siteId) {
    try {
        const { summary } = await KeyPersonRiskService.sweep(principal, {
            unit: 'site',
            band: 'all',
            limit: 1,
            ...(siteId ? { unitId: siteId } : {}),
        });
        return summary || {};
    } catch (_) {
        return {};
    }
}

/**
 * Certificates expiring within 90 days. Optional: an instance with no
 * certificate register returns null (unknown), never 0 (a clean bill of health).
 */
async function safeCertExpiring(CertificationService, siteId) {
    try {
        // Count the expiring certs AND the size of the register in the same pass.
        // COUNT(*) alone returned 0 for a scope that tracks NO certificates at all
        // — an absence of a register read as a clean bill of health (and it is
        // delta-eligible, so the 0 would later drive a spurious "improvement").
        // A register with rows but none expiring is a real 0; an empty register is
        // null (unknown).
        const row = await db.get(
            `SELECT SUM(CASE WHEN c.days_to_expiry IS NOT NULL AND c.days_to_expiry BETWEEN 0 AND 90 THEN 1 ELSE 0 END) AS expiring,
                    COUNT(*) AS total
               FROM v_certification_current c
              WHERE 1 = 1
                ${siteId ? 'AND c.site_id = ?' : ''}`,
            siteId ? [siteId] : []
        );
        if (!row || Number(row.total) === 0) return null; // no register in scope → unknown
        return Number(row.expiring) || 0;
    } catch (_) {
        return null;
    }
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

// safeCertExpiring is exported for the test: the null-vs-0 distinction (empty
// register is unknown, not a clean bill of health) is the whole point of J11.
module.exports = { tick, __test: { safeCertExpiring } };
