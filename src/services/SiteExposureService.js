'use strict';

/**
 * SiteExposureService — the sites side by side on one screen.
 *
 * WHY
 *   A director comparing sites on exposure used to read four charts across
 *   three pages and join them mentally. This returns one row per site with
 *   readiness, level, coverage, key-person exposure and certification pressure
 *   together.
 *
 * ONE SOURCE (KPI contract kpi-2)
 *   Every column is the dashboard's own indicator for that site, computed by
 *   KpiService on the SAME resolved population, so the page cannot contradict
 *   the dashboard a reader drills into:
 *     K1  « Ready for the role »          KpiService.bySite('K1')
 *     K2  « Average readiness »           KpiService.k2ByUnit(site): the one
 *                                         « % of the requirement » estimator,
 *                                         credited at most at the requirement
 *     K3  « Coverage »                    KpiService.bySite('K3')
 *     K7  « Sole holders (critical) »     KpiService.bySite('K7'), talent module
 *     K8  « Certifications »              KpiService.bySite('K8'): expired /
 *                                         within 90 days / not recorded
 *     « Skills held by one person (all) » KeyPersonRiskService, ALL skills,
 *                                         continuity grant only, named apart so
 *                                         it is never read as K7.
 *   The footer is the organisation's KPI result, never a sum or a mean of
 *   site percentages. Colours are the KPI status (the readiness threshold of
 *   the settings), never a hard-coded 80.
 *
 * HONESTY
 *   * A site under 5 people prints counts only: no percentage, no status.
 *   * Unmeasured is « — » with its reason, never 0.
 *   * « No site » is its own row.
 *   * The two « weakest site » answers are named apart (weakestSites): the
 *     fewest people fully ready (K1) and the lowest level against the
 *     requirement (K2) are two measures and two questions.
 *
 * RBAC
 *   The population is KpiService.resolvePopulation (the reader's clearance,
 *   leavers and erased people out). The safety and continuity columns follow
 *   the reader's dashboard capabilities; K7 follows the talent module.
 */

const SMALL_N = 5;

const isNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
const keyOf = (r) =>
    r.noSite || r.siteId === null || r.siteId === undefined ? 'none' : String(r.siteId);

/** The parts of a KPI result a cell needs (no drill: never a person id). */
function pick(r) {
    if (!r) return null;
    return {
        value: isNum(r.value) ? Number(r.value) : null,
        numerator: r.numerator === undefined ? null : r.numerator,
        denominator: r.denominator === undefined ? null : r.denominator,
        n: r.n === undefined ? null : r.n,
        status: r.status || null,
    };
}

/**
 * The two « weakest site » answers, named apart (pure):
 *   ready  the lowest K1 among the measured named sites (5 people or more)
 *   level  the lowest K2 among the named sites with a K2 value
 * null when fewer than 2 sites are measured; `same` when one site is lowest
 * on both.
 */
function weakestSites(rows) {
    const named = (rows || []).filter((r) => !r.noSite);
    const k1 = named
        .filter((r) => !r.smallN && r.k1 && isNum(r.k1.value))
        .sort((a, b) => a.k1.value - b.k1.value);
    if (k1.length < 2) return null;
    const k2 = named
        .filter((r) => r.k2 && isNum(r.k2.value))
        .sort((a, b) => a.k2.value - b.k2.value);
    const ready = k1[0];
    const level = k2.length >= 2 ? k2[0] : null;
    return {
        ready: {
            siteId: ready.siteId,
            siteName: ready.siteName,
            value: ready.k1.value,
            numerator: ready.k1.numerator,
            denominator: ready.k1.denominator,
        },
        level: level
            ? { siteId: level.siteId, siteName: level.siteName, value: level.k2.value }
            : null,
        same: !!level && String(level.siteId) === String(ready.siteId),
    };
}

const SiteExposureService = {
    SMALL_N,
    weakestSites,

    /** @returns {Promise<{rows: Array, scope: Object, org: Object|null, weakest: Object|null}>} */
    async bySite(user, opts = {}) {
        const K = require('./KpiService');
        const pop = await K.resolvePopulation({ viewer: user });
        let unrestricted = false;
        try {
            unrestricted = (await require('../utils/rbacScope').scopedEmployeeIds(user)) === null;
        } catch (_) {
            unrestricted = false;
        }
        const scope = { unrestricted, employeeCount: pop.ids.length };
        if (!pop.ids.length) return { rows: [], scope, org: null, weakest: null };

        let flags = opts.flags || null;
        if (!flags) {
            try {
                flags = await require('./ModuleService').flags();
            } catch (_) {
                flags = {};
            }
        }
        const caps = opts.caps || require('./DashboardHomeService').capabilities(user, pop) || {};
        const showK7 = !!caps.continuity && K.isAvailable('K7', flags);
        scope.caps = { continuity: showK7, safety: !!caps.safety };
        const s = { viewer: user, modules: flags, __population: pop };

        const k1 = await K.bySite('K1', s);
        const k3 = await K.bySite('K3', s);
        const k7 = showK7 ? await K.bySite('K7', s) : null;
        const k8 = caps.safety ? await K.bySite('K8', s) : null;
        const k2 = await K.k2ByUnit(s, 'site');

        let exposure = [];
        if (opts.keyPerson) {
            try {
                exposure = await require('./KeyPersonRiskService').exposureByUnit(user, {
                    unit: 'site',
                });
            } catch (_) {
                exposure = [];
            }
        }
        const ix = (b) => new Map(((b && b.rows) || []).map((r) => [keyOf(r), r.result]));
        const i3 = ix(k3);
        const i7 = ix(k7);
        const i8 = ix(k8);
        const expIx = new Map((exposure || []).map((r) => [String(r.unitId), r]));
        const head = new Map();
        for (const p of pop.rows) {
            const k = p.siteId === null || p.siteId === undefined ? 'none' : String(p.siteId);
            head.set(k, (head.get(k) || 0) + 1);
        }

        const rows = (k1.rows || []).map((r) => {
            const key = keyOf(r);
            const headcount = head.get(key) || 0;
            const smallN = headcount < SMALL_N;
            const r8 = i8.get(key) || null;
            const b8 = (r8 && r8.breakdown) || {};
            const e = expIx.get(key) || null;
            const r7 = i7.get(key) || null;
            return {
                siteId: r.noSite ? null : r.siteId,
                siteName: r.noSite ? null : r.siteName,
                noSite: !!r.noSite,
                headcount,
                smallN,
                k1: pick(r.result),
                k2: pick(k2.units.get(key)) || { value: null, n: 0, status: 'not_measured' },
                k3: pick(i3.get(key)),
                k7: r7 ? { ...pick(r7), neverMeasured: (r7.breakdown || {}).neverMeasured } : null,
                k8: r8
                    ? {
                          status: r8.status || null,
                          expired: b8.expiredPeople === undefined ? null : b8.expiredPeople,
                          expiring: b8.expiringPeople === undefined ? null : b8.expiringPeople,
                          missing: b8.missingPeople === undefined ? null : b8.missingPeople,
                          required: b8.requiredPeople === undefined ? null : b8.requiredPeople,
                      }
                    : null,
                // ALL skills held by one person (continuity grant), never K7
                allSole: e ? Number(e.soleHolder) || 0 : null,
            };
        });
        const org = {
            headcount: pop.ids.length,
            k1: pick(k1.org),
            k2: pick(k2.org),
            k3: pick(k3.org),
            k7: k7 ? pick(k7.org) : null,
            k8: k8 && k8.org ? { ...pick(k8.org), breakdown: k8.org.breakdown || null } : null,
        };
        return { rows, scope, org, weakest: weakestSites(rows) };
    },

    /** Kept for API callers: the footer IS the organisation's KPI result, never a sum of %. */
    totals(rows, org) {
        return org || null;
    },
};

module.exports = SiteExposureService;
