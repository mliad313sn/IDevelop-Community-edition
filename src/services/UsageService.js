'use strict';

/**
 * UsageService — « Usage by site » (/admin/usage, 4.0.0 port wave 10).
 *
 * Whether people use the product, site by site, for the sponsor who answers
 * for it. (Not the « adoption stages » of Administration → Modules, which say
 * which modules are switched on: this page measures use.) One row per site of
 * the reader's CLEARED population (KpiService.resolvePopulation: active, not
 * erased, not cancelled, inside the reader's clearance):
 *   people        the population of the site
 *   activated     signed in at least once (employees.last_login_at)
 *   selfAssessed  submitted at least one self-assessment line in the last 90 days
 *   validated14   of the lines submitted in the last 90 days and since
 *                 approved, the share approved within 14 days of submission
 *
 * Rules: counts only, never a name; a site of fewer than 5 people shows no
 * figure (« fewer than 5 people »); a share whose denominator is 0 is « not
 * measured yet », never 0 %; a share is rounded DOWN, never up (99.96 % of
 * activated accounts reads 99.9 %, never 100 %).
 */

const SMALL_N = 5;
const WINDOW_DAYS = 90;
const VALIDATE_DAYS = 14;

/** A share in % (one decimal, rounded down); null when there is nothing to measure. Pure. */
function floorPct(numerator, denominator) {
    const n = Number(numerator);
    const d = Number(denominator);
    if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return null;
    return Math.floor((1000 * n) / d) / 10;
}

/** One site row from its raw counts, masked under 5 people. Pure. */
function siteRow(r) {
    const people = Number(r.people) || 0;
    const masked = people < SMALL_N;
    const approved = Number(r.approved) || 0;
    return {
        siteId: r.siteId === null || r.siteId === undefined ? null : Number(r.siteId),
        siteName: r.siteName || null,
        people,
        masked,
        activated: masked ? null : Number(r.activated) || 0,
        activatedPct: masked ? null : floorPct(r.activated, people),
        selfAssessed: masked ? null : Number(r.selfAssessed) || 0,
        selfAssessedPct: masked ? null : floorPct(r.selfAssessed, people),
        approved: masked ? null : approved,
        validated14Pct: masked ? null : floorPct(r.approvedFast, approved),
    };
}

/** The total over every site of the reader (masked under 5 people too). Pure. */
function totalRow(rows) {
    const sum = (k) => (rows || []).reduce((s, r) => s + (Number(r[k]) || 0), 0);
    return siteRow({
        siteId: null,
        siteName: null,
        people: sum('people'),
        activated: sum('activated'),
        selfAssessed: sum('selfAssessed'),
        approved: sum('approved'),
        approvedFast: sum('approvedFast'),
    });
}

async function bySite(viewer) {
    const db = require('../config/database');
    const pop = await require('./KpiService').resolvePopulation({ viewer });
    const base = { smallN: SMALL_N, windowDays: WINDOW_DAYS, validateDays: VALIDATE_DAYS };
    if (!pop.ids.length) return { ...base, rows: [], total: null, people: 0 };
    const raw = await db.all(
        `WITH pop AS (
             SELECT e.id, e.site_id, e.last_login_at FROM employees e WHERE e.id = ANY(?)
         ), sa AS (
             SELECT r.employee_id,
                    COUNT(*) AS submitted,
                    COUNT(*) FILTER (WHERE r.approved_at IS NOT NULL) AS approved,
                    COUNT(*) FILTER (WHERE r.approved_at IS NOT NULL
                                       AND r.approved_at - r.submitted_at <= make_interval(days => ?)) AS approved_fast
               FROM self_assessment_rounds r
              WHERE r.submitted_at IS NOT NULL
                AND r.submitted_at >= now() - make_interval(days => ?)
                AND r.cancelled_at IS NULL
                AND r.employee_id IN (SELECT id FROM pop)
              GROUP BY r.employee_id
         )
         SELECT p.site_id AS "siteId", MAX(si.name) AS "siteName",
                COUNT(*)::int AS "people",
                COUNT(*) FILTER (WHERE p.last_login_at IS NOT NULL)::int AS "activated",
                COUNT(*) FILTER (WHERE COALESCE(sa.submitted, 0) > 0)::int AS "selfAssessed",
                COALESCE(SUM(sa.approved), 0)::int AS "approved",
                COALESCE(SUM(sa.approved_fast), 0)::int AS "approvedFast"
           FROM pop p
           LEFT JOIN sa ON sa.employee_id = p.id
           LEFT JOIN sites si ON si.id = p.site_id
          GROUP BY p.site_id
          ORDER BY MAX(si.name) NULLS LAST, p.site_id`,
        [pop.ids, VALIDATE_DAYS, WINDOW_DAYS]
    );
    const counts = (raw || []).map((r) => ({
        siteId: r.siteId,
        siteName: r.siteName,
        people: Number(r.people) || 0,
        activated: Number(r.activated) || 0,
        selfAssessed: Number(r.selfAssessed) || 0,
        approved: Number(r.approved) || 0,
        approvedFast: Number(r.approvedFast) || 0,
    }));
    return {
        ...base,
        people: pop.ids.length,
        rows: counts.map(siteRow),
        total: counts.length > 1 ? totalRow(counts) : null,
    };
}

module.exports = { SMALL_N, WINDOW_DAYS, VALIDATE_DAYS, floorPct, siteRow, totalRow, bySite };
