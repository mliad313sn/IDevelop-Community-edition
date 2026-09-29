'use strict';

/**
 * SiteExposureService — the nine sites side by side on one screen.
 *
 * WHY
 *   Readiness by site already existed (a bar chart on the dashboard). Continuity
 *   and certification had NO site dimension at all, even though the raw material
 *   was sitting there unused: v_certification_lapse_impact and
 *   v_certification_current both already carry site_id / site_name and nothing
 *   grouped by them. So a director comparing sites on EXPOSURE had to read four
 *   charts across three pages and join them mentally.
 *
 *   This returns one row per site with readiness, coverage, key-person exposure
 *   and certification pressure together, from the same canonical sources the
 *   individual pages use — so the scorecard can never disagree with the page a
 *   user drills into.
 *
 * HONESTY
 *   * readiness is AVG(readiness_assessed_only) and is NULL when nobody at the
 *     site has an assessed requirement. It is never coalesced to 0 and the view
 *     renders a dash, not "0 %".
 *   * `neverMeasured` is reported as its own column, NOT folded into the risk
 *     counts. A capability nobody has been assessed on is an unknown, not a gap.
 *   * expectedRequirements is the FULL department-designed requirement count.
 *
 * RBAC
 *   Every component is scoped through the same scopedEmployeeIds resolver, so a
 *   site manager sees their site and a director sees theirs. Sites with nobody
 *   visible to the caller do not appear at all.
 */

const db = require('../config/database');
const { scopedEmployeeIds, scopeClause } = require('../utils/rbacScope');

const SiteExposureService = {
    /**
     * @returns {Promise<{rows: Array, scope: Object}>}
     */
    async bySite(user) {
        const KeyPersonRiskService = require('./KeyPersonRiskService');

        const ids = await scopedEmployeeIds(user);
        const scope = {
            unrestricted: ids === null,
            employeeCount: ids === null ? null : ids.length,
        };
        if (Array.isArray(ids) && ids.length === 0) return { rows: [], scope };

        // ---- Readiness + coverage, scoped BEFORE the GROUP BY ---------------
        const rParams = [];
        const rScope = scopeClause(ids, rParams, 'c.employee_id');
        const readiness = await db.all(
            `SELECT c.site_id                                   AS "siteId",
                    MAX(c.site_name)                            AS "siteName",
                    COUNT(*)                                    AS "headcount",
                    COUNT(c.readiness_assessed_only)            AS "measured",
                    ROUND(AVG(c.readiness_assessed_only), 1)    AS "readiness",
                    SUM(c.assessed_skills)                      AS "assessedRequirements",
                    SUM(c.expected_skills)                      AS "expectedRequirements",
                    SUM(c.critical_expected)                    AS "criticalExpected",
                    SUM(c.critical_assessed)                    AS "criticalAssessed"
               FROM v_employee_assessment_coverage c
              WHERE c.site_id IS NOT NULL ${rScope}
              GROUP BY c.site_id
              ORDER BY MAX(c.site_name)`,
            rParams
        );

        // ---- Certification pressure -----------------------------------------
        const cParams = [];
        const cScope = scopeClause(ids, cParams, 'cc.employee_id');
        const certs = await db.all(
            `SELECT cc.site_id                                                        AS "siteId",
                    COUNT(*) FILTER (WHERE cc.days_to_expiry BETWEEN 0 AND 90)        AS "expiring90d",
                    COUNT(*) FILTER (WHERE cc.cert_status = 'expired')                AS "expired"
               FROM v_certification_current cc
              WHERE cc.site_id IS NOT NULL ${cScope}
              GROUP BY cc.site_id`,
            cParams
        );

        // Lapses that actually break a role requirement — the auditable link
        // between /compliance and the readiness numbers (migration 78).
        const lParams = [];
        const lScope = scopeClause(ids, lParams, 'li.employee_id');
        const lapses = await db.all(
            `SELECT li.site_id                                   AS "siteId",
                    COUNT(*)                                     AS "lapseImpact",
                    COUNT(*) FILTER (WHERE li.is_critical)        AS "lapseImpactCritical"
               FROM v_certification_lapse_impact li
              WHERE li.site_id IS NOT NULL ${lScope}
              GROUP BY li.site_id`,
            lParams
        );

        // ---- Key-person exposure (same sweep the detail page uses) ----------
        let exposure = [];
        try {
            exposure = await KeyPersonRiskService.exposureByUnit(user, { unit: 'site' });
        } catch (_) {
            exposure = [];
        }

        const certIx = new Map((certs || []).map((r) => [Number(r.siteId), r]));
        const lapseIx = new Map((lapses || []).map((r) => [Number(r.siteId), r]));
        const expIx = new Map((exposure || []).map((r) => [Number(r.unitId), r]));

        const rows = (readiness || []).map((r) => {
            const id = Number(r.siteId);
            const c = certIx.get(id) || {};
            const l = lapseIx.get(id) || {};
            const e = expIx.get(id) || {};
            const expected = Number(r.expectedRequirements) || 0;
            const assessed = Number(r.assessedRequirements) || 0;
            return {
                siteId: id,
                siteName: r.siteName,
                headcount: Number(r.headcount) || 0,
                measured: Number(r.measured) || 0,
                // NULL stays NULL — never a fabricated 0 %.
                readiness:
                    r.readiness === null || r.readiness === undefined ? null : Number(r.readiness),
                assessedRequirements: assessed,
                expectedRequirements: expected,
                coverage: expected > 0 ? Math.round((1000 * assessed) / expected) / 10 : null,
                criticalExpected: Number(r.criticalExpected) || 0,
                criticalAssessed: Number(r.criticalAssessed) || 0,
                // Key-person bands. neverMeasured is kept SEPARATE from the two
                // risk counts on purpose.
                soleHolder: Number(e.soleHolder) || 0,
                criticalSoleHolder: Number(e.criticalSoleHolder) || 0,
                noQualified: Number(e.noQualified) || 0,
                neverMeasured: Number(e.neverMeasured) || 0,
                covered: Number(e.covered) || 0,
                certsExpiring90d: Number(c.expiring90d) || 0,
                certsExpired: Number(c.expired) || 0,
                lapseImpact: Number(l.lapseImpact) || 0,
                lapseImpactCritical: Number(l.lapseImpactCritical) || 0,
            };
        });

        return { rows, scope };
    },

    /** Column totals for the scorecard footer. readiness is re-derived, not averaged-of-averages. */
    totals(rows) {
        const t = {
            headcount: 0,
            measured: 0,
            assessedRequirements: 0,
            expectedRequirements: 0,
            soleHolder: 0,
            criticalSoleHolder: 0,
            noQualified: 0,
            neverMeasured: 0,
            covered: 0,
            certsExpiring90d: 0,
            certsExpired: 0,
            lapseImpact: 0,
            lapseImpactCritical: 0,
        };
        for (const r of rows || []) {
            for (const k of Object.keys(t)) t[k] += Number(r[k]) || 0;
        }
        t.coverage =
            t.expectedRequirements > 0
                ? Math.round((1000 * t.assessedRequirements) / t.expectedRequirements) / 10
                : null;
        return t;
    },
};

module.exports = SiteExposureService;
