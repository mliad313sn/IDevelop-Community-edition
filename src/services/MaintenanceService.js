'use strict';

/**
 * MaintenanceService — the SuperAdmin's way back out of a record raised in error.
 *
 * WHY THIS EXISTS SEPARATELY FROM CancellationService
 *   The normal cancellation path is deliberately two-person: a manager or admin
 *   REQUESTS, a different local admin DECIDES, and the requester can never be the
 *   approver. That is the right rule for cancelling a live plan that somebody is
 *   working through. It is the wrong rule for fixing data: an IDP attached to the
 *   wrong employee, a PIP opened on a duplicate record, a 9-box position approved
 *   from an assessment that was itself wrong. Those need one person with the
 *   authority to say "this should not exist", not a queue.
 *
 * SO THE BYPASS IS THE POINT — AND IT IS LABELLED, NEVER SILENT
 *   Every action here is SuperAdmin-only, requires a written reason, and lands in
 *   THREE places:
 *     - system_logs        : MAINT_* action, hash-chained and append-only;
 *     - the movement feed  : so "what happened to this person" reads correctly
 *                            next to their site/role/manager changes;
 *     - the entity's own trail (cancellation_requests / nine_box_events), marked
 *       as a maintenance override so an auditor can list every one of them.
 *   An auditor asking "where was the two-person rule skipped?" gets an answer
 *   from any of the three, independently.
 *
 * NOTHING IS DELETED. A cancellation is a state plus a reason. The plan, the
 * placement, the employee and all of their history stay queryable — which is
 * also what makes every action here reversible in principle and, for an employee
 * record, reversible in practice via `restoreEmployee`.
 */

const db = require('../config/database');
const LogService = require('./LogService');
const RBACService = require('./RBACService');
const { personNameOf } = require('../utils/personName');

/**
 * The plan types this panel can cancel, and where their state lives.
 * Deliberately NOT the full CancellationService.ENTITIES map: coaching and
 * mentoring plans keep the two-person queue, which nobody has asked to bypass.
 *
 * `terminal` is per-table and lists ONLY labels that exist in that column's
 * enum. Both state columns are PostgreSQL enums (`idp_status`, `pip_state`) with
 * DIFFERENT vocabularies — an IDP finishes 'completed', a PIP finishes
 * 'closed_success'. Comparing an enum column to a label outside its own type is
 * not an empty result, it is an error ("invalid input value for enum
 * pip_state"), so one shared terminal list would have made the panel's own
 * listing query throw on both tables.
 */
const PLANS = {
    idp: {
        table: 'idp_plans',
        stateCol: 'status',
        label: 'IDP',
        logAction: 'MAINT_CANCEL_IDP',
        terminal: ['completed', 'archived', 'cancelled'],
    },
    pip: {
        table: 'pips',
        stateCol: 'state',
        label: 'PIP',
        logAction: 'MAINT_CANCEL_PIP',
        terminal: ['closed_success', 'closed_failure', 'cancelled'],
    },
};

const OVERRIDE_NOTE = 'maintenance override — single-approver, two-person rule bypassed';

/** A refusal the route can show verbatim; anything else is a 500. */
function refuse(code) {
    const e = new Error(code);
    e.userMessage = code;
    e.status = 400;
    e.expose = true;
    return e;
}

/**
 * Every entry point starts here. SuperAdmin only — not `manage_mobility`, not a
 * role-shaped check: this bypasses a governance control, so it is gated on the
 * one identity that is accountable for the instance.
 */
function assertSuperAdmin(user) {
    if (!RBACService.isSuperAdmin(user)) throw refuse('maintenance_superadmin_only');
}

/** A cancellation without a stated reason is not auditable, so it is refused. */
function assertReason(reason) {
    const r = String(reason == null ? '' : reason).trim();
    if (!r) throw refuse('maintenance_reason_required');
    return r;
}

const MaintenanceService = {
    PLANS,
    OVERRIDE_NOTE,

    /** 'admin:5' — the tag the employee-movement trigger reads from its GUC. */
    _actorRef(user) {
        return `admin:${user.id}`;
    },

    /**
     * Set the actor tag the employee-movement trigger reads, from INSIDE the
     * transaction body.
     *
     * `runTransaction(fn, { actorRef })` only applies its option when it opens
     * the transaction: a nested call returns `fn` immediately and the option is
     * silently dropped. Measured — voiding an employee from inside an outer
     * transaction produced `actor_ref = null` on the status movement, i.e. an
     * audit row that says a record was voided but not by whom. Setting it here
     * makes the attribution independent of who opened the transaction.
     * Transaction-local (third arg true), so it cannot leak to the next request
     * on a pooled connection.
     */
    async _tagActor(user) {
        await db.run("SELECT set_config('app.actor_ref', ?, true)", [this._actorRef(user)]);
    },

    /**
     * Record the action on the movement feed. Best-effort by design: the feed is
     * a reading surface, and losing a feed row must never roll back the
     * cancellation the SuperAdmin actually asked for — system_logs is the
     * authoritative trail and is written separately.
     */
    async _movement(employeeId, kind, fromLabel, toLabel, user, note) {
        if (!employeeId) return;
        try {
            await db.run(
                `INSERT INTO employee_movements
                     (employee_id, kind, from_label, to_label, actor_ref, source, note)
                 VALUES (?, ?, ?, ?, ?, 'maintenance', ?)`,
                [employeeId, kind, fromLabel, toLabel, this._actorRef(user), note]
            );
        } catch (e) {
            console.error('[MaintenanceService] movement row failed:', e && e.message);
        }
    },

    async _audit(user, req, action, entityType, entityId, details) {
        try {
            await LogService.log({
                adminId: user.id,
                action,
                entityType,
                entityId,
                details,
                // A bypassed control is worth surfacing. 'warn', not 'warning':
                // this was the ONE writer of a second spelling, so its rows were
                // invisible to "Problèmes uniquement" and to the severity filter
                //.
                severity: 'warn',
                category: 'maintenance',
                actorRef: this._actorRef(user),
                requestId: req && req.id ? req.id : null,
                ipAddress: req && req.ip ? req.ip : null,
                userAgent: req && req.get ? req.get('user-agent') : null,
            });
        } catch (e) {
            console.error('[MaintenanceService] audit failed:', e && e.message);
        }
    },

    // -----------------------------------------------------------------------
    // IDP / PIP
    // -----------------------------------------------------------------------

    /**
     * Cancel an IDP or a PIP outright.
     *
     * The row written to `cancellation_requests` is what makes this visible from
     * the ordinary cancellations screen rather than only from the system log:
     * requester and approver are the same admin ON PURPOSE, and the decision note
     * says so. A reviewer scanning that queue sees the override in the same list
     * as the properly-reviewed ones instead of having to know to look elsewhere.
     */
    async cancelPlan(user, { entityType, entityId, reason }, req = null) {
        assertSuperAdmin(user);
        const why = assertReason(reason);
        const spec = PLANS[entityType];
        if (!spec) throw refuse('maintenance_unknown_plan_type');
        const id = Number(entityId);
        if (!Number.isInteger(id) || id <= 0) throw refuse('maintenance_invalid_id');

        const plan = await db.get(
            `SELECT id, employee_id AS "employeeId", ${spec.stateCol} AS "state"
               FROM ${spec.table} WHERE id = ?`,
            [id]
        );
        if (!plan) throw refuse('maintenance_plan_not_found');
        if (spec.terminal.includes(String(plan.state)))
            throw refuse('maintenance_plan_already_closed');

        const previous = String(plan.state);
        let supersededRequests = 0;
        let cascadedActions = 0;
        await db.runTransaction(
            async () => {
                await this._tagActor(user);
                await db.run(
                    `UPDATE ${spec.table} SET ${spec.stateCol} = 'cancelled', updated_at = now() WHERE id = ?`,
                    [id]
                );
                // A request already sitting in the two-person queue for this plan
                // must be closed here, not left behind. Measured: the queue held
                // [pending, approved] for one plan, the pending one stayed decidable
                // against an already-cancelled plan, and uq_cancel_one_pending then
                // blocked any future legitimate request. It is decided by the same
                // admin, with the same note — the override applies to it too.
                const sup = await db.run(
                    `UPDATE cancellation_requests
                    SET state = 'approved', decided_by_admin_id = ?, decided_at = now(),
                        decision_note = ?
                  WHERE entity_type = ? AND entity_id = ? AND state = 'pending'`,
                    [user.id, OVERRIDE_NOTE, entityType, id]
                );
                supersededRequests = Number((sup && sup.changes) || 0);
                // Same admin in both columns: that IS the override, recorded as such.
                await db.run(
                    `INSERT INTO cancellation_requests
                     (entity_type, entity_id, employee_id, reason, previous_state,
                      requested_by_admin_id, requested_at, state,
                      decided_by_admin_id, decided_at, decision_note)
                 VALUES (?, ?, ?, ?, ?, ?, now(), 'approved', ?, now(), ?)`,
                    [
                        entityType,
                        id,
                        plan.employeeId,
                        why,
                        previous,
                        user.id,
                        user.id,
                        OVERRIDE_NOTE,
                    ]
                );
                // A cancelled IDP must take its open work items with it. Measured:
                // the plan read 'cancelled' while its idp_actions stayed 'pending',
                // so the employee's Action Center kept listing work on a dead plan
                // and the org completion denominator kept counting it. ONE cascade
                // for both cancellation paths — the two-person queue's decide and
                // this override call the same CancellationService helper, so they
                // cannot drift. Savepointed so an unexpected column shape cannot
                // roll back the cancellation the SuperAdmin asked for.
                if (entityType === 'idp') {
                    try {
                        await db.runInSavepoint(async () => {
                            const c =
                                await require('./CancellationService').cascadePlanCancellation(
                                    entityType,
                                    id
                                );
                            cascadedActions =
                                Number((c && c.actions) || 0) + Number((c && c.objectives) || 0);
                        });
                    } catch (e) {
                        console.error(
                            '[MaintenanceService] idp cascade failed (plan still cancelled):',
                            e && e.message
                        );
                    }
                }
            },
            { actorRef: this._actorRef(user) }
        );

        await this._movement(
            plan.employeeId,
            'plan_cancelled',
            `${spec.label} ${previous}`,
            `${spec.label} cancelled`,
            user,
            why
        );
        await this._audit(
            user,
            req,
            spec.logAction,
            spec.table,
            id,
            `${spec.label} #${id} (employee ${plan.employeeId}) cancelled from '${previous}'` +
                (supersededRequests
                    ? `; ${supersededRequests} pending cancellation request(s) closed under the same override`
                    : '') +
                (cascadedActions
                    ? `; ${cascadedActions} open action(s)/objective(s) cancelled with it`
                    : '') +
                ` — ${OVERRIDE_NOTE}. Reason: ${why}`
        );

        return {
            ok: true,
            entityType,
            entityId: id,
            employeeId: plan.employeeId,
            previousState: previous,
            supersededRequests,
            cascadedActions,
        };
    },

    // -----------------------------------------------------------------------
    // 9-box position
    // -----------------------------------------------------------------------

    /**
     * Cancel a 9-box position.
     *
     * The position IS the approved `nine_box_evaluations` row (migration 95: "a
     * placement is what has been APPROVED"), so cancelling means moving that row
     * to 'archived' — the terminal state every reader already excludes, so the
     * grid, the roster badge, the employee dashboard and the Power BI feed all
     * drop it without a single reader change. The REASON and the fact that this
     * was a cancellation rather than a supersede live in `nine_box_events`, which
     * is where migration 95 already puts that kind of explanation.
     *
     * `talent_placements` holds the calibration write-back of the same position,
     * so it is cleared in the same transaction — its old box is copied into the
     * event detail first, because that table has no history of its own.
     */
    async cancelPlacement(user, { evaluationId, reason }, req = null) {
        assertSuperAdmin(user);
        const why = assertReason(reason);
        const id = Number(evaluationId);
        if (!Number.isInteger(id) || id <= 0) throw refuse('maintenance_invalid_id');

        const ev = await db.get(
            `SELECT id, employee_id AS "employeeId", cycle_id AS "cycleId",
                    status, box, box_label AS "boxLabel"
               FROM nine_box_evaluations WHERE id = ?`,
            [id]
        );
        if (!ev) throw refuse('maintenance_placement_not_found');
        if (ev.status === 'archived') throw refuse('maintenance_placement_already_archived');

        // The mirror row is resolved by the 9-box service, NOT matched on
        // cycle_id here. Committee finding (talent lot): every
        // nine_box_evaluations.cycle_id in the data is NULL while
        // talent_placements.cycle_id is NOT NULL, so a `cycle_id IS NOT DISTINCT
        // FROM` match never hit and this cancel silently left the calibration
        // write-back standing — the position vanished from the grid while DEI,
        // bias detection, the copilot, Report Builder and Power BI kept counting
        // it. _clearOrphanMirror takes the employee's LATEST mirror row, and only
        // once no approved evaluation remains, which is exactly the state this
        // archive produces; it returns the cleared row for the trail.
        let cleared = null;
        await db.runTransaction(
            async () => {
                await this._tagActor(user);
                await db.run(
                    "UPDATE nine_box_evaluations SET status = 'archived', updated_at = now() WHERE id = ?",
                    [id]
                );
                cleared = await require('./NineBoxService')._clearOrphanMirror(ev.employeeId);
                await db.run(
                    `INSERT INTO nine_box_events
                     (evaluation_id, employee_id, actor_id, actor_type, action,
                      from_status, to_status, detail)
                 VALUES (?, ?, ?, 'admin', 'cancel', ?, 'archived', ?)`,
                    [
                        id,
                        ev.employeeId,
                        user.id,
                        ev.status,
                        JSON.stringify({
                            reason: why,
                            maintenance: true,
                            note: OVERRIDE_NOTE,
                            box: ev.box,
                            boxLabel: ev.boxLabel,
                            // Copied out because talent_placements keeps no history.
                            clearedPlacement: cleared,
                        }),
                    ]
                );
            },
            { actorRef: this._actorRef(user) }
        );
        const placement = cleared;

        await this._movement(
            ev.employeeId,
            'placement_cancelled',
            ev.boxLabel || (ev.box != null ? `Box ${ev.box}` : 'placement'),
            'cancelled',
            user,
            why
        );
        await this._audit(
            user,
            req,
            'MAINT_CANCEL_NINEBOX',
            'nine_box_evaluations',
            id,
            `9-box placement #${id} (employee ${ev.employeeId}, box ${ev.box}) cancelled from '${ev.status}'` +
                `${placement ? ' incl. calibration write-back' : ''} — ${OVERRIDE_NOTE}. Reason: ${why}`
        );

        return {
            ok: true,
            evaluationId: id,
            employeeId: ev.employeeId,
            previousStatus: ev.status,
            box: ev.box,
            clearedPlacement: Boolean(placement),
        };
    },

    // -----------------------------------------------------------------------
    // Assessment
    // -----------------------------------------------------------------------

    /**
     * Cancel a self-assessment raised in error.
     *
     * WHY IT BECOMES 'rejected' AND NOT 'cancelled'
     *   Both state columns are constrained (`chk_sa_workflow_state`, and `status`
     *   is the `self_assessment_state` enum) and neither has a 'cancelled' value.
     *   Adding one looks tidy and is a trap: three readers filter NEGATIVELY
     *   (`workflow_state <> 'rejected'` in IDPService, `<> 'draft'` in the review
     *   queue, `NOT IN ('draft','changes_requested')` in the department
     *   completion percentage), so a new state would silently keep counting in
     *   IDP generation, the review queue and the analytics denominator. Reusing
     *   'rejected' — the terminal state they all already exclude — makes the
     *   cancellation correct in every reader without touching one of them. Same
     *   reasoning as archiving a cancelled 9-box position.
     *
     * WHAT IT DELIBERATELY DOES NOT TOUCH
     *   The OFFICIAL skill profile (`skill_assessments`). A person's level can
     *   come from a dispute resolution, an import or a manager, not only from
     *   this assessment, and `assessment_history` does not link promotions back
     *   to the self-assessment that caused them (`self_assessment_id` is unset on
     *   every row measured). Rewriting the profile on a guess would corrupt
     *   readiness, gaps, benchmark and the 9-box invisibly. So the official
     *   rating is REPORTED, never silently rewritten — the returned
     *   `officialRating` tells the caller what is still standing, and the audit
     *   line records it.
     */
    async cancelAssessment(user, { assessmentId, reason }, req = null) {
        assertSuperAdmin(user);
        const why = assertReason(reason);
        const id = Number(assessmentId);
        if (!Number.isInteger(id) || id <= 0) throw refuse('maintenance_invalid_id');

        const sa = await db.get(
            `SELECT sa.id, sa.employee_id AS "employeeId", sa.skill_id AS "skillId",
                    sa.status::text AS "status", sa.workflow_state AS "workflowState",
                    sa.self_rated_level AS "selfLevel", s.name AS "skillName"
               FROM self_assessments sa
               LEFT JOIN skills s ON s.id = sa.skill_id
              WHERE sa.id = ?`,
            [id]
        );
        if (!sa) throw refuse('maintenance_assessment_not_found');
        if (sa.status === 'rejected') throw refuse('maintenance_assessment_already_cancelled');

        // UNIQUE (employee_id, skill_id, status): if this person already has a
        // rejected assessment for this skill, the UPDATE would raise 23505.
        // Checked up front so the caller gets a sentence instead of a constraint.
        const clash = await db.get(
            `SELECT id FROM self_assessments
              WHERE employee_id = ? AND skill_id = ? AND status = 'rejected' AND id <> ?
              LIMIT 1`,
            [sa.employeeId, sa.skillId, id]
        );
        if (clash) throw refuse('maintenance_assessment_slot_taken');

        // What the official profile currently says, and where it came from. Read
        // only — see the note above.
        const official = await db.get(
            `SELECT current_level AS "level", assessed_by AS "assessedBy", notes
               FROM skill_assessments WHERE employee_id = ? AND skill_id = ?`,
            [sa.employeeId, sa.skillId]
        );

        const previous = sa.workflowState || sa.status;
        try {
            await db.runTransaction(
                async () => {
                    await this._tagActor(user);
                    await db.run(
                        `UPDATE self_assessments
                        SET status = 'rejected', workflow_state = 'rejected', updated_at = now()
                      WHERE id = ?`,
                        [id]
                    );
                },
                { actorRef: this._actorRef(user) }
            );
        } catch (e) {
            // Belt and braces: another writer could have taken the slot between
            // the check above and the UPDATE.
            if (e && e.code === '23505') throw refuse('maintenance_assessment_slot_taken');
            throw e;
        }

        await this._movement(
            sa.employeeId,
            'assessment_cancelled',
            `${sa.skillName || 'skill ' + sa.skillId} ${previous}`,
            'cancelled',
            user,
            why
        );
        await this._audit(
            user,
            req,
            'MAINT_CANCEL_ASSESSMENT',
            'self_assessments',
            id,
            `Self-assessment #${id} (employee ${sa.employeeId}, skill "${sa.skillName || sa.skillId}",` +
                ` self-rated ${sa.selfLevel}) cancelled from '${previous}' — ${OVERRIDE_NOTE}.` +
                ` Official skill profile left UNCHANGED` +
                `${official ? ` (still level ${official.level})` : ' (no official rating on file)'}.` +
                ` Reason: ${why}`
        );

        return {
            ok: true,
            assessmentId: id,
            employeeId: sa.employeeId,
            skillId: sa.skillId,
            previousState: previous,
            // So the caller can decide what to do about the profile, if anything.
            officialRating: official ? { level: official.level, notes: official.notes } : null,
        };
    },

    /**
     * Reopen an APPROVED self-assessment for changes.
     *
     * Once approved, an assessment is locked to everyone — the approve guard
     * exists so a stale "request changes" can never pull an approved rating
     * back to the employee. The SuperAdmin is the one exception, for the
     * maintenance case (approved on a wrong reading, approved for the wrong
     * person): the assessment goes back to the employee as `changes_requested`,
     * the approval stamp and the finalised lock are lifted, the supervisor's
     * review reopens — and the OFFICIAL skill level that was promoted stays
     * exactly as it is until the re-approval replaces it. Rewriting the profile
     * on a reopen would present a level nobody has decided yet.
     *
     * Delegates to SelfAssessmentWorkflowService.requestChanges, which owns the
     * dual state machine, the event trail (`reopen_after_approval`) and the
     * audit action (SA_REOPENED_AFTER_APPROVAL); this wrapper adds the panel's
     * own guarantees (SuperAdmin re-check, mandatory reason, movement row).
     */
    async reopenAssessment(user, { assessmentId, reason }, req = null) {
        assertSuperAdmin(user);
        const why = assertReason(reason);
        const id = Number(assessmentId);
        if (!Number.isInteger(id) || id <= 0) throw refuse('maintenance_invalid_id');

        const sa = await db.get(
            `SELECT sa.id, sa.employee_id AS "employeeId", sa.workflow_state AS "workflowState",
                    sa.cycle_id AS "cycleId", s.name AS "skillName"
               FROM self_assessments sa LEFT JOIN skills s ON s.id = sa.skill_id
              WHERE sa.id = ?`,
            [id]
        );
        if (!sa) throw refuse('maintenance_assessment_not_found');
        if (sa.workflowState !== 'approved') throw refuse('maintenance_assessment_not_approved');
        // ---- la porte de campagne (A5 / HR3-02, lot 5 §3) ----
        // Une campagne fermée ou verrouillée refuse TOUTE écriture, la dérogation
        // de maintenance comprise : rouvrir une évaluation d'un résultat publié
        // réécrirait une performance déjà rapportée. `allowReview: false` — une
        // réouverture rend le dossier à l'employé, ce n'est pas finir une revue.
        // Le refus nomme la campagne et sa date. `cycle_id NULL` = hors campagne,
        // toujours autorisé. La seule façon de rouvrir la campagne reste
        // `CycleService.reopenClosed` (SuperAdmin, 30 jours, tracée en dérogation).
        //
        // ---- UN REFUS N'EST PAS UNE PANNE ----
        // L'erreur de la porte (`CycleService._gateError`) porte `code`, `gate` et
        // une phrase déjà rédigée, mais AUCUN `status` : `asyncHandler.domainRefusal`
        // exige un 4xx, et sans lui ce refus légitime sortait en **500**, corps sans
        // `ok` ni `code` — et déposait une ligne `REQUEST_ERROR`/severity `error` dans
        // `system_logs`, table en ajout seul : un faux incident permanent à chaque
        // refus. On timbre donc le statut que le produit s'est lui-même fixé pour
        // CETTE erreur, exactement comme `CycleController.fail` (`cycle_write_*` →
        // 409) et `SelfAssessmentWorkflowService._assertCycleWritable` (`e.status =
        // 409; e.expose = true`). La PHRASE n'est pas retouchée : elle nomme déjà la
        // campagne et sa date, dans la langue de la session (`t` ci-dessus).
        try {
            await require('./CycleService').assertCycleWritable(sa.cycleId, {
                allowReview: false,
                t: req && req.t,
            });
        } catch (e) {
            if (e && e.gate) {
                e.status = 409;
                e.expose = true;
            }
            throw e;
        }
        // ---- ---

        const WF = require('./SelfAssessmentWorkflowService');
        await db.runTransaction(
            async () => {
                await this._tagActor(user);
                await WF.requestChanges(id, user, why, req);
            },
            { actorRef: this._actorRef(user) }
        );

        await this._movement(
            sa.employeeId,
            'assessment_cancelled',
            `${sa.skillName || 'skill'} approved`,
            'reopened for changes',
            user,
            why
        );
        await this._audit(
            user,
            req,
            'MAINT_REOPEN_ASSESSMENT',
            'self_assessments',
            id,
            `Approved self-assessment #${id} (employee ${sa.employeeId}, skill "${sa.skillName || '?'}") reopened for changes` +
                ` — ${OVERRIDE_NOTE}. Official skill level left as promoted until re-approval. Reason: ${why}`
        );

        return {
            ok: true,
            assessmentId: id,
            employeeId: sa.employeeId,
            newState: 'changes_requested',
        };
    },

    /**
     * Withdraw the supervisor's REVIEW of a self-assessment ("remove a review").
     *
     * The third assessment action, for the case between the other two: the
     * assessment itself is fine (so not Cancel), nobody has approved it yet (so
     * not Reopen), but the review on it is wrong — opened, sent back or rated
     * by the wrong person, or on a wrong reading. The file goes back to
     * 'submitted' as the employee filed it and re-enters the reviewer's queue;
     * the review row returns to pending with its decision cleared. The
     * employee's own rating and the official skill profile are untouched.
     *
     * SelfAssessmentWorkflowService.withdrawReview owns the state machine, the
     * event (`review_withdrawn`, carrying the withdrawn decision) and the audit
     * action; this wrapper adds the panel's guarantees (SuperAdmin re-check,
     * mandatory reason, the UNIQUE pre-check, movement row) and turns each
     * refusal into a sentence.
     */
    async withdrawReview(user, { assessmentId, reason }, req = null) {
        assertSuperAdmin(user);
        const why = assertReason(reason);
        const id = Number(assessmentId);
        if (!Number.isInteger(id) || id <= 0) throw refuse('maintenance_invalid_id');

        const sa = await db.get(
            `SELECT sa.id, sa.employee_id AS "employeeId", sa.skill_id AS "skillId",
                    sa.workflow_state AS "workflowState", s.name AS "skillName"
               FROM self_assessments sa LEFT JOIN skills s ON s.id = sa.skill_id
              WHERE sa.id = ?`,
            [id]
        );
        if (!sa) throw refuse('maintenance_assessment_not_found');
        if (sa.workflowState === 'approved') throw refuse('maintenance_review_use_reopen');
        if (sa.workflowState === 'arbitration') throw refuse('maintenance_review_in_arbitration');
        if (!['under_review', 'changes_requested', 'reviewed'].includes(sa.workflowState)) {
            throw refuse('maintenance_review_none');
        }

        // UNIQUE (employee_id, skill_id, status): going back to 'submitted' would
        // raise 23505 if another submitted assessment exists for this skill.
        const clash = await db.get(
            `SELECT id FROM self_assessments
              WHERE employee_id = ? AND skill_id = ? AND status = 'submitted' AND id <> ?
              LIMIT 1`,
            [sa.employeeId, sa.skillId, id]
        );
        if (clash) throw refuse('maintenance_review_slot_taken');

        const WF = require('./SelfAssessmentWorkflowService');
        try {
            await db.runTransaction(
                async () => {
                    await this._tagActor(user);
                    await WF.withdrawReview(id, user, why, req);
                },
                { actorRef: this._actorRef(user) }
            );
        } catch (e) {
            if (e && e.code === '23505') throw refuse('maintenance_review_slot_taken');
            if (e && e.code === 'REVIEW_DISPUTED') throw refuse('maintenance_review_disputed');
            if (e && e.code === 'STALE_STATE') throw refuse('maintenance_review_none');
            throw e;
        }

        await this._movement(
            sa.employeeId,
            'assessment_cancelled',
            `${sa.skillName || 'skill'} ${sa.workflowState}`,
            'review withdrawn',
            user,
            why
        );
        await this._audit(
            user,
            req,
            'MAINT_WITHDRAW_REVIEW',
            'self_assessments',
            id,
            `Supervisor review of self-assessment #${id} (employee ${sa.employeeId}, skill "${sa.skillName || sa.skillId}")` +
                ` withdrawn from '${sa.workflowState}' — back to 'submitted' for a fresh review — ${OVERRIDE_NOTE}.` +
                ` Employee's own rating untouched; official skill profile UNCHANGED. Reason: ${why}`
        );

        return {
            ok: true,
            assessmentId: id,
            employeeId: sa.employeeId,
            previousState: sa.workflowState,
            newState: 'submitted',
        };
    },

    // -----------------------------------------------------------------------
    // Employee record
    // -----------------------------------------------------------------------

    /**
     * Void an employee RECORD as created-in-error.
     *
     * This is not offboarding. A leaver is `is_active = false` and nothing else;
     * a voided record is `is_active = false` PLUS cancelled_at/by/reason, so the
     * two can never be confused by a later reader — which matters because the
     * headcount, the readiness denominators and the coverage stats all key off
     * is_active, and "somebody left" and "this person was entered twice" are
     * different facts about the same flag.
     *
     * Deliberately NOT an erase: DSRService.erase exists for the GDPR case, is
     * irreversible, and must stay a separate, deliberate act — not one click away
     * behind a button labelled "cancel".
     *
     * The 'status' movement row is written by the database trigger on is_active,
     * which is why the UPDATE runs inside a transaction tagged with actorRef:
     * without the tag the feed would attribute the void to nobody.
     */
    async voidEmployee(user, { employeeId, reason }, req = null) {
        assertSuperAdmin(user);
        const why = assertReason(reason);
        const id = Number(employeeId);
        if (!Number.isInteger(id) || id <= 0) throw refuse('maintenance_invalid_id');

        const emp = await db.get(
            `SELECT id, first_name AS "firstName", last_name AS "lastName",
                    is_active AS "isActive", cancelled_at AS "cancelledAt"
               FROM employees WHERE id = ?`,
            [id]
        );
        if (!emp) throw refuse('maintenance_employee_not_found');
        if (emp.cancelledAt) throw refuse('maintenance_employee_already_void');

        // A void must not orphan a team. Measured: voiding a supervisor left 15
        // active people reporting to a record that cannot log in, and the
        // governance-gap worklist could not see them because it only matches a
        // NULL supervisor, not an inactive one. Reassign first; the refusal
        // names the count so the SuperAdmin knows what to move.
        const reports = await db.get(
            `SELECT COUNT(*)::int AS n FROM employees
              WHERE is_active = true AND cancelled_at IS NULL AND id <> ?
                AND (supervisor_id = ? OR (manager_id = ? AND manager_type = 'employee'))`,
            [id, id, id]
        );
        if (reports && reports.n > 0) {
            const e = refuse('maintenance_employee_has_reports');
            e.count = reports.n;
            throw e;
        }

        // A voided record is NOT a leaver — but it must lose access at least as
        // completely as one. Measured: the first version flipped is_active only,
        // and the person's old password still authenticated, stamped
        // last_login_at and wrote EMPLOYEE_LOGIN_SUCCESS for a record that
        // officially never existed; a linked admin account and its API keys kept
        // working. This mirrors LifecycleService.onLeaver's cascade step for step.
        const revoked = { sessions: false, adminIds: [], apiKeyIds: [] };
        await db.runTransaction(
            async () => {
                await this._tagActor(user);
                await db.run(
                    `UPDATE employees
                    SET is_active = false, is_account_active = false,
                        cancelled_at = now(), cancelled_by = ?,
                        cancel_reason = ?, updated_at = now()
                  WHERE id = ?`,
                    [user.id, why, id]
                );
                const linked = await db.all(
                    'SELECT id FROM admins WHERE linked_employee_id = ? AND is_active = true',
                    [id]
                );
                for (const a of linked) {
                    const keys = await db.all(
                        'SELECT id FROM api_keys WHERE owner_admin_id = ? AND revoked_at IS NULL',
                        [a.id]
                    );
                    await db.run(
                        'UPDATE api_keys SET revoked_at = now() WHERE owner_admin_id = ? AND revoked_at IS NULL',
                        [a.id]
                    );
                    await db.run('UPDATE admins SET is_active = false WHERE id = ?', [a.id]);
                    revoked.adminIds.push(Number(a.id));
                    for (const k of keys) revoked.apiKeyIds.push(Number(k.id));
                }
            },
            { actorRef: this._actorRef(user) }
        );
        // Session revoke is outside the transaction and best-effort, exactly as
        // onLeaver does it: the deserialize gate on is_account_active is the
        // backstop, and a store hiccup must never undo the void itself.
        try {
            const SessionService = require('./SessionService');
            await SessionService.revokeAllForUser(id, 'employee');
            await SessionService.revokeAllForUser(id, 'manager');
            for (const aid of revoked.adminIds) await SessionService.revokeAllForUser(aid, 'admin');
            revoked.sessions = true;
        } catch (_) {
            /* best-effort */
        }

        // Always written, whether or not the trigger also fired. Measured: for an
        // ACTIVE record the trigger's row read "status active → inactive, source
        // db, note null" — byte-identical to an ordinary leaver — so nothing in
        // the feed said this record should never have existed, which is the one
        // thing this feature exists to record.
        await this._movement(
            id,
            'status',
            emp.isActive ? 'Active' : 'Inactive',
            'Cancelled (record voided)',
            user,
            why
        );
        await this._audit(
            user,
            req,
            'MAINT_VOID_EMPLOYEE',
            'employees',
            id,
            `Employee #${id} (${personNameOf(emp)}) record voided as created-in-error` +
                ` (was ${emp.isActive ? 'active' : 'inactive'}); login disabled, sessions revoked` +
                (revoked.adminIds.length
                    ? `, linked admin(s) ${revoked.adminIds.join(',')} deactivated, ${revoked.apiKeyIds.length} API key(s) revoked`
                    : '') +
                `. Reason: ${why}`
        );

        return {
            ok: true,
            employeeId: id,
            wasActive: emp.isActive === true,
            loginDisabled: true,
            sessionsRevoked: revoked.sessions,
            linkedAdminsDeactivated: revoked.adminIds,
            apiKeysRevoked: revoked.apiKeyIds,
        };
    },

    /**
     * Undo a void. The record comes back inactive, never straight to active: the
     * SuperAdmin who un-voids it decides separately whether the person belongs in
     * the headcount, and that second decision gets its own movement row from the
     * trigger. Restoring silently to active would resurrect somebody into every
     * denominator on the strength of one click.
     */
    async restoreEmployee(user, { employeeId, reason }, req = null) {
        assertSuperAdmin(user);
        const why = assertReason(reason);
        const id = Number(employeeId);
        if (!Number.isInteger(id) || id <= 0) throw refuse('maintenance_invalid_id');

        const emp = await db.get(
            `SELECT id, first_name AS "firstName", last_name AS "lastName",
                    cancelled_at AS "cancelledAt", cancel_reason AS "cancelReason"
               FROM employees WHERE id = ?`,
            [id]
        );
        if (!emp) throw refuse('maintenance_employee_not_found');
        if (!emp.cancelledAt) throw refuse('maintenance_employee_not_void');

        await db.runTransaction(
            async () => {
                await this._tagActor(user);
                await db.run(
                    `UPDATE employees
                    SET cancelled_at = NULL, cancelled_by = NULL, cancel_reason = NULL,
                        updated_at = now()
                  WHERE id = ?`,
                    [id]
                );
            },
            { actorRef: this._actorRef(user) }
        );

        await this._movement(id, 'status', 'Cancelled (record voided)', 'Inactive', user, why);
        await this._audit(
            user,
            req,
            'MAINT_RESTORE_EMPLOYEE',
            'employees',
            id,
            `Employee #${id} (${personNameOf(emp)}) void reversed; record stays INACTIVE.` +
                ` Original void reason: ${emp.cancelReason}. Restore reason: ${why}`
        );

        return { ok: true, employeeId: id, stillInactive: true };
    },

    // -----------------------------------------------------------------------
    // Reverse of a maintenance cancel — plans and placements only.
    // An assessment cancelled here lands in 'rejected' and must be re-submitted
    // by the employee (documented, not automated: a rating nobody re-approved
    // must not reappear as approved).
    // -----------------------------------------------------------------------

    /**
     * Put a plan cancelled BY THIS PANEL back into the state it had. The
     * previous state is read from the override row this panel wrote to
     * cancellation_requests (`decision_note = OVERRIDE_NOTE`); a plan cancelled
     * through the ordinary two-person queue has no such row and is refused —
     * undoing a properly reviewed decision is not maintenance.
     * Objectives/actions cancelled with an IDP stay cancelled (their own
     * history says why); the audit line states it.
     */
    async restorePlan(user, { entityType, entityId, reason }, req = null) {
        assertSuperAdmin(user);
        const why = assertReason(reason);
        const spec = PLANS[entityType];
        if (!spec) throw refuse('maintenance_unknown_plan_type');
        const id = Number(entityId);
        if (!Number.isInteger(id) || id <= 0) throw refuse('maintenance_invalid_id');

        const plan = await db.get(
            `SELECT id, employee_id AS "employeeId", ${spec.stateCol}::text AS "state"
               FROM ${spec.table} WHERE id = ?`,
            [id]
        );
        if (!plan) throw refuse('maintenance_plan_not_found');
        if (plan.state !== 'cancelled') throw refuse('maintenance_restore_not_cancelled');
        const override = await db.get(
            `SELECT previous_state AS "previousState" FROM cancellation_requests
              WHERE entity_type = ? AND entity_id = ? AND decision_note = ? AND state = 'approved'
              ORDER BY decided_at DESC NULLS LAST, id DESC LIMIT 1`,
            [entityType, id, OVERRIDE_NOTE]
        );
        if (!override || !override.previousState) throw refuse('maintenance_restore_no_override');
        const previous = String(override.previousState);
        if (previous === 'cancelled' || spec.terminal.includes(previous))
            throw refuse('maintenance_restore_no_override');

        await db.runTransaction(
            async () => {
                await this._tagActor(user);
                await db.run(
                    `UPDATE ${spec.table} SET ${spec.stateCol} = ?::${spec.table === 'pips' ? 'pip_state' : 'idp_status'}, updated_at = now() WHERE id = ?`,
                    [previous, id]
                );
            },
            { actorRef: this._actorRef(user) }
        );

        await this._movement(
            plan.employeeId,
            'plan_cancelled',
            `${spec.label} cancelled`,
            `${spec.label} ${previous} (restored)`,
            user,
            why
        );
        await this._audit(
            user,
            req,
            `MAINT_RESTORE_${spec.label}`,
            spec.table,
            id,
            `${spec.label} #${id} (employee ${plan.employeeId}) restored from 'cancelled' to '${previous}'` +
                (entityType === 'idp'
                    ? '; objectives/actions cancelled with it are NOT reopened'
                    : '') +
                ` — ${OVERRIDE_NOTE}. Reason: ${why}`
        );
        return {
            ok: true,
            entityType,
            entityId: id,
            employeeId: plan.employeeId,
            restoredState: previous,
        };
    },

    /**
     * Put a 9-box position archived BY THIS PANEL back to its former status.
     * The former status and the calibration mirror that was cleared with it are
     * both in the `cancel` event this panel wrote (nine_box_events.detail with
     * maintenance=true). Refused when the person has since gained another
     * approved position (uq_ninebox_approved_per_employee: one approval per person).
     */
    async restorePlacement(user, { evaluationId, reason }, req = null) {
        assertSuperAdmin(user);
        const why = assertReason(reason);
        const id = Number(evaluationId);
        if (!Number.isInteger(id) || id <= 0) throw refuse('maintenance_invalid_id');

        const ev = await db.get(
            `SELECT id, employee_id AS "employeeId", status, box, box_label AS "boxLabel"
               FROM nine_box_evaluations WHERE id = ?`,
            [id]
        );
        if (!ev) throw refuse('maintenance_placement_not_found');
        if (ev.status !== 'archived') throw refuse('maintenance_restore_not_cancelled');
        const cancel = await db.get(
            `SELECT from_status AS "fromStatus", detail FROM nine_box_events
              WHERE evaluation_id = ? AND action = 'cancel' AND to_status = 'archived'
              ORDER BY created_at DESC, id DESC LIMIT 1`,
            [id]
        );
        const detail =
            cancel && cancel.detail
                ? typeof cancel.detail === 'string'
                    ? JSON.parse(cancel.detail)
                    : cancel.detail
                : null;
        if (!cancel || !detail || detail.maintenance !== true || !cancel.fromStatus)
            throw refuse('maintenance_restore_no_override');
        const previous = String(cancel.fromStatus);
        const clash = await db.get(
            `SELECT id FROM nine_box_evaluations
              WHERE employee_id = ? AND id <> ? AND status = ANY(?) LIMIT 1`,
            [ev.employeeId, id, previous === 'approved' ? ['approved'] : ['draft', 'under_review']]
        );
        if (clash) throw refuse('maintenance_restore_conflict');

        let mirrorRestored = false;
        await db.runTransaction(
            async () => {
                await this._tagActor(user);
                await db.run(
                    'UPDATE nine_box_evaluations SET status = ?, updated_at = now() WHERE id = ?',
                    [previous, id]
                );
                const m = detail.clearedPlacement;
                if (previous === 'approved' && m && m.cycleId != null) {
                    await db.run(
                        `INSERT INTO talent_placements (employee_id, cycle_id, box, tier, source, placed_by, placed_at)
                     VALUES (?, ?, ?, ?, ?, ?, now())
                     ON CONFLICT DO NOTHING`,
                        [
                            ev.employeeId,
                            m.cycleId,
                            m.box,
                            m.tier,
                            m.source || 'maintenance',
                            user.id,
                        ]
                    );
                    mirrorRestored = true;
                }
                await db.run(
                    `INSERT INTO nine_box_events (evaluation_id, employee_id, actor_id, actor_type, action, from_status, to_status, detail)
                 VALUES (?, ?, ?, 'admin', 'restore', 'archived', ?, ?)`,
                    [
                        id,
                        ev.employeeId,
                        user.id,
                        previous,
                        JSON.stringify({
                            reason: why,
                            maintenance: true,
                            note: OVERRIDE_NOTE,
                            mirrorRestored,
                        }),
                    ]
                );
            },
            { actorRef: this._actorRef(user) }
        );

        await this._movement(
            ev.employeeId,
            'placement_cancelled',
            'cancelled',
            `${ev.boxLabel || (ev.box != null ? 'Box ' + ev.box : 'placement')} (restored)`,
            user,
            why
        );
        await this._audit(
            user,
            req,
            'MAINT_RESTORE_NINEBOX',
            'nine_box_evaluations',
            id,
            `9-box placement #${id} (employee ${ev.employeeId}, box ${ev.box}) restored from 'archived' to '${previous}'` +
                `${mirrorRestored ? ' incl. calibration write-back' : ''} — ${OVERRIDE_NOTE}. Reason: ${why}`
        );
        return {
            ok: true,
            evaluationId: id,
            employeeId: ev.employeeId,
            restoredState: previous,
            mirrorRestored,
        };
    },

    // -----------------------------------------------------------------------
    // Reading surfaces for the panel (server-side search,
    // state/site filters and paging — the 200-row cap is gone, the page never
    // grows with headcount and every count is the real total).
    // -----------------------------------------------------------------------

    /**
     * WHERE parts for the shared list filters — q (name / employee number),
     * siteId, employeeId (the `?employee=ID` deep link from an employee page).
     *
     * They are written against the OUTER subquery alias `x`, i.e. against the
     * camelCase columns each list re-exposes ("lastName", "siteId", …), not
     * against `employees e`: `_page` wraps the list SELECT, so `e` is out of
     * scope by the time the filter runs. `idCol` is the column that holds the
     * PERSON on that list — `x."employeeId"` everywhere except the voided list,
     * whose rows ARE the employees (`x.id`).
     */
    _employeeFilter(f = {}, { idCol = 'x."employeeId"' } = {}) {
        const where = [];
        const params = [];
        const q = String(f.q || '').trim();
        if (q) {
            where.push(
                '(x."lastName" ILIKE ? OR x."firstName" ILIKE ? OR (x."firstName" || \' \' || x."lastName") ILIKE ? OR x."employeeNumber" ILIKE ?)'
            );
            const like = `%${q}%`;
            params.push(like, like, like, like);
        }
        if (f.siteId) {
            where.push('x."siteId" = ?');
            params.push(Number(f.siteId));
        }
        if (f.employeeId) {
            where.push(`${idCol} = ?`);
            params.push(Number(f.employeeId));
        }
        return { where, params };
    },

    /** One page + the real total of a filtered SELECT (the SELECT is a subquery-safe text). */
    async _page(select, orderBy, where, params, { page = 1, perPage = 50 } = {}) {
        const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const p = Math.max(1, Number(page) || 1);
        const n = Math.max(1, Math.min(200, Number(perPage) || 50));
        const [rows, cnt] = await Promise.all([
            db.all(`SELECT * FROM (${select}) x ${w} ORDER BY ${orderBy} LIMIT ? OFFSET ?`, [
                ...params,
                n,
                (p - 1) * n,
            ]),
            db.get(`SELECT COUNT(*)::int AS n FROM (${select}) x ${w}`, params),
        ]);
        return { rows, total: cnt ? cnt.n : 0, page: p, perPage: n };
    },

    /**
     * Cancellable IDPs and PIPs, newest first.
     *
     * Each half filters on its OWN enum's terminal labels (see PLANS.terminal):
     * `pips.state` is `pip_state` and `idp_plans.status` is `idp_status`, and
     * naming a label from the other type raises 22P02 rather than matching
     * nothing. The state column is cast to text in the UNION so the two enum
     * types can share one result column.
     */
    async openPlans(f = {}, paging = {}) {
        const idpT = PLANS.idp.terminal;
        const pipT = PLANS.pip.terminal;
        const ef = this._employeeFilter(f);
        const where = [...ef.where];
        const params = [...idpT, ...pipT, ...ef.params];
        if (f.state) {
            where.push('x."state" = ?');
            params.push(String(f.state));
        }
        if (f.planType && PLANS[f.planType]) {
            where.push('x."entityType" = ?');
            params.push(String(f.planType));
        }
        // The employee columns the filter reads are re-exposed by the subquery.
        const select = `SELECT 'idp' AS "entityType", p.id, p.employee_id AS "employeeId", p.status::text AS "state",
                    e.first_name AS "firstName", e.last_name AS "lastName", e.employee_number AS "employeeNumber",
                    e.site_id AS "siteId", p.created_at AS "createdAt"
               FROM idp_plans p JOIN employees e ON e.id = p.employee_id
              WHERE p.status NOT IN (${idpT.map(() => '?').join(',')})
              UNION ALL
             SELECT 'pip', p.id, p.employee_id, p.state::text,
                    e.first_name, e.last_name, e.employee_number, e.site_id, p.created_at
               FROM pips p JOIN employees e ON e.id = p.employee_id
              WHERE p.state NOT IN (${pipT.map(() => '?').join(',')})`;
        return this._page(select, '"createdAt" DESC NULLS LAST, id DESC', where, params, paging);
    },

    /** Plans cancelled by THIS panel, newest first — the "Rétablir" list. */
    async cancelledPlans(f = {}, paging = {}) {
        const ef = this._employeeFilter(f);
        const select = `SELECT cr.entity_type AS "entityType", cr.entity_id AS id, cr.employee_id AS "employeeId",
                    cr.previous_state AS "previousState", cr.decided_at AS "cancelledAt", cr.reason,
                    e.first_name AS "firstName", e.last_name AS "lastName", e.employee_number AS "employeeNumber", e.site_id AS "siteId",
                    CASE WHEN cr.entity_type = 'idp' THEN (SELECT i.status::text FROM idp_plans i WHERE i.id = cr.entity_id)
                         ELSE (SELECT p.state::text FROM pips p WHERE p.id = cr.entity_id) END AS "state"
               FROM cancellation_requests cr JOIN employees e ON e.id = cr.employee_id
              WHERE cr.decision_note = ? AND cr.state = 'approved' AND cr.entity_type IN ('idp', 'pip')`;
        const where = ['x."state" = \'cancelled\'', ...ef.where];
        return this._page(
            select,
            '"cancelledAt" DESC NULLS LAST',
            where,
            [OVERRIDE_NOTE, ...ef.params],
            paging
        );
    },

    /**
     * Self-assessments that can still be cancelled, newest first. 'rejected' is
     * the terminal state a maintenance cancellation lands in, so those are the
     * ones already dealt with and are excluded.
     */
    async openAssessments(f = {}, paging = {}) {
        const ef = this._employeeFilter(f);
        const where = [...ef.where];
        const params = [...ef.params];
        if (f.state) {
            where.push('x."state" = ?');
            params.push(String(f.state));
        }
        const select = `SELECT sa.id, sa.employee_id AS "employeeId", sa.skill_id AS "skillId",
                    sa.workflow_state AS "state", sa.self_rated_level AS "selfLevel",
                    sa.updated_at AS "updatedAt", s.name AS "skillName",
                    e.first_name AS "firstName", e.last_name AS "lastName", e.employee_number AS "employeeNumber", e.site_id AS "siteId"
               FROM self_assessments sa
               JOIN employees e ON e.id = sa.employee_id
               LEFT JOIN skills s ON s.id = sa.skill_id
              WHERE sa.status <> 'rejected'`;
        return this._page(select, '"updatedAt" DESC NULLS LAST, id DESC', where, params, paging);
    },

    /** Live 9-box positions (approved, or still being worked on). */
    async openPlacements(f = {}, paging = {}) {
        const ef = this._employeeFilter(f);
        const where = [...ef.where];
        const params = [...ef.params];
        if (f.state) {
            where.push('x.status = ?');
            params.push(String(f.state));
        }
        const select = `SELECT ev.id, ev.employee_id AS "employeeId", ev.status, ev.box,
                    ev.box_label AS "boxLabel", ev.updated_at AS "updatedAt",
                    e.first_name AS "firstName", e.last_name AS "lastName", e.employee_number AS "employeeNumber", e.site_id AS "siteId"
               FROM nine_box_evaluations ev
               JOIN employees e ON e.id = ev.employee_id
              WHERE ev.status <> 'archived'`;
        return this._page(select, '"updatedAt" DESC NULLS LAST, id DESC', where, params, paging);
    },

    /** Positions archived by THIS panel (a maintenance `cancel` event), newest first. */
    async cancelledPlacements(f = {}, paging = {}) {
        const ef = this._employeeFilter(f);
        const select = `SELECT DISTINCT ON (ev.id) ev.id, ev.employee_id AS "employeeId", ev.box, ev.box_label AS "boxLabel",
                    nbe.from_status AS "previousState", nbe.created_at AS "cancelledAt", nbe.detail->>'reason' AS reason,
                    e.first_name AS "firstName", e.last_name AS "lastName", e.employee_number AS "employeeNumber", e.site_id AS "siteId"
               FROM nine_box_evaluations ev
               JOIN nine_box_events nbe ON nbe.evaluation_id = ev.id AND nbe.action = 'cancel' AND nbe.to_status = 'archived'
                    AND (nbe.detail->>'maintenance') = 'true'
               JOIN employees e ON e.id = ev.employee_id
              WHERE ev.status = 'archived'
              ORDER BY ev.id, nbe.created_at DESC`;
        return this._page(select, '"cancelledAt" DESC NULLS LAST', ef.where, ef.params, paging);
    },

    /** Sites for the filter select. */
    async sites() {
        return db.all('SELECT id, name FROM sites WHERE is_active = true ORDER BY name');
    },

    /**
     * Employees that can still be voided, for the picker. Bounded on purpose:
     * this page must not grow with headcount the way an unpaginated grid does.
     * The caller is told when the list was truncated rather than silently
     * showing a short list as if it were everyone.
     */
    async candidateEmployees(limit = 500) {
        const rows = await db.all(
            `SELECT id, first_name AS "firstName", last_name AS "lastName",
                    employee_number AS "employeeNumber", is_active AS "isActive"
               FROM employees
              WHERE cancelled_at IS NULL
              ORDER BY last_name, first_name
              LIMIT ?`,
            [limit + 1]
        );
        const truncated = rows.length > limit;
        return { rows: truncated ? rows.slice(0, limit) : rows, truncated };
    },

    /** Records already voided — the undo list, and the evidence of what was done. */
    async voidedEmployees(f = {}, paging = {}) {
        // Here the ROW is the person, so the `?employee=ID` deep link matches x.id.
        const ef = this._employeeFilter(f, { idCol: 'x.id' });
        const select = `SELECT e.id, e.first_name AS "firstName", e.last_name AS "lastName",
                    e.employee_number AS "employeeNumber", e.site_id AS "siteId", e.cancelled_at AS "cancelledAt",
                    e.cancel_reason AS "cancelReason", a.username AS "cancelledBy"
               FROM employees e
               LEFT JOIN admins a ON a.id = e.cancelled_by
              WHERE e.cancelled_at IS NOT NULL`;
        return this._page(select, '"cancelledAt" DESC', ef.where, ef.params, paging);
    },

    /**
     * The trail filters: action, actor, dates, employee. The employee
     * is matched on the entity (voids) OR on the "employee N" the audit line
     * names (plans, placements, assessments) — every MAINT_* line carries one.
     */
    _trailFilter(f = {}) {
        const where = ["sl.action LIKE 'MAINT\\_%'"];
        const params = [];
        if (f.action) {
            where.push('sl.action = ?');
            params.push(String(f.action));
        }
        if (f.actor) {
            where.push('(a.username ILIKE ? OR sl.actor_ref ILIKE ?)');
            params.push(`%${f.actor}%`, `%${f.actor}%`);
        }
        if (f.from) {
            where.push('sl.created_at >= ?::timestamptz');
            params.push(String(f.from));
        }
        if (f.to) {
            where.push("sl.created_at < (?::date + INTERVAL '1 day')");
            params.push(String(f.to));
        }
        if (f.employeeId) {
            where.push(
                "((sl.entity_type IN ('employee','employees') AND sl.entity_id = ?) OR sl.details::text ~ ('employee ' || ?::text || '[^0-9]'))"
            );
            params.push(Number(f.employeeId), String(Number(f.employeeId)));
        }
        return { where, params };
    },

    _trailSelect() {
        // details is jsonb holding a text; `#>> '{}'` unwraps it. The employee id
        // and the reason are what the audit line always carries, parsed here so
        // the trail has real columns instead of one prose cell.
        return `SELECT sl.id, sl.action, sl.entity_type AS "entityType", sl.entity_id AS "entityId",
                    (sl.details #>> '{}') AS details, sl.created_at AS "createdAt", sl.actor_ref AS "actorRef", a.username,
                    COALESCE(CASE WHEN sl.entity_type IN ('employee','employees') THEN sl.entity_id END,
                             NULLIF(substring((sl.details #>> '{}') from 'employee ([0-9]+)'), '')::bigint) AS "employeeId",
                    substring((sl.details #>> '{}') from 'Reason: (.*)$') AS reason
               FROM system_logs sl LEFT JOIN admins a ON a.id = sl.admin_id`;
    },

    /** Everything this panel has done, filtered and paged, with employee names. */
    async recentActions(f = {}, paging = {}) {
        const { where, params } = this._trailFilter(f);
        const select = `${this._trailSelect()} WHERE ${where.join(' AND ')}`;
        const out = await this._page(select, '"createdAt" DESC', [], params, paging);
        await this._attachEmployeeNames(out.rows);
        return out;
    },

    /** The whole filtered trail for the CSV export (bounded at 5 000 rows, said in the file). */
    async trailAll(f = {}, cap = 5000) {
        const { where, params } = this._trailFilter(f);
        const rows = await db.all(
            `${this._trailSelect()} WHERE ${where.join(' AND ')} ORDER BY sl.created_at DESC LIMIT ?`,
            [...params, cap]
        );
        await this._attachEmployeeNames(rows);
        return rows;
    },

    async _attachEmployeeNames(rows) {
        const ids = [
            ...new Set(
                rows
                    .map((r) => r.employeeId)
                    .filter((v) => v != null)
                    .map(Number)
            ),
        ];
        if (!ids.length) return;
        const emps = await db.all(
            'SELECT id, first_name AS "firstName", last_name AS "lastName", employee_number AS "employeeNumber" FROM employees WHERE id = ANY(?)',
            [ids]
        );
        const by = new Map(emps.map((e) => [Number(e.id), e]));
        for (const r of rows) {
            const e = r.employeeId != null ? by.get(Number(r.employeeId)) : null;
            r.employeeName = e ? personNameOf(e) : null;
            r.employeeNumber = e ? e.employeeNumber : null;
        }
    },

    /** DISTINCT MAINT_* actions, for the trail's action select. */
    async trailActions() {
        return db.all(
            "SELECT action AS v, COUNT(*)::int AS n FROM system_logs WHERE action LIKE 'MAINT\\_%' GROUP BY 1 ORDER BY 1"
        );
    },

    // -----------------------------------------------------------------------
    // SECTION accounts — GDPR data-subject rights from the panel
    // -----------------------------------------------------------------------

    /** The subject's personal-data export (DSRService.export), audited as a PII read. */
    async dsrExport(user, { employeeId }, req = null) {
        assertSuperAdmin(user);
        const id = Number(employeeId);
        if (!Number.isInteger(id) || id <= 0) throw refuse('maintenance_pick_employee');
        const emp = await db.get('SELECT id, employee_number FROM employees WHERE id = ?', [id]);
        if (!emp) throw refuse('maintenance_employee_not_found');
        const data = await require('./DSRService').export(id);
        await this._audit(
            user,
            req,
            'MAINT_DSR_EXPORT',
            'employee',
            id,
            `Data-subject export generated for employee ${emp.employeeNumber} (#${id}) from the maintenance panel`
        );
        return data;
    },

    // -----------------------------------------------------------------------
    // Erasure under LEGAL HOLD (migration 166): refused; a two-person override
    // (a written reason + a SECOND, different SuperAdmin) is the only way.
    // -----------------------------------------------------------------------

    /** Pending override requests older than this lapse (never silently executed). */
    OVERRIDE_TTL_DAYS: 7,

    async _activeSuperAdminCount() {
        const r = await db.get(
            "SELECT COUNT(*)::int AS n FROM admins WHERE role::text = 'superadmin' AND is_active = true"
        );
        return r ? Number(r.n) : 0;
    },

    async _expireStaleOverrides() {
        await db.run(
            `UPDATE erasure_override_requests SET state = 'expired'
              WHERE state = 'pending' AND requested_at < now() - (? || ' days')::interval`,
            [this.OVERRIDE_TTL_DAYS]
        );
    },

    /** A hold refusal the panel can show: code + holder + reason + whether an override is possible. */
    _holdRefusal(hold, superadmins) {
        const e = refuse(
            superadmins < 2
                ? 'maintenance_erase_legal_hold_single_superadmin'
                : 'maintenance_erase_legal_hold'
        );
        e.status = 409;
        e.hold = hold;
        return e;
    },

    /** What the erase dialog needs to know before it offers "erase" or "request override". */
    async dsrEraseStatus(user, { employeeId }) {
        assertSuperAdmin(user);
        const id = Number(employeeId);
        if (!Number.isInteger(id) || id <= 0) throw refuse('maintenance_pick_employee');
        const emp = await db.get('SELECT id, erased_at FROM employees WHERE id = ?', [id]);
        if (!emp) throw refuse('maintenance_employee_not_found');
        await this._expireStaleOverrides();
        const hold = await require('./DSRService').legalHoldOf(id);
        const superadmins = await this._activeSuperAdminCount();
        const open = await db.get(
            `SELECT id, requested_by_admin_id AS "requestedBy", reason, state, requested_at AS "requestedAt"
               FROM erasure_override_requests WHERE employee_id = ? AND state IN ('pending', 'approved')
              ORDER BY id DESC LIMIT 1`,
            [id]
        );
        return {
            employeeId: id,
            erased: Boolean(emp.erasedAt),
            hold,
            superadmins,
            overridePossible: Boolean(hold) && superadmins >= 2,
            openOverride: open || null,
            youRequested: Boolean(open && Number(open.requestedBy) === Number(user.id)),
        };
    },

    /** Step 1: a SuperAdmin asks to erase a held person (reason + number retyped). */
    async dsrOverrideRequest(user, { employeeId, reason, confirmNumber }, req = null) {
        assertSuperAdmin(user);
        const why = assertReason(reason);
        const id = Number(employeeId);
        if (!Number.isInteger(id) || id <= 0) throw refuse('maintenance_pick_employee');
        const emp = await db.get(
            'SELECT id, employee_number, erased_at FROM employees WHERE id = ?',
            [id]
        );
        if (!emp) throw refuse('maintenance_employee_not_found');
        if (emp.erasedAt) throw refuse('maintenance_already_erased');
        if (String(confirmNumber || '').trim() !== String(emp.employeeNumber || '').trim())
            throw refuse('maintenance_confirm_mismatch');
        const hold = await require('./DSRService').legalHoldOf(id);
        if (!hold) throw refuse('maintenance_override_no_hold');
        // With ONE SuperAdmin there is nobody to approve: the override is
        // impossible by construction, and the page says so.
        if ((await this._activeSuperAdminCount()) < 2)
            throw refuse('maintenance_override_single_superadmin');
        await this._expireStaleOverrides();
        const open = await db.get(
            "SELECT id FROM erasure_override_requests WHERE employee_id = ? AND state IN ('pending', 'approved')",
            [id]
        );
        if (open) throw refuse('maintenance_override_already_open');
        const row = await db.get(
            `INSERT INTO erasure_override_requests (employee_id, requested_by_admin_id, reason, hold_snapshot)
             VALUES (?, ?, ?, ?::jsonb) RETURNING id`,
            [id, user.id, why, JSON.stringify({ at: hold.at, by: hold.by, level: hold.level })]
        );
        const rid = Number(row && row.id);
        await this._audit(
            user,
            req,
            'MAINT_DSR_ERASE_OVERRIDE_REQUESTED',
            'employee',
            id,
            `Erasure of subject #${id} under legal hold (${hold.level}) requested: override request #${rid}, awaiting a second SuperAdmin. Reason: ${why}`
        );
        return { ok: true, requestId: rid, employeeId: id, state: 'pending' };
    },

    /**
     * Step 2: ANOTHER SuperAdmin approves (the erasure runs now) or refuses;
     * the requester may only withdraw. Approving one's own request is refused.
     */
    async dsrOverrideDecide(user, { requestId, approve, note }, req = null) {
        assertSuperAdmin(user);
        const rid = Number(requestId);
        if (!Number.isInteger(rid) || rid <= 0) throw refuse('maintenance_override_not_found');
        await this._expireStaleOverrides();
        const r = await db.get(
            'SELECT id, employee_id, requested_by_admin_id, reason, state FROM erasure_override_requests WHERE id = ?',
            [rid]
        );
        if (!r) throw refuse('maintenance_override_not_found');
        if (r.state !== 'pending') throw refuse('maintenance_override_not_pending');
        const id = Number(r.employeeId);
        const mine = Number(r.requestedByAdminId) === Number(user.id);
        const yes = approve === true || approve === 'true';
        if (!yes) {
            const state = mine ? 'withdrawn' : 'refused';
            const why = mine ? String(note || '').trim() || null : assertReason(note);
            await db.run(
                `UPDATE erasure_override_requests SET state = ?, decided_by_admin_id = ?, decided_at = now(), decision_note = ?
                  WHERE id = ? AND state = 'pending'`,
                [state, user.id, why, rid]
            );
            await this._audit(
                user,
                req,
                mine ? 'MAINT_DSR_ERASE_OVERRIDE_WITHDRAWN' : 'MAINT_DSR_ERASE_OVERRIDE_REFUSED',
                'employee',
                id,
                `Override request #${rid} for subject #${id} ${state}` +
                    (why ? `. Reason: ${why}` : '')
            );
            return { ok: true, requestId: rid, state };
        }
        if (mine) throw refuse('maintenance_override_same_person');
        const decision = assertReason(note);
        return db.runTransaction(async () => {
            await this._tagActor(user);
            const upd = await db.run(
                `UPDATE erasure_override_requests SET state = 'approved', decided_by_admin_id = ?, decided_at = now(), decision_note = ?
                  WHERE id = ? AND state = 'pending'`,
                [user.id, decision, rid]
            );
            if (!upd || upd.changes !== 1) throw refuse('maintenance_override_not_pending');
            const out = await require('./DSRService').erase(id, user.id, {
                reason: `legal-hold override #${rid}: ${r.reason}`,
                legalHoldOverride: rid,
            });
            await this._movement(
                id,
                'status',
                'active',
                'erased',
                user,
                `${OVERRIDE_NOTE} — legal-hold override #${rid}`
            );
            await this._audit(
                user,
                req,
                'MAINT_DSR_ERASE_OVERRIDE_APPROVED',
                'employee',
                id,
                `Override request #${rid} approved by a second SuperAdmin (requested by admin #${Number(r.requestedByAdminId)}); subject #${id} erased under legal hold. Reason: ${decision}`
            );
            return {
                ok: true,
                requestId: rid,
                state: 'executed',
                employeeId: id,
                linkedAdminsErased: out.linkedAdminsErased || 0,
            };
        });
    },

    /** Open override requests (pending), for the panel. Ids only. */
    async dsrOverrideList(user) {
        assertSuperAdmin(user);
        await this._expireStaleOverrides();
        const rows = await db.all(
            `SELECT id, employee_id AS "employeeId", requested_by_admin_id AS "requestedBy", reason,
                    requested_at AS "requestedAt", state
               FROM erasure_override_requests WHERE state = 'pending' ORDER BY requested_at`
        );
        for (const row of rows) row.mine = Number(row.requestedBy) === Number(user.id);
        return rows;
    },

    /**
     * Erase a subject (irreversible). Reason mandatory; the SuperAdmin must also
     * retype the employee number (double confirmation) — an erasure has no
     * "restore". DSRService.erase runs the leaver cascade first when the person
     * is still active, then pseudonymises the record AND any linked admin login.
     * Refused under legal hold: the override above is the only way through.
     */
    async dsrErase(user, { employeeId, reason, confirmNumber }, req = null) {
        assertSuperAdmin(user);
        const why = assertReason(reason);
        const id = Number(employeeId);
        if (!Number.isInteger(id) || id <= 0) throw refuse('maintenance_pick_employee');
        const emp = await db.get(
            'SELECT id, employee_number, first_name, last_name, erased_at FROM employees WHERE id = ?',
            [id]
        );
        if (!emp) throw refuse('maintenance_employee_not_found');
        if (emp.erasedAt) throw refuse('maintenance_already_erased');
        if (String(confirmNumber || '').trim() !== String(emp.employeeNumber || '').trim())
            throw refuse('maintenance_confirm_mismatch');
        // Refused under legal hold (DSRService.erase refuses too: this answers
        // with the panel's code, holder and reason).
        const hold = await require('./DSRService').legalHoldOf(id);
        if (hold) throw this._holdRefusal(hold, await this._activeSuperAdminCount());
        const out = await require('./DSRService').erase(id, user.id, { reason: why });
        await this._movement(id, 'status', 'active', 'erased', user, `${OVERRIDE_NOTE} — ${why}`);
        await this._audit(
            user,
            req,
            'MAINT_DSR_ERASE',
            'employee',
            id,
            `Subject #${id} erased under right-to-erasure — ${why}` +
                (out.linkedAdminsErased
                    ? `; ${out.linkedAdminsErased} linked admin account(s) pseudonymised`
                    : '')
        );
        return { ok: true, employeeId: id, linkedAdminsErased: out.linkedAdminsErased || 0 };
    },
};

module.exports = MaintenanceService;
