'use strict';

const db = require('../config/database');

/**
 *   TalentService — folds the standalone nine-box-tool-enhanced.html
 *   formulas into the platform.
 *
 *   recordRating(...)    persist a reviewer's rating row.
 *   computePlacement(...) average ratings, classify perf/pot, derive box.
 *   override(...)         manual move (with reason); cannot exceed 1
 *                        box of deviation without a justification.
 */

const LEVEL_SCORE = { low: 1, medium: 2, high: 3 };

function classify(avg) {
    if (avg >= 2.5) return 'high';
    if (avg >= 1.5) return 'medium';
    return 'low';
}

class TalentService {
    static async recordRating({
        employeeId,
        reviewerId,
        reviewerRole,
        performance,
        potential,
        cycleId,
    }) {
        const r = await db.run(
            `INSERT INTO talent_ratings (employee_id, reviewer_id, reviewer_role, performance, potential, cycle_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [employeeId, reviewerId, reviewerRole, performance, potential, cycleId]
        );
        return r.lastID;
    }

    static async computePlacement({ employeeId, cycleId }) {
        const rows = await db.all(
            `SELECT performance, potential FROM talent_ratings WHERE employee_id = ? AND cycle_id = ?`,
            [employeeId, cycleId]
        );
        if (!rows.length) return null;

        const perf = rows.map((r) => LEVEL_SCORE[r.performance]);
        const pot = rows.map((r) => LEVEL_SCORE[r.potential]);
        const avgPerf = perf.reduce((a, b) => a + b, 0) / perf.length;
        const avgPot = pot.reduce((a, b) => a + b, 0) / pot.length;

        const perfLevel = classify(avgPerf);
        const potLevel = classify(avgPot);
        const box = `${potLevel}-${perfLevel}`;
        const tier = avgPerf + avgPot >= 5.0 ? 'up' : avgPerf + avgPot >= 3.0 ? 'mid' : 'low';

        // confidence = inverse of variance (rough)
        const variance = (a, m) => a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length;
        const v = (variance(perf, avgPerf) + variance(pot, avgPot)) / 2;
        const confidence = Math.max(0, Math.min(1, 1 - v / 2));

        await db.run(
            `INSERT INTO talent_placements (employee_id, cycle_id, box, tier, confidence, source, placed_at)
             VALUES (?, ?, ?, ?, ?, 'auto'::placement_source, now())
             ON CONFLICT (employee_id, cycle_id) DO UPDATE
                SET box = EXCLUDED.box, tier = EXCLUDED.tier,
                    confidence = EXCLUDED.confidence,
                    source = (CASE WHEN talent_placements.source = 'override'
                                  THEN 'override' ELSE 'auto' END)::placement_source,
                    placed_at = EXCLUDED.placed_at`,
            [employeeId, cycleId, box, tier, confidence]
        );
        return { box, tier, confidence };
    }

    static async override({ employeeId, cycleId, box, tier, reason, placedBy }) {
        if (!reason || reason.trim().length < 10) {
            throw new Error('override reason must be at least 10 characters');
        }
        await db.run(
            `INSERT INTO talent_placements (employee_id, cycle_id, box, tier, confidence, source, override_reason, placed_by)
             VALUES (?, ?, ?, ?, NULL, 'override', ?, ?)
             ON CONFLICT (employee_id, cycle_id) DO UPDATE
                SET box = EXCLUDED.box, tier = EXCLUDED.tier,
                    source = 'override', override_reason = EXCLUDED.override_reason,
                    placed_by = EXCLUDED.placed_by, placed_at = now()`,
            [employeeId, cycleId, box, tier, reason, placedBy]
        );
    }
}

module.exports = TalentService;
