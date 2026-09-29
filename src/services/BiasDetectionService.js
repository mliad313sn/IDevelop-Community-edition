'use strict';

const db = require('../config/database');

/**
 *   BiasDetectionService — Z-score scan of talent placements.
 *
 *   For each grouping dimension (site, department, nationality, gender) the
 *   group's mean placement score is compared with the cycle's mean. The test
 *   statistic is the difference of means over the STANDARD ERROR of a group
 *   mean, not over the spread of individual scores:
 *
 *       z = (groupMean − mean) / SE,   SE = σ/√n · √((N − n)/(N − 1))
 *
 *   σ is the population standard deviation of every placement in the cycle,
 *   n the group size, N the cycle size; the last factor is the finite-population
 *   correction (the group is drawn from the same cycle it is compared with).
 *   Dividing by σ alone — what this service did before — asked whether the
 *   group AVERAGE sat two individual standard deviations from the mean, which on
 *   a 2–6 score range essentially never happens: the scan could not fire.
 *
 *   Honesty rules:
 *     - a group of fewer than MIN_GROUP people is "insufficient data" — never a
 *       result, never an alert (and, for demographic axes, the same small-cell
 *       suppression the DEI analytics apply);
 *     - a placement whose box cannot be read is left out, not scored 0;
 *     - an unknown site / department / nationality / gender is "unspecified",
 *       not a group of its own;
 *     - a cycle with no spread (σ = 0) flags nothing.
 */

// Runtime-tunable from App Settings ('biasZThreshold'); env var / 2.0 fallback.
const ENV_Z_THRESHOLD = Number(process.env.BIAS_Z_THRESHOLD) || 2.0;

// Minimum group size for any statistic — the same floor DEIService uses for
// demographic analytics, so a group this small is never identifiable.
const MIN_GROUP = 5;

const BAND = { low: 1, medium: 2, high: 3 };

/**
 * "{potential}-{performance}" → 2..6, or null when the box is not in that
 * vocabulary. An unreadable box is NOT a low score (it used to count as 0 and
 * pulled the cohort mean down).
 */
function boxScore(box) {
    if (typeof box !== 'string') return null;
    const [pot, perf] = box.trim().toLowerCase().split('-');
    if (!BAND[pot] || !BAND[perf]) return null;
    return BAND[pot] + BAND[perf];
}

/**
 * z of one group against the cycle it belongs to. Returns
 *   { insufficient: true }            when n < MIN_GROUP,
 *   { z: null, reason }               when no comparison is possible,
 *   { z, n, groupMean }               otherwise.
 */
function groupZ(list, { mean, std, total }) {
    const n = list.length;
    if (n < MIN_GROUP) return { insufficient: true, n };
    if (!(std > 0)) return { z: null, n, reason: 'no_variance' };
    if (n >= total) return { z: null, n, reason: 'whole_population' };
    const groupMean = list.reduce((a, b) => a + b, 0) / n;
    const se = (std / Math.sqrt(n)) * Math.sqrt((total - n) / (total - 1));
    if (!(se > 0)) return { z: null, n, reason: 'no_variance' };
    return { z: (groupMean - mean) / se, n, groupMean };
}

// National vs expatriate — the SAME notion as the Local Content module
// (LocalContentController): nationality is resolved to a country through the
// accepted spellings (country_aliases, case/accent-insensitive) and compared
// with the employee's OPERATING country (their site's country, else the
// `localContentHomeCountry` fallback). Blank nationality or no operating
// country → NULL ("unspecified"), never "expatriate".
const NAT_SQL = `CASE WHEN e.nationality IS NULL OR btrim(e.nationality) = '' THEN NULL
                      WHEN COALESCE(_co.id, _hc.id) IS NULL THEN NULL
                      WHEN EXISTS (SELECT 1 FROM country_aliases _ca
                                    WHERE _ca.country_id = COALESCE(_co.id, _hc.id)
                                      AND lower(unaccent(_ca.alias)) = lower(unaccent(btrim(e.nationality))))
                           THEN 1
                      ELSE 0 END`;

async function resolveHomeCountryId() {
    try {
        const AppSettingsModel = require('../models/AppSettingsModel');
        const home = String(
            (await AppSettingsModel.getValue('localContentHomeCountry', '')) || ''
        ).trim();
        if (!home) return null;
        const row = await db.get(
            `SELECT c.id FROM countries c
               JOIN country_aliases ca ON ca.country_id = c.id
              WHERE lower(unaccent(ca.alias)) = lower(unaccent(?))
              ORDER BY c.id LIMIT 1`,
            [home]
        );
        return row ? Number(row.id) : null;
    } catch {
        return null;
    }
}

/** employeeId → 'national' | 'expatriate' (unspecified employees are absent). */
async function nationalityByEmployee(cycleId) {
    const homeCountryId = await resolveHomeCountryId();
    const rows = await db.all(
        `SELECT tp.employee_id, ${NAT_SQL} AS is_national
           FROM talent_placements tp
           JOIN employees e ON e.id = tp.employee_id
           LEFT JOIN sites _st ON _st.id = e.site_id
           LEFT JOIN countries _co ON _co.id = _st.country_id
           LEFT JOIN countries _hc ON _hc.id = ?
          WHERE tp.cycle_id = ?`,
        [homeCountryId, cycleId]
    );
    const out = new Map();
    for (const r of rows || []) {
        const v = r.isNational ?? r.is_national;
        if (v === null || v === undefined) continue;
        out.set(String(r.employeeId ?? r.employee_id), Number(v) === 1 ? 'national' : 'expatriate');
    }
    return out;
}

function blankToNull(v) {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s === '' ? null : s;
}

class BiasDetectionService {
    static async runForCycle(cycleId) {
        const raw = await db.all(
            `SELECT tp.employee_id, tp.box, e.site_id, e.department_id, d.gender
             FROM talent_placements tp
             JOIN employees e ON e.id = tp.employee_id
             LEFT JOIN employee_demographics d ON d.employee_id = tp.employee_id
             WHERE tp.cycle_id = ?`,
            [cycleId]
        );

        // Only placements whose box can be read are scored.
        const rows = [];
        let unreadable = 0;
        for (const r of raw || []) {
            const score = boxScore(r.box);
            if (score === null) {
                unreadable++;
                continue;
            }
            rows.push({ ...r, score });
        }
        if (rows.length < MIN_GROUP) {
            // Not enough placements to say anything: no result, not "0 alerts".
            return {
                alerts: null,
                insufficientData: true,
                sampleTooSmall: true,
                sampleSize: rows.length,
                unreadable,
            };
        }

        let zThreshold = ENV_Z_THRESHOLD;
        try {
            const AppSettingsModel = require('../models/AppSettingsModel');
            const v = Number(await AppSettingsModel.getValue('biasZThreshold', ENV_Z_THRESHOLD));
            if (Number.isFinite(v) && v > 0) zThreshold = v;
        } catch {
            /* settings unavailable → env/default */
        }

        const total = rows.length;
        const mean = rows.reduce((a, r) => a + r.score, 0) / total;
        const variance = rows.reduce((s, r) => s + (r.score - mean) ** 2, 0) / total;
        const std = Math.sqrt(variance);

        // Nationality axis — optional (country_aliases / unaccent may be absent on
        // an older schema): unavailable is reported, never guessed.
        let natMap = null;
        try {
            natMap = await nationalityByEmployee(cycleId);
        } catch {
            natMap = null;
        }

        // NB: the DB driver camelCases result-row keys, so read siteId/departmentId
        // (not site_id/department_id) or every row collapses into one bucket → 0 alerts.
        const groupings = [
            { dim: 'site', value: (r) => blankToNull(r.siteId) },
            { dim: 'department', value: (r) => blankToNull(r.departmentId) },
            {
                dim: 'nationality',
                value: (r) =>
                    natMap ? natMap.get(String(r.employeeId ?? r.employee_id)) || null : null,
                unavailable: !natMap,
            },
            { dim: 'gender', value: (r) => blankToNull(r.gender) },
        ];

        let alerts = 0;
        const dimensions = {};
        for (const g of groupings) {
            const summary = {
                groupsAnalysed: 0,
                groupsInsufficient: 0,
                unspecified: 0,
                flagged: 0,
            };
            if (g.unavailable) summary.unavailable = true;
            dimensions[g.dim] = summary;
            if (g.unavailable) continue;

            const map = new Map();
            for (const r of rows) {
                const k = g.value(r);
                if (k === null) {
                    summary.unspecified++;
                    continue;
                }
                if (!map.has(k)) map.set(k, []);
                map.get(k).push(r.score);
            }
            for (const [val, list] of map) {
                const res = groupZ(list, { mean, std, total });
                if (res.insufficient) {
                    summary.groupsInsufficient++;
                    continue;
                }
                summary.groupsAnalysed++;
                if (res.z === null || !(Math.abs(res.z) > zThreshold)) continue;
                summary.flagged++;
                const z = Number(res.z.toFixed(3));
                // Idempotent re-scan: dedup on the natural key (cycle, dim, value) so a
                // re-run doesn't pile up duplicate rows. Refresh the score on an existing
                // alert but preserve its state/notes (an analyst may have triaged it).
                const existing = await db.get(
                    `SELECT id FROM bias_alerts WHERE cycle_id = ? AND group_dim = ? AND group_value = ?`,
                    [cycleId, g.dim, String(val)]
                );
                if (existing) {
                    await db.run(`UPDATE bias_alerts SET z_score = ? WHERE id = ?`, [
                        z,
                        existing.id,
                    ]);
                } else {
                    await db.run(
                        `INSERT INTO bias_alerts (cycle_id, group_dim, group_value, z_score)
                         VALUES (?, ?, ?, ?)`,
                        [cycleId, g.dim, String(val), z]
                    );
                    alerts++;
                }
            }
        }
        return {
            alerts,
            sampleSize: total,
            unreadable,
            zThreshold,
            minGroupSize: MIN_GROUP,
            noVariance: !(std > 0),
            dimensions,
        };
    }
}

BiasDetectionService.boxScore = boxScore;
BiasDetectionService.groupZ = groupZ;
BiasDetectionService.MIN_GROUP = MIN_GROUP;

module.exports = BiasDetectionService;
