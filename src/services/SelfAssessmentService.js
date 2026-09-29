const db = require('../config/database');
const SelfAssessmentModel = require('../models/SelfAssessmentModel');
const SupervisorReviewModel = require('../models/SupervisorReviewModel');
const EmployeeModel = require('../models/EmployeeModel');
const SkillAssessmentModel = require('../models/SkillAssessmentModel');
const LogService = require('./LogService');

class SelfAssessmentService {
    /**
     * @param {number|string|null} expectedCycleId  The campaign the caller believes
     *   it is writing into. Supplied by the OFFLINE replay, which may be posting
     *   work captured days earlier; omitted by the live page, which is by
     *   definition current. A mismatch is refused, never re-filed.
     */
    async createOrUpdateSelfAssessment(
        employeeId,
        skillId,
        selfRatedLevel,
        notes = null,
        expectedCycleId = null
    ) {
        // Validate inputs early so the employee gets a clear message, not a 500.
        skillId = Number(skillId);
        selfRatedLevel = Number(selfRatedLevel);
        if (!Number.isInteger(skillId) || skillId <= 0) throw new Error('Invalid skill reference.');
        if (!Number.isInteger(selfRatedLevel) || selfRatedLevel < 0 || selfRatedLevel > 4) {
            throw new Error('Each rating must be a whole number between 0 and 4.');
        }

        // ONE MEASUREMENT PER ROUND.
        // `self_assessments` is the view of the CURRENT round of each
        // (employee, skill); every round ever measured lives in
        // `self_assessment_rounds` (migration 113). Editing your own draft
        // updates the current round in place; being ASKED AGAIN by a new
        // campaign opens a NEW round and leaves the previous one exactly as it
        // was — level, notes, reviewer, dates and campaign all intact.
        // Stamp the currently OPEN campaign so per-cycle progression tracking
        // (v_employee_cycle_progress, migration 57) and the cycle-nudge job see
        // this work. Before this, only lifecycle-seeded drafts carried cycle_id
        // — organic self-assessments were invisible to campaign history.
        const activeCycle = await db.get(
            "SELECT id FROM assessment_cycles WHERE status = 'open' ORDER BY opened_at DESC LIMIT 1"
        );
        const cycleId = activeCycle ? activeCycle.id : null;

        // An OFFLINE draft carries the campaign it was captured in. The offline
        // replay used to send only {skillId, level, notes}, so the cycle was
        // re-resolved here at replay time: a draft written during campaign N and
        // replayed after N+1 opened was filed into N+1, against answers the
        // employee gave about a different period. Refuse rather than re-file, so
        // the client can say the campaign has closed instead of showing "synced".
        if (expectedCycleId != null && String(expectedCycleId) !== String(cycleId)) {
            return { skipped: true, reason: 'cycle_changed', expectedCycleId, cycleId };
        }

        // The view guarantees AT MOST ONE current round per (employee, skill)
        // (partial unique index uq_sa_current_round), so there is nothing to
        // de-duplicate here — and nothing to delete. The old code read every row
        // for the pair, kept the newest and DELETED the rest, which is both
        // unnecessary now and a breach of the house rule that nothing is erased.
        const current = await SelfAssessmentModel.findCurrentRound(employeeId, skillId);
        if (!current) {
            // First ever measurement of this competency for this person.
            return await SelfAssessmentModel.openRound({
                employeeId,
                skillId,
                selfRatedLevel,
                notes: notes || null,
                cycleId,
            });
        }
        const keepId = Number(current.id);

        // An assessment that has left the employee's hands is NOT re-openable by a
        // save. Without this guard the UPDATE below reset ANY state back to
        // 'draft' — so an employee returning to adjust one competency silently
        // un-approved it, while `supervisor_reviews` still read
        // completed/approve. Two records then disagreed about the same fact, with
        // nothing logged. Worse, the page posts EVERY rated skill on save
        // (data-answered is '1' for anything previously rated, approved included),
        // so a single "save draft" reverted the person's whole approved set and
        // regressed their campaign state — invisibly.
        //
        // Only the two states the workflow considers the employee's own are
        // editable. Anything else is left exactly as it is and reported back, so
        // the caller can tell the user rather than pretending the edit landed.
        const EDITABLE = ['draft', 'changes_requested'];
        const state = current.workflowState || current.status || 'draft';

        if (EDITABLE.includes(state)) {
            // Still the employee's own draft of the CURRENT round: edit in place.
            // A correction inside one round is not a new measurement.
            await db.run(
                `UPDATE self_assessments
                    SET self_rated_level = ?, notes = ?, status = 'draft', workflow_state = 'draft',
                        cycle_id = COALESCE(?, cycle_id), updated_at = now()
                  WHERE id = ?`,
                [selfRatedLevel, notes || null, cycleId, keepId]
            );
            return { id: keepId };
        }

        // BEING ASKED AGAIN. A new campaign re-opens a decided competency — the
        // person is being ASKED, so no request for change is needed (HR3-22).
        // What changes here: this no longer REWRITES the decided row. The
        // previous round keeps its level, its notes, its reviewer, its dates and
        // its campaign for ever; a NEW round is opened for the new campaign, and
        // it is the new round that becomes "the" current measurement.
        // A row whose review is under an OPEN dispute stays exactly as it is.
        const rowCycle = current.cycleId != null ? String(current.cycleId) : null;
        const askedAgain = cycleId != null && rowCycle !== String(cycleId);
        const disputed =
            askedAgain &&
            (await db.get(
                `SELECT 1 AS x FROM assessment_disputes d
               JOIN supervisor_reviews sr ON sr.id = d.supervisor_review_id
              WHERE sr.self_assessment_id = ? AND d.state IN ('open','escalated')`,
                [keepId]
            ));
        if (!askedAgain) return { id: keepId, skipped: true, state };
        if (disputed) return { id: keepId, skipped: true, state, reason: 'under_dispute' };

        const fromCycleId = current.cycleId != null ? Number(current.cycleId) : null;
        let opened;
        // Supersede + open + trail commit together: the partial unique index
        // allows exactly ONE current round per pair, so a half-applied change
        // would either lose the current measurement or refuse the new one.
        await db.runTransaction(async () => {
            await db.run(
                `UPDATE self_assessment_rounds SET superseded_at = now()
                  WHERE id = ? AND superseded_at IS NULL`,
                [keepId]
            );
            opened = await SelfAssessmentModel.openRound({
                employeeId,
                skillId,
                selfRatedLevel,
                notes: notes || null,
                cycleId,
            });
            await db.run('UPDATE self_assessment_rounds SET superseded_by = ? WHERE id = ?', [
                Number(opened.id),
                keepId,
            ]);
            // The handoff stays on the PREVIOUS round's trail, under the same
            // action name as before, so the employee's movement timeline reads
            // exactly as it did — with the new round's id added to the detail.
            await db.run(
                `INSERT INTO self_assessment_events (self_assessment_id, actor_id, actor_type, action, from_state, to_state, detail)
                 VALUES (?, ?, 'employee', 'reopen_new_cycle', ?, 'draft', ?)`,
                [
                    keepId,
                    employeeId,
                    state,
                    JSON.stringify({
                        fromCycleId,
                        toCycleId: Number(cycleId),
                        newAssessmentId: Number(opened.id),
                        round: Number(opened.roundNo ?? opened.round_no),
                    }),
                ]
            );
        });
        return {
            id: Number(opened.id),
            reopened: true,
            fromCycleId,
            cycleId,
            previousId: keepId,
            round: Number(opened.roundNo ?? opened.round_no),
        };
    }

    async submitSelfAssessment(employeeId, req = null) {
        let assessments;
        let reviews;
        // The whole submission is one unit: status advance, both state columns,
        // reviewer assignment and the per-skill supervisor_reviews rows must
        // commit together. A throw (no reviewer / nothing to submit) now rolls
        // the status advance back instead of leaving orphaned 'submitted' rows.
        await db.runTransaction(async () => {
            // Update all draft assessments to submitted
            await SelfAssessmentModel.submitAssessment(employeeId);

            // Keep the V2 workflow_state column in lockstep with the legacy `status`
            // column — otherwise the supervisor review queue (which reads
            // workflow_state) never sees these as submitted. (See the dual
            // state-machine gotcha.)
            await db.run(
                `UPDATE self_assessments
                 SET workflow_state = 'submitted', submitted_at = COALESCE(submitted_at, now()), updated_at = now()
                 WHERE employee_id = ? AND status = 'submitted'
                   AND (workflow_state IS NULL OR workflow_state IN ('draft', 'changes_requested'))`,
                [employeeId]
            );

            // Route the submission to the SUPERVISOR if one is set, otherwise to the
            // MANAGER (per the stakeholder rule: a self-assessment is simply sent to
            // the supervisor or the manager for approval). When the employee has
            // NEITHER, it still goes to 'submitted' and lands directly in the
            // review queue of the ADMIN in charge — the queue is RBAC-scope-driven
            // (super admin sees all; a scoped admin sees their people), so no
            // reviewer employee needs to be named. We skip the reviewer-bound rows
            // (current_reviewer_id / supervisor_reviews) in that case: both expect
            // an EMPLOYEE reviewer, and the employee's own reviews page INNER JOINs
            // supervisor_reviews.reviewed_by to employees — an admin id there would
            // corrupt it. The admin acts through the V2 workflow, which needs none.
            const employee = await EmployeeModel.findById(employeeId);
            if (!employee) throw new Error('Employee not found');
            // The reviewer must be an EMPLOYEE (both reviewer columns FK to
            // employees). A manager who is an ADMIN account is not an employee
            // reviewer — that employee's assessment also routes to the admin
            // queue, exactly like having no manager at all.
            const employeeManagerId =
                employee.managerType === 'employee' ? employee.managerId : null;
            const reviewerId = employee.supervisorId || employeeManagerId;

            // Get all submitted assessments
            assessments = await SelfAssessmentModel.findByEmployeeId(employeeId, 'submitted');
            if (!assessments.length) {
                throw new Error('Nothing to submit — please rate at least one skill first.');
            }

            // Record who the assessment is now WITH (employee → reviewer movement).
            // No supervisor/manager → leave current_reviewer_id NULL (the admin
            // queue does not key on it).
            if (reviewerId) {
                await db.run(
                    `UPDATE self_assessments SET current_reviewer_id = ?, updated_at = now()
                      WHERE employee_id = ? AND workflow_state = 'submitted'`,
                    [reviewerId, employeeId]
                );
            }
            // Log the submit handoff as a movement event (employee → reviewer, or
            // employee → admin queue when no reviewer is set).
            await db.run(
                `INSERT INTO self_assessment_events (self_assessment_id, actor_id, actor_type, action, from_state, to_state)
                 SELECT id, ?, 'employee', 'submit', 'draft', 'submitted'
                   FROM self_assessments WHERE employee_id = ? AND workflow_state = 'submitted'`,
                [employeeId, employeeId]
            );

            // Create/refresh ONE supervisor review per assessment ONLY when a
            // supervisor/manager exists. supervisor_reviews has
            // UNIQUE(self_assessment_id); re-submitting (e.g. after changes were
            // requested) must update the existing review back to 'pending' rather
            // than insert a duplicate (which would throw). With no reviewer we
            // create none — the admin approves via the V2 workflow directly.
            reviews = [];
            if (reviewerId) {
                for (const assessment of assessments) {
                    // A review nobody has performed yet carries NO supervisor
                    // rating, NO gap and NO review date. Seeding the employee's
                    // own rating with gap 0 made the page announce "Superviseur
                    // N / Ecart 0" under a green "d'accord" badge — and stamp a
                    // review date — before anyone had opened the assessment.
                    // On a re-submit after changes_requested the previous
                    // supervisor rating is cleared too: it judged an answer the
                    // employee has since changed.
                    const review = await db.get(
                        `INSERT INTO supervisor_reviews
                             (self_assessment_id, employee_id, skill_id, supervisor_rated_level, gap, reviewed_by, status)
                         VALUES (?, ?, ?, NULL, NULL, ?, 'pending')
                         ON CONFLICT (self_assessment_id) DO UPDATE
                             SET status = 'pending', reviewed_by = EXCLUDED.reviewed_by,
                                 supervisor_rated_level = NULL, gap = NULL, reviewed_at = NULL,
                                 decision = NULL, decided_at = NULL
                         RETURNING *`,
                        [assessment.id, assessment.employeeId, assessment.skillId, reviewerId]
                    );
                    reviews.push(review);
                }
            }
        });

        // Log the action
        if (req) {
            await LogService.log({
                adminId: req.user?.id,
                action: 'SELF_ASSESSMENT_SUBMITTED',
                entityType: 'selfAssessment',
                entityId: employeeId,
                details: `Employee ${employeeId} submitted ${assessments.length} self-assessments for supervisor review`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
        }

        // Accountability: the reviewer previously had NO trigger at submit time —
        // normal-cadence reviews were only caught by the cron escalation ≤3d before
        // close. Notify the reviewer now (in-app; category 'reviews' is email-off so
        // a campaign's many submits don't flood the inbox — the near-deadline cron
        // still escalates by email). The reviewer is an EMPLOYEE (managers are
        // employees); best-effort, never blocks the submit.
        try {
            const reviewerId =
                reviews && reviews.length
                    ? Number(reviews[0].reviewedBy ?? reviews[0].reviewed_by)
                    : null;
            if (reviewerId) {
                await require('./NotificationService')
                    .notify({
                        userType: 'employee',
                        userId: reviewerId,
                        kind: 'sa.submitted',
                        category: 'reviews',
                        payload: {
                            count: assessments.length,
                            link: '/supervisor/self-assessment-reviews',
                        },
                    })
                    .catch(() => {});
            }
        } catch (_) {
            /* never block submit on notification */
        }

        return { assessments, reviews };
    }

    /**
     * The gap is supervisor − self. NO MEASUREMENT, NO GAP.
     *
     * A round the employee never rated carries `self_rated_level = NULL`, and
     * `supervisorRatedLevel - null` is `supervisorRatedLevel` in JavaScript: an
     * unanswered competency validated at 3 was written as "Écart +3", i.e. an
     * absence of measurement rendered as a level 0 the employee never gave.
     * Same shape, same rule and same answer as the V2 path
     * (SelfAssessmentWorkflowService._finalizeSupervisorReview): the gap is
     * UNKNOWN — null — and the surfaces already print "—" for it.
     */
    async calculateGap(selfRatedLevel, supervisorRatedLevel) {
        if (selfRatedLevel === null || selfRatedLevel === undefined) return null;
        if (supervisorRatedLevel === null || supervisorRatedLevel === undefined) return null;
        return supervisorRatedLevel - selfRatedLevel;
    }

    async completeSupervisorReview(
        reviewId,
        supervisorRatedLevel,
        gapReason = null,
        supervisorNotes = null,
        req = null
    ) {
        const review = await SupervisorReviewModel.findById(reviewId);
        if (!review) {
            throw new Error('Review not found');
        }

        // THE ROUND THIS REVIEW JUDGED — read from `self_assessment_rounds`, not
        // from the `self_assessments` VIEW (migration 113 = the CURRENT round of
        // each (employee, skill)).
        //
        // `SelfAssessmentModel.findById` reads the view, so as soon as the person
        // was asked again by a new campaign this returned `undefined` and the very
        // next line dereferenced it:
        //     TypeError: Cannot read properties of undefined (reading 'selfRatedLevel')
        // which SupervisorReviewController turns into HTTP 500 "Could not complete
        // the review. Please try again." — an invitation to retry an operation that
        // could NEVER succeed. The review stayed 'pending' for ever: invisible in
        // the queue and impossible to decide. Reproduced on a development database:
        // round replaced while the review was open → 500, review still 'pending'.
        //
        // A review is a decision about ONE measurement. It is judged against the
        // level the employee actually submitted in THAT round, whether or not a
        // later round has since been opened.
        const selfAssessment = await db.get(
            `SELECT id, employee_id AS "employeeId", skill_id AS "skillId",
                    self_rated_level AS "selfRatedLevel", notes,
                    superseded_at AS "supersededAt"
               FROM self_assessment_rounds WHERE id = ?`,
            [review.selfAssessmentId]
        );
        // Still absent → say so in words. Never a TypeError, never a 500.
        if (!selfAssessment) {
            throw new Error('The self-assessment this review was raised on no longer exists.');
        }
        const gap = await this.calculateGap(selfAssessment.selfRatedLevel, supervisorRatedLevel);

        // Resolve BEFORE the transaction so a lookup cannot fail inside it.
        const assessorAdminId = await (async () => {
            const actor = req && req.user;
            if (actor && actor.userType === 'admin' && actor.id != null) return actor.id;
            const a = await db.get("SELECT id FROM admins WHERE username = 'admin'");
            return a ? a.id : null;
        })();

        // The review row, BOTH self-assessment state columns, and the optional
        // skill-assessment uplift must commit together — a partial failure here
        // previously left supervisor_reviews='completed' while the assessment
        // stayed in the review queue (dual state-machine desync).
        await db.runTransaction(async () => {
            await SupervisorReviewModel.update(reviewId, {
                supervisorRatedLevel,
                gap,
                gapReason: gapReason || null,
                supervisorNotes: supervisorNotes || null,
                status: 'completed',
                reviewedAt: new Date().toISOString(),
            });

            // Legacy `status` + V2 `workflow_state` MUST advance together — and
            // they must advance ON THE ROUND THAT WAS JUDGED.
            // `SelfAssessmentModel.update` writes through the `self_assessments`
            // VIEW: for a replaced round that UPDATE matched ZERO rows and said
            // nothing, so the review flipped to 'completed' while the measurement
            // it decided stayed 'submitted' for ever — the two records disagreeing
            // about the same fact, silently. A write that touches no row is not a
            // success: the `changes` check below turns it into a refusal.
            const advanced = await db.run(
                `UPDATE self_assessment_rounds
                    SET status = 'reviewed', workflow_state = 'reviewed',
                        reviewed_at = now(), reviewed_by = ?
                  WHERE id = ?`,
                [review.reviewedBy || null, review.selfAssessmentId]
            );
            if ((advanced.changes ?? advanced.rowCount ?? 0) === 0) {
                throw new Error(
                    'The self-assessment this review was raised on could not be updated.'
                );
            }

            // …and so must the AUDIT TRAIL. The V2 workflow writes a
            // self_assessment_events row for every transition; this V1 console
            // wrote none, so a review performed here left the assessment's history
            // with a gap exactly where the decision was taken. The employee's
            // timeline showed the state change with no actor and no moment, and a
            // dispute could not be reconstructed. Same shape as
            // SelfAssessmentWorkflowService._event.
            await db.run(
                `INSERT INTO self_assessment_events
                     (self_assessment_id, actor_id, actor_type, action, from_state, to_state, detail)
                 VALUES (?, ?, 'supervisor', 'review_completed', 'submitted', 'reviewed', ?)`,
                [
                    review.selfAssessmentId,
                    review.reviewedBy || null,
                    JSON.stringify({
                        supervisorRatedLevel,
                        gap,
                        via: 'v1_supervisor_console',
                        // Recorded so the trail says WHICH round was judged and
                        // whether it was still the person's current measurement.
                        supersededRound: selfAssessment.supersededAt != null,
                    }),
                ]
            );

            // Once a supervisor validates a level it becomes the employee's OFFICIAL
            // current level — always upsert, regardless of gap size. The old `gap >= 2`
            // gate meant a 1-level correction (e.g. supervisor 3 vs self 4) never reached
            // skill_assessments, so readiness/benchmark/9-box kept showing the un-validated
            // self-rating and disagreed with the review screen for the same skill.
            // `assessed_by` REFERENCES admins(id) while `supervisor_reviews
            // .reviewed_by` REFERENCES employees(id) — two different tables. Passing
            // the reviewer straight through therefore raised a foreign-key violation
            // for every reviewer who is not also an admin, which is ALL 132 of them
            // here, and the violation aborted the whole transaction: the review never
            // completed. Resolve an admin id the same way PipService does — the actor
            // when they are an admin, otherwise the system account — while
            // `supervisor_reviews.reviewed_by` keeps recording the real person.
            //
            // …but ONLY when the judged round is still the person's CURRENT
            // measurement. A replaced round is, by definition, no longer what the
            // organisation measures for that competency: a later round exists and
            // may already have been decided at another level. Promoting the older
            // decision would silently OVERWRITE the newer official level with a
            // stale one. The review is still closed and audited above — what is
            // withheld is only the promotion, and the trail says so.
            if (selfAssessment.supersededAt == null) {
                await SkillAssessmentModel.upsert({
                    employeeId: review.employeeId,
                    skillId: review.skillId,
                    currentLevel: supervisorRatedLevel,
                    assessedBy: assessorAdminId,
                    notes:
                        gap === null
                            ? // The employee never rated this round: there is no gap
                              // to state. Printing "Gap: null" — or worse, the
                              // supervisor's own level as if it were the difference —
                              // would assert something nobody measured.
                              'Validated by supervisor review (no self-rating on the assessed round).'
                            : gap === 0
                              ? 'Validated by supervisor review (confirmed self-rating).'
                              : `Validated by supervisor review. Gap: ${gap > 0 ? '+' : ''}${gap}`,
                });
            }
        });

        // Log the action
        if (req) {
            await LogService.log({
                adminId: req.user?.id,
                action: 'SUPERVISOR_REVIEW_COMPLETED',
                entityType: 'supervisorReview',
                entityId: reviewId,
                details:
                    `Review completed for employee ${review.employeeId}, skill ${review.skillId}. ` +
                    (gap === null
                        ? 'Gap: not measured (no self-rating on the assessed round)'
                        : `Gap: ${gap}`),
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
        }

        return await SupervisorReviewModel.findById(reviewId);
    }
}

module.exports = new SelfAssessmentService();
