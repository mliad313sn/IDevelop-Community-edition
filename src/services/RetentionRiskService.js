'use strict';

/**
 * RetentionRiskService — computes a defensible "risk of loss" signal for an
 * employee from data the platform already holds (9-box placement, active
 * development, PIP state), and upserts it into `retention_risk`.
 *
 *   impact_of_loss  — how much it hurts to lose them (driven by 9-box).
 *   flight_risk     — how likely we are to lose them (stagnation / disengagement).
 *   computed_score  — 0..100 = impactScore (0..50) + flightScore (0..50).
 *
 * A manager override (`manual_override = true`) is respected: recompute records
 * the freshly-computed score in risk_factors._computed but never clobbers the
 * manually-set bands.
 */
const db = require('../config/database');

function bandFromFlight(score) {
    if (score >= 35) return 'high';
    if (score >= 18) return 'medium';
    return 'low';
}

class RetentionRiskService {
    /** Gather signals for one employee. Each probe is defensive. */
    async _signals(employeeId) {
        const factors = {};
        let impactScore = 0;
        let flightScore = 0;

        // Impact of loss — from the latest 9-box placement. Prefer the LIVE workflow
        // grid (nine_box_evaluations, approved) — the one /talent/nine-box writes; fall
        // back to the legacy V2 talent_placements table. Reading only talent_placements
        // gave impactScore=0 for every org that places via the workflow grid.
        try {
            let potential, performance;
            const nb = await db.get(
                `SELECT performance, potential FROM nine_box_evaluations
                  WHERE employee_id = ? AND status = 'approved'
                  ORDER BY COALESCE(approved_at, updated_at, created_at) DESC LIMIT 1`,
                [employeeId]
            );
            if (nb && nb.performance && nb.potential) {
                performance = String(nb.performance);
                potential = String(nb.potential);
            } else {
                const place = await db.get(
                    'SELECT box FROM talent_placements WHERE employee_id = ? ORDER BY cycle_id DESC LIMIT 1',
                    [employeeId]
                );
                if (place && place.box) [potential, performance] = String(place.box).split('-');
            }
            if (potential && performance) {
                factors.nineBox = `${potential}-${performance}`;
                if (potential === 'high' && performance === 'high') impactScore = 50;
                else if (potential === 'high' || performance === 'high') impactScore = 30;
                else if (potential === 'medium' || performance === 'medium') impactScore = 15;
                // High potential, stuck = classic flight risk.
                if (potential === 'high') flightScore += 20;
            }
        } catch (_) {
            /* placement optional */
        }

        // Stagnation — high-value person with no active development plan.
        try {
            const idp = await db.get(
                "SELECT id FROM idp_plans WHERE employee_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1",
                [employeeId]
            );
            factors.activeIdp = Boolean(idp);
            if (!idp && impactScore >= 30) flightScore += 15; // valued but not invested in
        } catch (_) {
            /* idp optional */
        }

        // Disengagement — an active PIP signals a strained relationship.
        try {
            const pip = await db.get(
                "SELECT id FROM pips WHERE employee_id = ? AND state = 'active' ORDER BY created_at DESC LIMIT 1",
                [employeeId]
            );
            if (pip) {
                factors.activePip = true;
                flightScore += 12;
            }
        } catch (_) {
            /* pip optional */
        }

        // Engagement (predictive) — low recent survey engagement is the leading
        // indicator of attrition. Avg of this person's 1-5 SCALE answers across
        // surveys of the last 180 days.
        //
        // Two rules, both about what may honestly be averaged:
        //  - only `scale` questions (1-5). NPS answers (0-10) used to be averaged
        //    into the same mean, so a 9/10 "would recommend" read as an
        //    off-the-chart 1-5 score and a 4/10 as "engaged";
        //  - only NON-anonymous surveys. An anonymous survey never feeds an
        //    individual risk score — by design its rows carry no employee_id,
        //    and naming the survey anonymous is a promise that answers are not
        //    traced back to the person. The explicit filter keeps that true
        //    even for rows written before the pseudonymous key existed.
        try {
            const eng = await db.get(
                `SELECT AVG(r.score) AS avg_eng
                 FROM survey_responses r
                 JOIN surveys s ON s.id = r.survey_id
                 JOIN survey_questions q ON q.id = r.question_id
                 WHERE r.employee_id = ? AND r.score IS NOT NULL
                   AND q.qtype = 'scale' AND s.anonymous = false
                   AND COALESCE(s.closed_at, s.opened_at, s.created_at) > now() - interval '180 days'`,
                [employeeId]
            );
            if (eng && eng.avgEng != null) {
                const e = Number(eng.avgEng);
                factors.engagement = Number(e.toFixed(2));
                if (e < 2.5) flightScore += 20;
                else if (e < 3.5) flightScore += 10;
            }
        } catch (_) {
            /* surveys optional */
        }

        impactScore = Math.min(50, impactScore);
        flightScore = Math.min(50, flightScore);

        // Impact of loss is derived ENTIRELY from a 9-box placement. With no
        // placement, impactScore is still its initialiser (0) and 0 bands as
        // 'low' — so somebody nobody has ever assessed was published with the
        // same verdict as a measured Concern: "low impact of loss", i.e.
        // losing them costs little. That is a statement about a person, made
        // from the fact that no statement exists. On the dev dataset it was 73 of 78
        // stored rows.
        //
        // factors.nineBox is set if and only if a placement was found, so it
        // is the honest test. Unmeasured impact makes the TOTAL unmeasured
        // too: impact + flight cannot be summed when one term is unknown.
        const impactMeasured = Object.prototype.hasOwnProperty.call(factors, 'nineBox');
        factors.impactMeasured = impactMeasured;

        // Flight risk has the same disease impact_of_loss had. flightScore is
        // additive-only, so 0 means "we found no flight signal" — but
        // bandFromFlight(0) is 'low', so somebody with no 9-box, no active PIP
        // and no recent survey answer was published as "low flight risk", a
        // reassuring verdict drawn from the absence of any signal (72 of 76
        // rows on the dev dataset). Flight is measured only when at least one
        // real input exists: a placement (which also feeds impact), an active
        // PIP, or a survey engagement score. Since a placement is required for
        // impact too, flightMeasured is a superset of impactMeasured — a person
        // can have a flight signal without a placement, never the reverse.
        const flightMeasured =
            factors.nineBox != null || factors.activePip === true || factors.engagement != null;
        factors.flightMeasured = flightMeasured;

        const impactBand = !impactMeasured
            ? null
            : impactScore >= 40
              ? 'high'
              : impactScore >= 20
                ? 'medium'
                : 'low';
        return {
            factors,
            impactScore: impactMeasured ? impactScore : null,
            flightScore: flightMeasured ? flightScore : null,
            impactBand,
            flightBand: flightMeasured ? bandFromFlight(flightScore) : null,
            // The blended score needs both terms; impact requires a placement,
            // which also makes flight measured, so this is null exactly when
            // impact is unmeasured.
            computedScore: impactMeasured ? impactScore + flightScore : null,
        };
    }

    /**
     * Recompute and upsert the retention-risk row for an employee.
     * @returns the resulting row (camelCase).
     */
    async computeFor(employeeId, ownerAdminId = null) {
        const s = await this._signals(employeeId);
        const factors = {
            ...s.factors,
            _computed: { flightScore: s.flightScore, impactScore: s.impactScore },
        };
        // Single atomic upsert (was a SELECT + 3 separate branches that raced on
        // concurrent calls for the same employee → primary-key violation). A
        // manual override keeps its bands; the computed trail always refreshes.
        return db.get(
            `INSERT INTO retention_risk
               (employee_id, flight_risk, impact_of_loss, computed_score, risk_factors, owner_admin_id, last_reviewed)
             VALUES (?, ?, ?, ?, ?, ?, now())
             ON CONFLICT (employee_id) DO UPDATE SET
               flight_risk = CASE WHEN retention_risk.manual_override THEN retention_risk.flight_risk ELSE EXCLUDED.flight_risk END,
               impact_of_loss = CASE WHEN retention_risk.manual_override THEN retention_risk.impact_of_loss ELSE EXCLUDED.impact_of_loss END,
               computed_score = EXCLUDED.computed_score,
               risk_factors = EXCLUDED.risk_factors,
               updated_at = now()
             RETURNING *`,
            [
                employeeId,
                s.flightBand,
                s.impactBand,
                s.computedScore,
                JSON.stringify(factors),
                ownerAdminId,
            ]
        );
    }

    /** Set/override the bands manually (manager judgement wins over the heuristic). */
    async setOverride(employeeId, { flightRisk, impactOfLoss, ownerAdminId = null } = {}) {
        // Single atomic upsert (matches computeFor) — the prior SELECT-then-
        // INSERT/UPDATE raced: two concurrent overrides both saw no row and both
        // INSERTed, and the second hit a unique violation. On conflict a null
        // incoming band still preserves the existing one (COALESCE against the row).
        //
        // The bands are the `risk_level` enum. A bare `?` inside COALESCE is typed
        // by its sibling ('low' is an unknown-literal, the row column is the enum)
        // and the parameter itself resolves to TEXT — so every call, existing row
        // or not, answered 42804 "column flight_risk is of type risk_level but
        // expression is of type text" and the manual override was dead. The cast
        // must sit on the PARAMETER, and lowercase: the compat layer rewrites
        // `CAST(x AS TEXT)` shapes, `?::risk_level` passes through unchanged.
        await db.run(
            `INSERT INTO retention_risk
               (employee_id, flight_risk, impact_of_loss, manual_override, owner_admin_id, last_reviewed, updated_at)
             VALUES (?, COALESCE(?::risk_level, 'low'), COALESCE(?::risk_level, 'low'), true, ?, now(), now())
             ON CONFLICT (employee_id) DO UPDATE SET
                 flight_risk = COALESCE(?::risk_level, retention_risk.flight_risk),
                 impact_of_loss = COALESCE(?::risk_level, retention_risk.impact_of_loss),
                 manual_override = true, last_reviewed = now(), updated_at = now()`,
            [
                employeeId,
                flightRisk || null,
                impactOfLoss || null,
                ownerAdminId,
                flightRisk || null,
                impactOfLoss || null,
            ]
        );
        return db.get('SELECT * FROM retention_risk WHERE employee_id = ?', [employeeId]);
    }
}

module.exports = new RetentionRiskService();
