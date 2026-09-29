'use strict';

const db = require('../config/database');

class ActionEffectivenessService {
    /**
     *   onActionClose({ actionId, postRating, employeeId, actor, updateOfficial })
     *
     *   Reads the pre-rating from skill_assessments for the action's
     *   linked skill, persists rating_pre / rating_post / uplift.
     *   Idempotent (re-runs overwrite the row).
     *
     *   `updateOfficial` (default FALSE — fail closed): only when the caller has
     *   established that the actor is NOT the plan's subject and holds authority
     *   over them may the post-rating become the OFFICIAL level. Otherwise the
     *   rating is recorded as evidence in action_effectiveness only — a manager
     *   closing an action on their OWN plan used to raise their own official
     *   skill level (3.23.17, B-1).
     *
     *   Attribution: skill_assessments.assessed_by is a NOT NULL FK onto
     *   admins(id); a manager is an EMPLOYEE, so their id cannot go there (it
     *   either violated the FK or named an unrelated admin sharing the number).
     *   `assessedByAdminId` is the admins(id) the FK can hold, and the whole
     *   close runs under db.withActor(actor) so the history trigger records the
     *   real human.
     */
    static async onActionClose({
        actionId,
        postRating,
        employeeId,
        actor = null,
        assessedByAdminId = null,
        updateOfficial = false,
    }) {
        const link = await db.get(
            `SELECT skill_id FROM action_skill_links WHERE action_id = ? LIMIT 1`,
            [actionId]
        );
        if (!link) throw new Error('action has no linked skill');

        const pre = await db.get(
            `SELECT current_level FROM skill_assessments
             WHERE employee_id = ? AND skill_id = ?`,
            [employeeId, link.skillId]
        );
        // Never assessed = NOT MEASURED, never 0: a 0 turned the whole post-rating
        // into a fake "gain" (3.23.17, migration 148 allows NULL here).
        const ratingPre = pre && pre.currentLevel != null ? Number(pre.currentLevel) : null;
        const uplift = ratingPre == null ? null : postRating - ratingPre;

        let officialUpdated = false;
        const work = async () => {
            await db.run(
                `INSERT INTO action_effectiveness (action_id, rating_pre, rating_post, uplift)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT (action_id) DO UPDATE
                    SET rating_pre = EXCLUDED.rating_pre,
                        rating_post = EXCLUDED.rating_post,
                        uplift = EXCLUDED.uplift,
                        computed_at = now()`,
                [actionId, ratingPre, postRating, uplift]
            );

            // Update the official skill assessment if post > pre — and only on
            // the word of someone with authority over the subject.
            if (
                updateOfficial === true &&
                (ratingPre == null || postRating > ratingPre) &&
                assessedByAdminId != null
            ) {
                await db.run(
                    `INSERT INTO skill_assessments (employee_id, skill_id, current_level, assessed_by, notes)
                     VALUES (?, ?, ?, ?, 'auto: action close uplift')
                     ON CONFLICT (employee_id, skill_id) DO UPDATE
                        SET current_level = EXCLUDED.current_level,
                            assessed_by   = EXCLUDED.assessed_by,
                            assessed_at   = now()`,
                    [employeeId, link.skillId, postRating, assessedByAdminId]
                );
                officialUpdated = true;
                // assessment_history is captured automatically by the
                // trg_skill_assessment_history trigger on the change above.
            }

            await db.run(
                `UPDATE idp_actions SET status='completed', completed_at=now() WHERE id=?`,
                [actionId]
            );
        };
        if (actor && typeof db.withActor === 'function') await db.withActor(actor, work);
        else await work();

        return { ratingPre, ratingPost: postRating, uplift, officialUpdated };
    }
}

module.exports = ActionEffectivenessService;
