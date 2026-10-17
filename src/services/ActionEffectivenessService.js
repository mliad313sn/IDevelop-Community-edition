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
        evidenceSource = 'observation',
    }) {
        // The skill an action develops: its own link, else its objective's (an
        // action added from the plan page may carry none of its own).
        const link = await ActionEffectivenessService.skillOfAction(actionId);
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
            const official =
                updateOfficial === true &&
                (ratingPre == null || postRating > ratingPre) &&
                assessedByAdminId != null;
            await ActionEffectivenessService._writeEffectiveness(actionId, {
                ratingPre,
                postRating,
                uplift,
                evidenceSource,
                official,
            });

            // Update the official skill assessment if post > pre — and only on
            // the word of someone with authority over the subject.
            if (
                updateOfficial === true &&
                (ratingPre == null || postRating > ratingPre) &&
                assessedByAdminId != null
            ) {
                await db.run(
                    `INSERT INTO skill_assessments (employee_id, skill_id, current_level, assessed_by, notes, validation)
                     VALUES (?, ?, ?, ?, 'auto: action close uplift', 'manager_validated')
                     ON CONFLICT (employee_id, skill_id) DO UPDATE
                        SET current_level = EXCLUDED.current_level,
                            assessed_by   = EXCLUDED.assessed_by,
                            assessed_at   = now(),
                            -- the note is what the history trigger classifies:
                            -- keeping the previous one filed an action uplift
                            -- under the earlier source
                            notes         = EXCLUDED.notes,
                            validation    = EXCLUDED.validation`,
                    [employeeId, link.skillId, postRating, assessedByAdminId]
                );
                officialUpdated = true;
                // assessment_history is captured automatically by the
                // trg_skill_assessment_history trigger on the change above.
            }

            await db.run(
                `UPDATE idp_actions SET status='completed', completed_at=now(),
                        started_at = COALESCE(started_at, now()), updated_at = now()
                  WHERE id = ?`,
                [actionId]
            );
        };
        if (actor && typeof db.withActor === 'function') await db.withActor(actor, work);
        else await work();

        return {
            ratingPre,
            ratingPost: postRating,
            uplift,
            officialUpdated,
            skillId: Number(link.skillId),
        };
    }

    /**
     * A level OBSERVED outside a plan action: a validated coaching on a skill.
     * The caller has established the authority and that the actor is not the
     * person. The level becomes official only when it is higher than the
     * current one or the skill was never assessed (the onActionClose rule); the
     * history trigger files it as an action uplift ('auto:' note), with the
     * real actor carried by db.withActor.
     */
    static async recordObservedLevel({ employeeId, skillId, level, actor, source = 'coaching' }) {
        const lv = Number(level);
        if (!Number.isInteger(lv) || lv < 0 || lv > 4) throw new Error('level must be 0-4');
        const src = EVIDENCE_SOURCES.includes(source) ? source : 'observation';
        const pre = await db.get(
            'SELECT current_level FROM skill_assessments WHERE employee_id = ? AND skill_id = ?',
            [Number(employeeId), Number(skillId)]
        );
        const ratingPre = pre && pre.currentLevel != null ? Number(pre.currentLevel) : null;
        let officialUpdated = false;
        if (ratingPre == null || lv > ratingPre) {
            const adminId = await ActionEffectivenessService.assessorAdminId(actor);
            if (adminId != null) {
                const work = () =>
                    db.run(
                        `INSERT INTO skill_assessments (employee_id, skill_id, current_level, assessed_by, notes, validation)
                         VALUES (?, ?, ?, ?, ?, 'manager_validated')
                         ON CONFLICT (employee_id, skill_id) DO UPDATE
                            SET current_level = EXCLUDED.current_level,
                                assessed_by   = EXCLUDED.assessed_by,
                                notes         = EXCLUDED.notes,
                                validation    = EXCLUDED.validation,
                                assessed_at   = now()`,
                        [
                            Number(employeeId),
                            Number(skillId),
                            lv,
                            adminId,
                            `auto: ${src} observed level`,
                        ]
                    );
                if (actor && typeof db.withActor === 'function') await db.withActor(actor, work);
                else await work();
                officialUpdated = true;
            }
        }
        return {
            ratingPre,
            ratingPost: lv,
            uplift: ratingPre == null ? null : lv - ratingPre,
            officialUpdated,
        };
    }

    /**
     * The admins(id) that skill_assessments.assessed_by (a NOT NULL foreign key
     * onto admins) can hold for this actor: their own admin account, else the
     * system account. The real actor is carried by db.withActor (history
     * trigger), the LmsService.decideUplift convention.
     */
    static async assessorAdminId(actor) {
        const { actorAdminId } = require('../utils/actorAdminId');
        const own = actor ? await actorAdminId(actor) : null;
        if (own != null) return Number(own);
        const sys = await db.get("SELECT id FROM admins WHERE username = 'admin'");
        return sys ? Number(sys.id) : null;
    }

    /**
     * The skill an action develops: its action_skill_links row, else the skill
     * of its objective. { skillId } or null (no skill: the action closes as
     * evidence only and no level is asked).
     */
    static async skillOfAction(actionId) {
        const row = await db.get(
            `SELECT COALESCE(
                    (SELECT l.skill_id FROM action_skill_links l
                      WHERE l.action_id = a.id ORDER BY l.skill_id LIMIT 1),
                    o.skill_id) AS skill_id
               FROM idp_actions a LEFT JOIN idp_objectives o ON o.id = a.objective_id
              WHERE a.id = ?`,
            [Number(actionId)]
        );
        return row && row.skillId != null ? { skillId: Number(row.skillId) } : null;
    }

    /** One action_effectiveness row, with its source and official flag (migration 191). */
    static async _writeEffectiveness(
        actionId,
        { ratingPre, postRating, uplift, evidenceSource, official }
    ) {
        const src = EVIDENCE_SOURCES.includes(evidenceSource) ? evidenceSource : 'observation';
        await db.run(
            `INSERT INTO action_effectiveness (action_id, rating_pre, rating_post, uplift, evidence_source, official)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (action_id) DO UPDATE
                SET rating_pre = EXCLUDED.rating_pre,
                    rating_post = EXCLUDED.rating_post,
                    uplift = EXCLUDED.uplift,
                    evidence_source = EXCLUDED.evidence_source,
                    official = EXCLUDED.official,
                    computed_at = now()`,
            [Number(actionId), ratingPre, postRating, uplift, src, Boolean(official)]
        );
    }
}

/** What produced an observed level (migration 191 CHECK). */
const EVIDENCE_SOURCES = Object.freeze(['observation', 'training', 'coaching']);
ActionEffectivenessService.EVIDENCE_SOURCES = EVIDENCE_SOURCES;

module.exports = ActionEffectivenessService;
