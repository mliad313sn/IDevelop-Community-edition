'use strict';

const db = require('../config/database');

/**
 *   Dispute ladder with configurable SLAs (Settings → category 'disputes'):
 *     L0 (employee ↔ supervisor)  — l0SlaDays  → escalate to L1 (manager)
 *     L1 (manager)                — l1SlaDays  → escalate to L2 (HR arbitration)
 *     L2 (HR = admin w/ arbitrate_disputes)    — l2SlaDays → auto-finalize with
 *          the supervisor's rating (opt-out via dispute.autoFinalizeOnExpiry);
 *          a review with NO supervisor rating (a rejection) is never
 *          auto-finalised — it is raised to HR once and waits for a decision
 *   so a dispute can never deadlock cycle close. Disputed rows stay
 *   self_assessments.locked_state='provisional' until resolved/finalized.
 *   A dispute may only be opened by the employee the review is about, on a
 *   review that has been decided ('completed'); every resolution carries an
 *   integer 0-4 rating and a note.
 */

const AppSettingsModel = require('../models/AppSettingsModel');

// Settings-first, env fallback, then default — so an admin can tune SLAs live.
async function slaDays(key, envVar, def) {
    try {
        const v = await AppSettingsModel.getValue(key, null);
        if (v !== null && v !== '' && !Number.isNaN(Number(v))) return Number(v);
    } catch (_) {
        /* fall through */
    }
    const env = envVar && process.env[envVar];
    return env && !Number.isNaN(Number(env)) ? Number(env) : def;
}
async function autoFinalizeEnabled() {
    try {
        const v = await AppSettingsModel.getValue('dispute.autoFinalizeOnExpiry', true);
        return v === true || v === 'true' || v === 1 || v === '1';
    } catch (_) {
        return true;
    }
}

// A business-rule refusal. `status` lets the route/controller answer a clean
// 4xx (asyncHandler otherwise reports every throw as 500, and a PG CHECK
// violation as a raw driver message); `code` is stable so the caller can pick a
// localized message for it. The English text is only the fallback.
function refuse(status, code, message) {
    const e = new Error(message);
    e.status = status;
    e.code = code;
    return e;
}

// Appended ONCE to assessment_disputes.reason when the L2 SLA lapses on a review
// that carries NO supervisor rating (a rejection). It is the record that HR was
// asked, so the escalator does not raise the same dispute again every tick.
const HR_REQUIRED_MARK = '[hr_arbitration_required: no supervisor rating to finalise]';

// Appended ONCE when the L2 SLA lapses on a review that DOES carry a rating.
// Written as a SQL literal in autoFinalizeOverdueL2 (its exact parameter list is
// asserted elsewhere) and declared here because `splitReason` below removes
// these annotations BY THEIR EXACT TEXT: the two spellings must stay identical
// or the annotation leaks into the sentence attributed to the employee. The two
// are held together by a test that compares this constant to that statement.
const AUTO_FINALIZED_MARK = '[auto-finalized: no HR decision within SLA]';

// The two machine annotations, paired with the stable code a surface can
// translate. They are STATEMENTS BY THE SYSTEM: never part of anyone's words.
// Appended ONCE by _applyDecidedRatingToSkill when the decided rating is NOT
// promoted because the round the review judged has since been REPLACED by a
// newer campaign: the decision stands on the review, the official level stays
// the current round's. It is the trace the house rule demands (« promotion
// retenue : tour remplacé »), never a silent skip.
const PROMOTION_WITHHELD_MARK = '[promotion_withheld: replaced round]';

const SYSTEM_MARKS = [
    { text: AUTO_FINALIZED_MARK, code: 'auto_finalized' },
    { text: HR_REQUIRED_MARK, code: 'hr_arbitration_required' },
    { text: PROMOTION_WITHHELD_MARK, code: 'promotion_withheld_superseded' },
];

// The separator written by appendResolutionNote. Anchored on the exact shape
// that function composes: two newlines, the level in brackets, one space.
const RESOLUTION_MARK = /\n\n\[resolution:(L\d)\][ ]?/;

/**
 * TWO STATEMENTS BY TWO PEOPLE, ONE COLUMN.
 *
 * `assessment_disputes.reason` is `NOT NULL` and is written ONCE, by the
 * EMPLOYEE, when they open the dispute — it is their case. All three resolve
 * paths then did `reason = ?` with the DECIDER's note, which
 *   (a) DESTROYED the employee's own words, irreversibly: a full sweep of every
 *       text/varchar/json(b) column of the schema found no other copy, and
 *       neither L0 nor L1 wrote any system_logs row either; and
 *   (b) MISATTRIBUTED what was left — the employee's page renders
 *       `dispute.reason` only in the 'resolved' branch, unlabelled, under
 *       "Note finale", so the manager's sentence read as if the employee had
 *       written it.
 * House rule: a cancellation is a STATE plus a MOTIVE, never a deletion.
 *
 * The decision note is therefore APPENDED under an explicit, machine-readable
 * marker — the same shape this file already uses for the two automatic
 * annotations above — so both statements survive and each is attributable
 * (`decided_by` / `decided_by_admin_id` / `resolved_at` name the decider).
 * Built as SQL, not as a parameter, so the note the caller passed is stored
 * byte-for-byte.
 *
 * The column is still a single free-text field: a dedicated `resolution_note`
 * column is the clean shape and is reported as remaining work.
 */
function appendResolutionNote(level) {
    return `reason = COALESCE(reason, '') || E'\\n\\n[resolution:${level}] ' || ?`;
}

class DisputeServiceV2 {
    /**
     * READ BACK WHAT appendResolutionNote WROTE — the marker is a seam, not a
     * sentence.
     *
     * Composing both statements into one column kept the employee's words alive
     * (that half is closed), but the employee's own page then served the whole
     * column as ONE unlabelled run of text: measured over HTTP on a development
     * database, a resolved dispute rendered
     *     <div class="text-muted">…leur motif…\n\n[resolution:L0] …la note du
     *     décideur…</div>
     * under "Note finale : 2". Three things were wrong with that and none of
     * them are cosmetic: the two people were indistinguishable, the separating
     * newline is an HTML newline so the browser welded the sentences into one
     * line, and `[resolution:L0]` — an internal marker — was read by the person
     * the decision is about.
     *
     * So the seam is CUT HERE, next to the code that writes it, and the surface
     * receives named pieces it cannot re-weld:
     *   employeeReason   the words the employee wrote when they opened the case
     *   resolutionNote   the decider's note, if a decision has been recorded
     *   resolutionLevel  'L0' | 'L1' | 'L2' — which rung decided
     *   systemNotes      stable codes for the machine annotations (never text)
     *
     * A dispute still OPEN has no marker at all: it returns employeeReason and
     * nothing else — which is how the open case finally becomes readable to its
     * author, who until now could not re-read their own file.
     */
    static splitReason(reason) {
        let rest = reason == null ? '' : String(reason);
        const systemNotes = [];
        for (const m of SYSTEM_MARKS) {
            if (rest.includes(m.text)) {
                systemNotes.push(m.code);
                rest = rest.split(m.text).join('');
            }
        }
        const hit = rest.match(RESOLUTION_MARK);
        let employeeReason = rest;
        let resolutionNote = null;
        let resolutionLevel = null;
        if (hit) {
            employeeReason = rest.slice(0, hit.index);
            resolutionLevel = hit[1];
            resolutionNote = rest.slice(hit.index + hit[0].length);
        }
        return {
            employeeReason: employeeReason.trim() || null,
            resolutionNote: resolutionNote === null ? null : resolutionNote.trim() || null,
            resolutionLevel,
            systemNotes,
        };
    }

    /**
     * A dispute is decided with a rating, never without one. All three resolve
     * paths used to accept a null/absent `decidedRating` — the dispute then read
     * "resolved" with no decision, the assessment was finalised, and the review
     * stayed `disputed` — and an out-of-range value (7, "abc", 2.5) reached the
     * DB CHECK / smallint cast and came back as a raw driver error. Server-side,
     * same rule as the reason guard: refuse early, with a status the route can
     * answer as 400.
     */
    static _requireRating(decidedRating) {
        if (
            decidedRating === null ||
            decidedRating === undefined ||
            String(decidedRating).trim() === ''
        )
            throw refuse(
                400,
                'DISPUTE_RATING_REQUIRED',
                'A final rating (0-4) is required to resolve a dispute.'
            );
        const n = Number(decidedRating);
        if (!Number.isInteger(n) || n < 0 || n > 4)
            throw refuse(
                400,
                'DISPUTE_RATING_RANGE',
                'The final rating must be a whole number between 0 and 4.'
            );
        return n;
    }

    // A rating change against an employee must carry a rationale (fairness +
    // audit) — mirror the reject path's server-side reason guard.
    static _requireReason(reason) {
        if (!reason || !String(reason).trim())
            throw refuse(400, 'DISPUTE_REASON_REQUIRED', 'A resolution note is required.');
    }

    /**
     * Write the decided rating onto the review row. ONE helper for L0, L1 and L2
     * (and the SLA finalisation), because the three paths had drifted:
     *   - L0 never set status='completed' (L1/L2 did) → the review stayed
     *     `disputed` for ever and the V1 console queue never cleared;
     *   - none of them recomputed `gap`, so after a 1→3 decision the employee
     *     still read "Écart 0" over a real divergence of 2.
     * The gap is decided − self, exactly as
     * SelfAssessmentWorkflowService._finalizeSupervisorReview computes it.
     * Runs inside the caller's transaction.
     *
     * THE ROUND, NOT THE CURRENT MEASUREMENT. `self_assessments` is a VIEW over
     * `self_assessment_rounds WHERE superseded_at IS NULL` (migration 113), while
     * `supervisor_reviews.self_assessment_id` is a foreign key onto ONE round. So
     * this UPDATE matched ZERO rows the moment the person had been asked again:
     * the dispute was recorded 'resolved' with its decided rating, the official
     * skill level WAS changed, and the review it decided stayed 'disputed' with
     * the pre-dispute level and a stale gap. Measured in a rolled-back
     * transaction on a development database: review 1023 (replaced round) →
     * rowCount 0; a control review on a current round → 1; the same statement
     * against `self_assessment_rounds` → 1.
     */
    static async _applyDecisionToReview(supervisorReviewId, decidedRating) {
        const { changes } = await db.run(
            `UPDATE supervisor_reviews sr
                SET supervisor_rated_level = ?, gap = ? - sa.self_rated_level, status = 'completed'
               FROM self_assessment_rounds sa
              WHERE sa.id = sr.self_assessment_id AND sr.id = ?`,
            [decidedRating, decidedRating, supervisorReviewId]
        );
        return changes;
    }

    /**
     * Flow a dispute's final decided rating into the OFFICIAL skill profile
     * (skill_assessments) — the source of truth for readiness, gaps, 9-box and
     * benchmark. Without this the arbitrated rating was stranded on the review/
     * dispute rows and the dashboards kept showing the pre-dispute level.
     * Runs inside the caller's transaction (client reused via ALS).
     */
    static async _applyDecidedRatingToSkill(
        supervisorReviewId,
        decidedRating,
        decidedBy,
        disputeId = null
    ) {
        if (decidedRating === null || decidedRating === undefined || !supervisorReviewId) return;
        const sr = await db.get(
            `SELECT sr.employee_id, sr.skill_id, sa.superseded_at
               FROM supervisor_reviews sr
               LEFT JOIN self_assessment_rounds sa ON sa.id = sr.self_assessment_id
              WHERE sr.id = ?`,
            [supervisorReviewId]
        );
        if (!sr) return;
        // A REPLACED ROUND NEVER OVERWRITES THE CURRENT OFFICIAL LEVEL. The
        // review points at ONE round; once the person has been asked again that
        // round carries `superseded_at`, and `SelfAssessmentService.
        // completeSupervisorReview` already WITHHOLDS the promotion for it. This
        // path did not: measured (rolled back) on rounds 223929 (replaced,
        // reviewed) / 223932 (current) of a development database, resolveL0 on the
        // replaced round's dispute rewrote skill_assessments 4 → 1 — the current
        // round's official level, erased by a decision about an older one. The
        // decision stays on the review (`_applyDecisionToReview`); the official
        // profile is left to the current round, and the dispute says so.
        if (sr.supersededAt) {
            if (disputeId) {
                await db.run(
                    `UPDATE assessment_disputes
                        SET reason = COALESCE(reason, '') || ' ' || ?
                      WHERE id = ? AND COALESCE(reason, '') NOT LIKE '%' || ? || '%'`,
                    [PROMOTION_WITHHELD_MARK, disputeId, PROMOTION_WITHHELD_MARK]
                );
            }
            try {
                await require('./LogService').log({
                    action: 'DISPUTE_PROMOTION_WITHHELD',
                    entityType: 'supervisor_review',
                    entityId: Number(supervisorReviewId),
                    details: `decided rating ${decidedRating} kept on the review only: the round it judged was replaced by a newer campaign (official level unchanged)`,
                });
            } catch (_) {
                /* best-effort */
            }
            return;
        }
        // `skill_assessments.assessed_by` is NOT NULL, but an AUTOMATIC L2
        // finalisation has no human actor and passed null — so the promotion threw
        // `null value in column "assessed_by" ... violates not-null constraint`,
        // the dispute stayed stuck at L2/escalated, and the throw propagated out
        // and aborted the rest of that dispute-escalator pass. It only "worked"
        // when the review carried NO rating, i.e. when there was nothing to promote.
        //
        // The same hole exists on the HUMAN paths, one step further along:
        // resolveL0/resolveL1 pass `decidedBy = req.user.id`, which for a
        // supervisor or manager is an EMPLOYEE id — but `assessed_by` is a
        // foreign key onto `admins(id)`. Promoting then threw
        // `violates foreign key constraint "skill_assessments_assessed_by_fkey"`
        // and the whole resolution came back HTTP 500 with the dispute
        // unresolved. And the dispute screen REQUIRES a rating before it will
        // submit, so every non-admin "Resolve" click took the failing path.
        // Treat an id that is not a real admin exactly like no id at all.
        let assessedBy = decidedBy || null;
        if (assessedBy) {
            const isAdmin = await db.get('SELECT id FROM admins WHERE id = ?', [assessedBy]);
            if (!isAdmin) assessedBy = null;
        }
        // Resolve a system attribution the same way SelfAssessmentWorkflowService
        // does for the identical case, so the two promotion paths agree.
        if (!assessedBy) {
            const a =
                (await db.get(
                    "SELECT id FROM admins WHERE username = 'admin' AND is_active = true LIMIT 1"
                )) || (await db.get('SELECT id FROM admins ORDER BY id LIMIT 1'));
            assessedBy = a ? a.id : null;
        }
        if (!assessedBy) return; // nothing valid to attribute to — skip, never fail the finalisation
        await require('../models/SkillAssessmentModel').upsert({
            employeeId: sr.employeeId,
            skillId: sr.skillId,
            currentLevel: Number(decidedRating),
            assessedBy,
            notes: 'Set by dispute resolution (final decided rating).',
        });
    }

    /**
     * @param {function} [t]  the request's i18next translator: the campaign gate
     *   writes its refusal in the reader's language when it has one (FR otherwise,
     *   like `CycleService.gateMessage`). Every other refusal carries `e.i18n`
     *   (key + vars) for the handler to render.
     */
    static async open({ supervisorReviewId, employeeId, reason, t }) {
        const reviewId = Number(supervisorReviewId);
        if (!Number.isInteger(reviewId) || reviewId <= 0)
            throw refuse(400, 'DISPUTE_REVIEW_INVALID', 'Invalid review reference.');
        if (!reason || !String(reason).trim())
            throw refuse(400, 'DISPUTE_REASON_REQUIRED', 'A dispute reason is required.');
        return db
            .runTransaction(async () => {
                // OWNERSHIP + STATE, decided here and not left to the callers.
                // `supervisorReviewId` arrives straight from the request body and was
                // never checked to belong to the caller: ANY employee could open a
                // dispute on ANYONE's review. The dispute row then carried the
                // attacker's employee_id, so the scope guard resolved the ATTACKER's
                // manager, who "resolved" it and rewrote the victim's official skill
                // level — while the victim never saw it, and uq_dispute_open_per_review
                // had consumed their only slot. Measured (rolled back): attacker 84 →
                // dispute on employee 98's review, employeeFor = 84.
                // A review is disputable only once a decision exists on it
                // ('completed' — the only state the employee page offers "Contester"
                // on): a pending review has nothing to contest, a disputed one already
                // is.
                //
                // THE ROUND THE REVIEW JUDGED comes with it (the TABLE, never the
                // view): its campaign, its decision dates and whether it has since
                // been replaced — the three things the contest rules below read.
                const review = await db.get(
                    `SELECT sr.employee_id, sr.status, sr.decided_at, sr.reviewed_at,
                            sa.cycle_id, sa.approved_at, sa.reviewed_at AS round_reviewed_at,
                            sa.superseded_at
                       FROM supervisor_reviews sr
                       LEFT JOIN self_assessment_rounds sa ON sa.id = sr.self_assessment_id
                      WHERE sr.id = ?`,
                    [reviewId]
                );
                if (!review) throw refuse(404, 'DISPUTE_REVIEW_NOT_FOUND', 'Review not found.');
                if (Number(review.employeeId) !== Number(employeeId))
                    throw refuse(403, 'DISPUTE_NOT_OWNER', 'You can only dispute your own review.');
                if (review.status !== 'completed')
                    throw refuse(
                        409,
                        'DISPUTE_NOT_DISPUTABLE',
                        'This review cannot be disputed: it has not been decided yet, or it is already under dispute.'
                    );
                // THE SAME RULES AS THE REQUEST FOR CHANGE (referential §3, A7).
                // A dispute used to open on ANY completed review: 45 days after the
                // decision (the request for change refuses at 30 — measured, same
                // round, `contest_window_expired` on one path and dispute #122 on
                // the other), inside a CLOSED campaign (campaign 73, closed
                // 2026-09-15 → dispute #123), and on a round the person had since
                // been asked AGAIN — whose resolution then overwrote the current
                // official level (see _applyDecidedRatingToSkill). Three gates, in
                // that order, each with its dated sentence in both languages.
                //
                // 1. A replaced round is history: the current round is what to
                //    contest, through its own review.
                if (review.supersededAt) {
                    const e = refuse(
                        409,
                        'DISPUTE_ROUND_SUPERSEDED',
                        'Cette revue porte sur un tour remplacé par une campagne plus récente : contestez la revue du tour en cours.'
                    );
                    e.i18n = { key: 'employee:sr_err_round_superseded' };
                    e.expose = true;
                    throw e;
                }
                // 2. The campaign gate `cycle_id` NULL is OFF-CAMPAIGN
                // and always passes. 'arbitration' is a review write, so a
                //    LOCKED campaign still lets the person contest what was decided
                //    in it; a CLOSED or CANCELLED one refuses, naming itself and its
                //    date. The gate error carries `e.gate` + status 409.
                await require('./SelfAssessmentWorkflowService')._assertCycleWritable(
                    review.cycleId,
                    'arbitration',
                    typeof t === 'function' ? { t } : null
                );
                // 3. A7 — 30 days from the DECISION, the one shared definition
                //    (`AssessmentChangeRequestService._assertWithinContestWindow`):
                //    the contested decision is the reviewer's, dated on the review;
                //    the round's approval/review date is the fallback. The refusal
                //    is that service's — `contest_window_expired`, 409, with the
                //    two dates in `e.i18n.vars`.
                require('./AssessmentChangeRequestService')._assertWithinContestWindow({
                    approvedAt: review.decidedAt || review.approvedAt || null,
                    reviewedAt: review.reviewedAt || review.roundReviewedAt || null,
                });
                const { lastID } = await db.run(
                    `INSERT INTO assessment_disputes
                    (supervisor_review_id, employee_id, level, state, reason)
                 VALUES (?, ?, 'L0', 'open', ?)`,
                    [reviewId, employeeId, String(reason).trim()]
                );
                // Mark the review's row provisional…
                await db.run(
                    `UPDATE self_assessment_rounds sa
                 SET locked_state = 'provisional'
                 FROM supervisor_reviews sr
                 WHERE sr.id = ? AND sr.self_assessment_id = sa.id`,
                    [reviewId]
                );
                // …and flag the supervisor review as disputed so the employee portal
                // (which reads supervisor_reviews.status) reflects it.
                await db.run(`UPDATE supervisor_reviews SET status = 'disputed' WHERE id = ?`, [
                    reviewId,
                ]);
                return lastID;
            })
            .then(async (lastID) => {
                // Tell the reviewing supervisor their rating was contested (accountability:
                // previously the supervisor never learned a dispute was opened).
                const reviewerId = await DisputeServiceV2._reviewerOf(reviewId).catch(() => null);
                await DisputeServiceV2._notify('employee', reviewerId, 'dispute.opened', {
                    link: '/supervisor/self-assessment-reviews',
                });
                return lastID;
            });
    }

    /**
     * The subject employee id for a dispute (for scope checks); null if not found.
     * Resolved from the REVIEW behind the dispute, never from
     * assessment_disputes.employee_id: the review is the ground truth of whose
     * rating is being decided, so a dispute row that names somebody else can
     * never route the decision to that somebody's manager.
     */
    static async employeeFor(disputeId) {
        const r = await db.get(
            `SELECT sr.employee_id FROM assessment_disputes ad
               JOIN supervisor_reviews sr ON sr.id = ad.supervisor_review_id
              WHERE ad.id = ?`,
            [disputeId]
        );
        return r ? Number(r.employeeId) : null;
    }

    /**
     * Open/escalated disputes within the manager/admin's span of control.
     *
     * The self-assessment is joined through `self_assessment_rounds`, the TABLE:
     * the dispute is about the level the employee submitted in the round the
     * review judged, not about whatever they may have answered since. On the
     * `self_assessments` VIEW this LEFT JOIN returned NULL for every replaced
     * round, so the decision screen showed the manager an EMPTY "Auto" cell next
     * to "Superviseur 3" — the measurement exists (3, on round 223929 of a
     * development database) and was rendered as if it did not. A decision-maker
     * cannot arbitrate a gap one side of which has been blanked out.
     */
    static async listForManager(user) {
        const RBAC = require('./RBACService');
        const sc = await RBAC.scopeFilter(user, { empAlias: 'e' });
        return db.all(
            `SELECT ad.id, ad.state, ad.level, ad.reason, ad.opened_at, ad.escalated_at, ad.decided_rating,
                    e.first_name, e.last_name, e.employee_number,
                    s.name AS skill_name, sa.self_rated_level, sr.supervisor_rated_level,
                    sa.superseded_at
             FROM assessment_disputes ad
             JOIN supervisor_reviews sr ON sr.id = ad.supervisor_review_id
             JOIN employees e ON e.id = ad.employee_id
             LEFT JOIN self_assessment_rounds sa ON sa.id = sr.self_assessment_id
             LEFT JOIN skills s ON s.id = sr.skill_id
             WHERE ad.state IN ('open','escalated') ${sc.clause}
             ORDER BY ad.opened_at`,
            sc.params
        );
    }

    /**
     * Disputes for an employee, joined for the employee-portal view.
     *
     * Same rule as listForManager: the join addresses the ROUND the review
     * judged. Through the view, "Votre note" came back NULL for a replaced round
     * and the portal printed an empty cell — not even a "—" — beside the
     * reviewer's 3. The employee was shown their own measurement as missing.
     *
     * Each row is also handed to the page ALREADY SEPARATED (splitReason): the
     * employee's own words, the decider's note and the machine annotations are
     * three named fields, so the template cannot print them as one anonymous
     * paragraph again. `deciderName` names who wrote the note — an L0/L1
     * decision is taken by an employee (`decided_by`), an L2 arbitration by an
     * admin (`decided_by_admin_id`, shown under the person behind that account
     * when one is linked); an SLA auto-closure has no author at all and says so
     * through `systemNotes`, never by borrowing someone's name. `reason` is left
     * on the row untouched — this is additive.
     */
    static async listForEmployee(employeeId) {
        const rows = await db.all(
            `SELECT ad.id, ad.state, ad.level, ad.reason, ad.opened_at,
                    ad.escalated_at, ad.resolved_at, ad.decided_rating, ad.final_level,
                    s.name AS skill_name,
                    sa.self_rated_level, sr.supervisor_rated_level, sr.gap,
                    sa.superseded_at,
                    COALESCE(dec.first_name || ' ' || dec.last_name,
                             adme.first_name || ' ' || adme.last_name,
                             adm.username) AS decider_name
             FROM assessment_disputes ad
             JOIN supervisor_reviews sr ON sr.id = ad.supervisor_review_id
             LEFT JOIN self_assessment_rounds sa ON sa.id = sr.self_assessment_id
             LEFT JOIN skills s ON s.id = sr.skill_id
             LEFT JOIN employees dec ON dec.id = ad.decided_by
             LEFT JOIN admins adm ON adm.id = ad.decided_by_admin_id
             LEFT JOIN employees adme ON adme.id = adm.linked_employee_id
             WHERE ad.employee_id = ?
             ORDER BY ad.opened_at DESC`,
            [employeeId]
        );
        return rows.map((r) => Object.assign({}, r, DisputeServiceV2.splitReason(r.reason)));
    }

    static async escalateOverdueL0() {
        const days = await slaDays('dispute.l0SlaDays', 'DISPUTE_L0_SLA_DAYS', 5);
        const rows = await db.all(
            `UPDATE assessment_disputes
             SET level = 'L1', state = 'escalated', escalated_at = now()
             WHERE level = 'L0' AND state = 'open'
               AND opened_at < now() - (interval '1 day' * ?)
             RETURNING id, employee_id`,
            [days]
        );
        // Escalation was silent → defeats the SLA. Tell each subject's manager.
        for (const d of rows) {
            const mgr = await DisputeServiceV2._managerOf(
                Number(d.employeeId ?? d.employee_id)
            ).catch(() => null);
            if (mgr)
                await DisputeServiceV2._notify(mgr.userType, mgr.id, 'dispute.escalated', {
                    link: '/supervisor/self-assessment-reviews',
                });
        }
        return rows.length;
    }

    /** L1 overdue → escalate to L2 (HR arbitration). Measured from escalated_at. */
    static async escalateOverdueL1() {
        const days = await slaDays('dispute.l1SlaDays', 'DISPUTE_L1_SLA_DAYS', 7);
        const rows = await db.all(
            `UPDATE assessment_disputes
             SET level = 'L2', escalated_at = now()
             WHERE level = 'L1' AND state = 'escalated'
               AND escalated_at < now() - (interval '1 day' * ?)
             RETURNING id`,
            [days]
        );
        // Notify the HR arbitration audience ONCE per batch (not per row) to avoid
        // flooding: "N disputes need your arbitration".
        if (rows.length) {
            await DisputeServiceV2._notifyHr('dispute.escalated', {
                count: rows.length,
                link: '/dashboard',
            });
        }
        return rows.length;
    }

    /** Tell every HR arbiter (holder of arbitrate_disputes) the same thing. Best-effort. */
    static async _notifyHr(kind, payload = {}) {
        const hr = await DisputeServiceV2._hrAdmins().catch(() => []);
        for (const adminId of hr) {
            await DisputeServiceV2._notify('admin', adminId, kind, payload);
        }
        return hr.length;
    }

    /**
     * L2 overdue with no HR decision → auto-finalize each dispute with the
     * supervisor's rating so the cycle can close (gated by the setting). Done
     * per-row in a transaction so the supervisor_review + self_assessment are
     * finalised atomically and the outcome is audited.
     */
    static async autoFinalizeOverdueL2() {
        if (!(await autoFinalizeEnabled())) return 0;
        const days = await slaDays('dispute.l2SlaDays', 'DISPUTE_L2_SLA_DAYS', 7);
        const due = await db.all(
            `SELECT id FROM assessment_disputes
              WHERE level = 'L2' AND state IN ('escalated','open')
                AND escalated_at < now() - (interval '1 day' * ?)`,
            [days]
        );
        let n = 0;
        for (const d of due) {
            const done = await db.runTransaction(async () => {
                const row = await db.get(
                    `SELECT ad.supervisor_review_id, sr.supervisor_rated_level, ad.reason
                       FROM assessment_disputes ad
                       JOIN supervisor_reviews sr ON sr.id = ad.supervisor_review_id
                      WHERE ad.id = ?`,
                    [d.id]
                );
                if (!row) return false;
                const rating = row.supervisorRatedLevel;
                // NO MEASUREMENT TO FINALISE WITH. A rejected review carries a NULL
                // supervisor rating; "finalising" it wrote review 'completed' with
                // level null, dispute 'resolved', and told the employee a decision
                // had been taken — an absence of measurement presented as a
                // result (measured: {"status":"completed","lvl":null},
                // state 'auto_finalized', dispute.resolved notified). Such a
                // dispute can only be decided by a human: leave it at L2, raise it
                // to HR, and record the raise ON the row so the next tick does not
                // raise it again.
                if (rating === null || rating === undefined) {
                    if (String(row.reason || '').includes(HR_REQUIRED_MARK)) return false; // already raised
                    const { changes } = await db.run(
                        `UPDATE assessment_disputes
                            SET reason = COALESCE(reason, '') || ' ' || ?
                          WHERE id = ? AND level = 'L2' AND state IN ('escalated','open')`,
                        [HR_REQUIRED_MARK, d.id]
                    );
                    if (!changes) return false;
                    try {
                        await require('./LogService').log({
                            action: 'DISPUTE_HR_ARBITRATION_REQUIRED',
                            entityType: 'assessment_dispute',
                            entityId: d.id,
                            details: `L2 dispute ${d.id}: SLA lapsed but the review carries no supervisor rating — cannot auto-finalise, HR arbitration required`,
                        });
                    } catch (_) {
                        /* best-effort */
                    }
                    return 'hr_required';
                }
                // Guard on state+level: HR may have called resolveL2 between the SELECT
                // above and this transaction. Without the guard the tick would overwrite
                // a committed 'resolved' HR arbitration back to 'auto_finalized' and
                // clobber decided_by_admin_id/decided_rating. If it matched no row, the
                // dispute was already handled — skip the downstream finalisation + audit.
                const { changes } = await db.run(
                    `UPDATE assessment_disputes
                        SET state = 'auto_finalized', resolved_at = now(),
                            decided_rating = ?, final_level = 'L2',
                            reason = COALESCE(reason,'') || ' [auto-finalized: no HR decision within SLA]'
                      WHERE id = ? AND level = 'L2' AND state IN ('escalated','open')`,
                    [rating, d.id]
                );
                if (!changes) return false;
                // Same finalisation as a human decision: level, recomputed gap, completed.
                await DisputeServiceV2._applyDecisionToReview(row.supervisorReviewId, rating);
                // The finalized rating IS the supervisor's rating — flow it to the
                // official skill profile so readiness/9-box reflect the outcome.
                await DisputeServiceV2._applyDecidedRatingToSkill(
                    row.supervisorReviewId,
                    rating,
                    null,
                    d.id
                );
                await db.run(
                    `UPDATE self_assessment_rounds sa SET locked_state = 'finalized'
                       FROM supervisor_reviews sr
                      WHERE sr.id = ? AND sr.self_assessment_id = sa.id`,
                    [row.supervisorReviewId]
                );
                try {
                    await require('./LogService').log({
                        action: 'DISPUTE_AUTO_FINALIZED',
                        entityType: 'assessment_dispute',
                        entityId: d.id,
                        details: `L2 dispute ${d.id} auto-finalized with supervisor rating ${rating} (SLA lapsed, no HR arbitration)`,
                    });
                } catch (_) {
                    /* best-effort */
                }
                n++;
                return true;
            });
            if (done === 'hr_required') {
                // Raised once (the marker on the row stops a repeat), to whoever
                // holds arbitrate_disputes — the only people who can decide it.
                await DisputeServiceV2._notifyHr('dispute.escalated', {
                    count: 1,
                    hrArbitrationRequired: true,
                    link: '/v2/slf/disputes',
                });
                continue;
            }
            // The rating was finalized against the employee with NO HR decision —
            // they must be told (their contested rating is now official).
            if (done) {
                const eid = await DisputeServiceV2.employeeFor(d.id).catch(() => null);
                await DisputeServiceV2._notify('employee', eid, 'dispute.resolved', {
                    link: '/employee/assessment-status',
                });
            }
        }
        return n;
    }

    /** HR (admin w/ arbitrate_disputes) final decision at L2. */
    static async resolveL2({ disputeId, decidedByAdminId, decidedRating, reason }) {
        decidedRating = DisputeServiceV2._requireRating(decidedRating);
        DisputeServiceV2._requireReason(reason);
        return db
            .runTransaction(async () => {
                const { changes } = await db.run(
                    `UPDATE assessment_disputes
                    SET state = 'resolved', resolved_at = now(),
                        decided_by_admin_id = ?, decided_rating = ?, final_level = 'L2',
                        ${appendResolutionNote('L2')}
                  WHERE id = ? AND state IN ('escalated','open') AND level = 'L2'`,
                    [decidedByAdminId, decidedRating, reason, disputeId]
                );
                // Already auto-finalized by the SLA tick (or otherwise resolved) — don't
                // overwrite the supervisor review with a stale rating.
                if (!changes) return { resolved: false };
                const r = await db.get(
                    `SELECT supervisor_review_id FROM assessment_disputes WHERE id = ?`,
                    [disputeId]
                );
                if (r) {
                    await DisputeServiceV2._applyDecisionToReview(
                        r.supervisorReviewId,
                        decidedRating
                    );
                    await DisputeServiceV2._applyDecidedRatingToSkill(
                        r.supervisorReviewId,
                        decidedRating,
                        decidedByAdminId,
                        disputeId
                    );
                }
                await db.run(
                    `UPDATE self_assessment_rounds sa SET locked_state = 'finalized'
                   FROM supervisor_reviews sr
                  WHERE sr.id = (SELECT supervisor_review_id FROM assessment_disputes WHERE id = ?)
                    AND sr.self_assessment_id = sa.id`,
                    [disputeId]
                );
                return { resolved: true };
            })
            .then(async (res) => {
                // Tell the employee the outcome — the resolved rating is now official.
                if (res && res.resolved) {
                    const eid = await DisputeServiceV2.employeeFor(disputeId).catch(() => null);
                    await DisputeServiceV2._notify('employee', eid, 'dispute.resolved', {
                        link: '/employee/assessment-status',
                    });
                }
                return res;
            });
    }

    /** Site-manager (or HR-BP at site) final decision at L1. */
    /**
     * the rung ABOVE the supervisor. Nobody arbitrates their own rating.
     *
     * This accepted any `decidedBy`, and the route only asked for userType
     * 'manager' plus the employee being inside the caller's sub-tree — both of
     * which the CONTESTED supervisor satisfies. So a dispute opened against
     * supervisor S, escalated to L1 precisely because S had not answered, was
     * resolvable by S, with S's own rating, from their own queue. The step
     * above them was decided by them.
     *
     * The assessment workflow already refuses exactly this
     * (SelfAssessmentWorkflowService: "the very supervisor being arbitrated
     * could approve the escalation away themselves"); the ladder did not.
     *
     * The refusal lives HERE rather than only in the route: it is the place
     * that writes, so no caller — route, job or console — can reach around it.
     *
     * L0 deliberately keeps no such guard: that rung IS the supervisor
     * answering the dispute first-hand, which is the ladder working.
     */
    static async resolveL1({ disputeId, decidedBy, decidedRating, reason }) {
        decidedRating = DisputeServiceV2._requireRating(decidedRating);
        DisputeServiceV2._requireReason(reason);
        await DisputeServiceV2._refuseSelfArbitration(disputeId, decidedBy);
        return db
            .runTransaction(async () => {
                const { changes } = await db.run(
                    `UPDATE assessment_disputes
                 SET state = 'resolved', resolved_at = now(),
                     decided_by = ?, decided_rating = ?, final_level = 'L1',
                     ${appendResolutionNote('L1')}
                 WHERE id = ? AND state IN ('escalated','open') AND level = 'L1'`,
                    [decidedBy, decidedRating, reason, disputeId]
                );
                // Already resolved, or escalated past L1 to HR (level='L2') — do NOT write a
                // stale supervisor rating for a dispute this call no longer owns.
                if (!changes) return { resolved: false };
                // Apply the decided rating to the supervisor review row.
                const r = await db.get(
                    `SELECT supervisor_review_id FROM assessment_disputes WHERE id = ?`,
                    [disputeId]
                );
                if (r) {
                    await DisputeServiceV2._applyDecisionToReview(
                        r.supervisorReviewId,
                        decidedRating
                    );
                    await DisputeServiceV2._applyDecidedRatingToSkill(
                        r.supervisorReviewId,
                        decidedRating,
                        decidedBy,
                        disputeId
                    );
                }
                // Finalise the linked self-assessment row.
                await db.run(
                    `UPDATE self_assessment_rounds sa
                 SET locked_state = 'finalized'
                 FROM supervisor_reviews sr
                 WHERE sr.id = (SELECT supervisor_review_id FROM assessment_disputes WHERE id = ?)
                   AND sr.self_assessment_id = sa.id`,
                    [disputeId]
                );
                return { resolved: true };
            })
            .then(async (res) => {
                // Tell the employee the outcome — the resolved rating is now official.
                if (res && res.resolved) {
                    const eid = await DisputeServiceV2.employeeFor(disputeId).catch(() => null);
                    await DisputeServiceV2._notify('employee', eid, 'dispute.resolved', {
                        link: '/employee/assessment-status',
                    });
                }
                return res;
            });
    }

    /**
     * Refuse an L1 decision taken by the very person whose rating is disputed.
     *
     * Compares the caller against `supervisor_reviews.reviewed_by` — the person
     * who actually recorded the contested rating — not against the employee's
     * current supervisor, which can have changed since.
     */
    static async _refuseSelfArbitration(disputeId, decidedBy) {
        if (decidedBy == null) return;
        const row = await db.get(
            `SELECT sr.reviewed_by AS reviewed_by
               FROM assessment_disputes d
               JOIN supervisor_reviews sr ON sr.id = d.supervisor_review_id
              WHERE d.id = ?`,
            [Number(disputeId)]
        );
        if (!row || row.reviewedBy == null) return; // nothing recorded to compare against
        if (Number(row.reviewedBy) !== Number(decidedBy)) return;
        const e = new Error(
            'The supervisor whose rating is disputed cannot decide the escalation against it.'
        );
        e.status = 403;
        e.code = 'DISPUTE_SELF_REVIEW';
        e.expose = true;
        e.i18n = { key: 'talentx:dsp_err_self_arbitration' };
        throw e;
    }

    /** L0 resolution by the supervisor (without escalation). */
    static async resolveL0({ disputeId, decidedBy, decidedRating, reason }) {
        decidedRating = DisputeServiceV2._requireRating(decidedRating);
        DisputeServiceV2._requireReason(reason);
        return db
            .runTransaction(async () => {
                const { changes } = await db.run(
                    `UPDATE assessment_disputes
                 SET state = 'resolved', resolved_at = now(),
                     decided_by = ?, decided_rating = ?, final_level = 'L0',
                     ${appendResolutionNote('L0')}
                 WHERE id = ? AND state = 'open' AND level = 'L0'`,
                    [decidedBy, decidedRating, reason, disputeId]
                );
                // Already escalated (level!=L0) or resolved — don't write a stale rating.
                if (!changes) return { resolved: false };
                const r = await db.get(
                    `SELECT supervisor_review_id FROM assessment_disputes WHERE id = ?`,
                    [disputeId]
                );
                if (r) {
                    // Was the ONLY resolve path that left status='disputed' (no
                    // 'completed'), so an L0 resolution never cleared the V1 console
                    // queue and the employee page kept the "Contestée" badge for ever.
                    await DisputeServiceV2._applyDecisionToReview(
                        r.supervisorReviewId,
                        decidedRating
                    );
                    await DisputeServiceV2._applyDecidedRatingToSkill(
                        r.supervisorReviewId,
                        decidedRating,
                        decidedBy,
                        disputeId
                    );
                }
                await db.run(
                    `UPDATE self_assessment_rounds sa
                 SET locked_state = 'finalized'
                 FROM supervisor_reviews sr
                 WHERE sr.id = (SELECT supervisor_review_id FROM assessment_disputes WHERE id = ?)
                   AND sr.self_assessment_id = sa.id`,
                    [disputeId]
                );
                return { resolved: true };
            })
            .then(async (res) => {
                // Tell the employee the outcome — the resolved rating is now official.
                if (res && res.resolved) {
                    const eid = await DisputeServiceV2.employeeFor(disputeId).catch(() => null);
                    await DisputeServiceV2._notify('employee', eid, 'dispute.resolved', {
                        link: '/employee/assessment-status',
                    });
                }
                return res;
            });
    }

    // ---- Notifications (accountability: the dispute ladder was notification-dark) --
    // Best-effort, never block the dispute transaction. category 'disputes' → email
    // ON (time-sensitive, decides an official rating).
    static async _notify(userType, userId, kind, payload = {}) {
        if (!userId) return;
        try {
            await require('./NotificationService')
                .notify({ userType, userId: Number(userId), kind, category: 'disputes', payload })
                .catch(() => {});
        } catch (_) {
            /* never block */
        }
    }

    /** The reviewing supervisor (employee) for a supervisor_review row. */
    static async _reviewerOf(supervisorReviewId) {
        const r = await db
            .get('SELECT reviewed_by FROM supervisor_reviews WHERE id = ?', [supervisorReviewId])
            .catch(() => null);
        return r ? Number(r.reviewedBy ?? r.reviewed_by) || null : null;
    }

    /**
     * The subject's ACTIVE manager — employee OR admin (polymorphic manager_id)
     * — for L1 escalation: the manager alone arbitrates. 3.23.18 R2: an
     * admin-typed manager used to be dropped (the escalation reached nobody)
     * and a departed manager was still addressed.
     * @returns {Promise<{userType:'employee'|'admin', id:number}|null>}
     */
    static async _managerOf(employeeId) {
        const m = await require('./ReportingLineService')
            .managerOf(employeeId)
            .catch(() => null);
        return m && m.id ? { userType: m.type, id: Number(m.id) } : null;
    }

    /**
     * HR arbitration audience for L2 = whoever holds `arbitrate_disputes`. HR can be
     * a SuperAdmin OR a scoped local admin depending on clearance, so resolve via
     * the permission (not a hard-coded role).
     */
    static async _hrAdmins() {
        try {
            return await require('./RBACService').adminsWithPermission('arbitrate_disputes');
        } catch (_) {
            return [];
        }
    }
}

module.exports = DisputeServiceV2;
