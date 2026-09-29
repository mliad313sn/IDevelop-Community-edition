/**
 * PostApprovalReviewService — a supervisor's second look at a score that has
 * ALREADY been approved.
 *
 * The rule that defines this module: a score approved by a manager (or an
 * admin) can only be changed by an ADMIN. A supervisor may raise the case and
 * argue it, but never decide it — otherwise the approval step would mean
 * nothing. The database enforces the same rule (chk_decision_needs_admin), so
 * this service is the convenient path, not the only guard.
 */
const db = require('../config/database');
const { scopedEmployeeIds } = require('../utils/rbacScope');
const { isSamePerson, personIdOf } = require('../utils/personIdentity');
const LogService = require('./LogService');

const OPEN_STATE = 'pending';

// Catalogue-driven, not role-shape: deciding a post-approval re-review changes an
// employee's OFFICIAL skill level, so it requires the approve_assessments grant.
// (The old OR-over-role-names admitted read-only Viewers and the dead `hr_bp`.)
function isAdmin(user) {
    return require('./RBACService').hasPermission(user, 'approve_assessments');
}

const PostApprovalReviewService = {
    /**
     * Raise a re-review against an approved self-assessment.
     * Refuses when: the assessment is not approved, the raiser does not govern
     * the employee, or a contest is already pending on the same row.
     */
    async raise(user, { selfAssessmentId, proposedLevel, reason }) {
        // Proficiency scale is 0..4 across self_assessments, skill_assessments
        // and supervisor_reviews — a wider range here would create a case that
        // cannot be applied when an admin approves it.
        const level = parseInt(proposedLevel, 10);
        if (!Number.isFinite(level) || level < 0 || level > 4) {
            const e = new Error('proposed_level_invalid');
            e.userMessage = 'invalid_level';
            throw e;
        }
        if (!reason || !String(reason).trim()) {
            const e = new Error('reason_required');
            e.userMessage = 'reason_required';
            throw e;
        }

        const sa = await db.get(
            `SELECT sa.id, sa.employee_id AS "employeeId", sa.skill_id AS "skillId",
                    sa.status::text AS "status", sa.workflow_state AS "workflowState"
             FROM self_assessments sa WHERE sa.id = ?`,
            [selfAssessmentId]
        );
        if (!sa) {
            const e = new Error('not_found');
            e.userMessage = 'not_found';
            throw e;
        }

        // Only an APPROVED score can be re-reviewed — anything earlier still has
        // its normal review/dispute route and must go through that instead.
        const approved = sa.status === 'approved' || sa.workflowState === 'approved';
        if (!approved) {
            const e = new Error('not_approved_yet');
            e.userMessage = 'not_approved_yet';
            throw e;
        }

        // Scope: the raiser must actually govern this person (admins included).
        const ids = await scopedEmployeeIds(user);
        if (Array.isArray(ids) && !ids.includes(Number(sa.employeeId))) {
            const e = new Error('out_of_scope');
            e.userMessage = 'out_of_scope';
            throw e;
        }

        const current = await db.get(
            `SELECT supervisor_rated_level AS "level" FROM supervisor_reviews
             WHERE self_assessment_id = ? ORDER BY id DESC LIMIT 1`,
            [selfAssessmentId]
        );

        const existing = await db.get(
            'SELECT id FROM post_approval_reviews WHERE self_assessment_id = ? AND state = ?',
            [selfAssessmentId, OPEN_STATE]
        );
        if (existing) {
            const e = new Error('already_pending');
            e.userMessage = 'already_pending';
            throw e;
        }

        const raisedByEmployee =
            user.userType === 'employee' || user.userType === 'manager' ? user.id : null;
        const raisedByAdmin = isAdmin(user) ? user.id : null;

        const row = await db.run(
            `INSERT INTO post_approval_reviews
                (self_assessment_id, employee_id, skill_id, approved_level, proposed_level,
                 reason, raised_by, raised_by_admin_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                selfAssessmentId,
                sa.employeeId,
                sa.skillId,
                current ? current.level : null,
                level,
                String(reason).trim().slice(0, 2000),
                raisedByEmployee,
                raisedByAdmin,
            ]
        );

        await LogService.log({
            adminId: raisedByAdmin,
            action: 'POST_APPROVAL_REVIEW_RAISED',
            entityType: 'self_assessment',
            entityId: Number(selfAssessmentId),
            details: JSON.stringify({
                proposedLevel: level,
                approvedLevel: current ? current.level : null,
            }),
        });
        return row;
    },

    /**
     * Decide a pending re-review. ADMIN ONLY — a manager or supervisor is
     * refused here even if they govern the employee, because the score they
     * would be overturning already carries an approval.
     * On approval the confirmed supervisor level is rewritten to the proposed one.
     */
    async decide(user, id, approve, note) {
        if (!isAdmin(user)) {
            const e = new Error('admin_only');
            e.userMessage = 'admin_only';
            throw e;
        }

        const pr = await db.get(
            `SELECT id, self_assessment_id AS "selfAssessmentId", employee_id AS "employeeId",
                    skill_id AS "skillId", proposed_level AS "proposedLevel", state::text AS "state",
                    raised_by AS "raisedBy", raised_by_admin_id AS "raisedByAdmin"
             FROM post_approval_reviews WHERE id = ?`,
            [id]
        );
        if (!pr) {
            const e = new Error('not_found');
            e.userMessage = 'not_found';
            throw e;
        }
        if (pr.state !== OPEN_STATE) {
            const e = new Error('already_decided');
            e.userMessage = 'already_decided';
            throw e;
        }

        // Two-person rule, by PERSON (3.23.17, B-3): the raiser — through either
        // of their accounts (admins.linked_employee_id) — never decides their own
        // case, and nobody decides a re-review of their own score.
        // decide is admin-only, so the decider's person is its linked employee
        // (one lookup) — compared with the raiser AND with the subject.
        const me = await personIdOf(user);
        if (
            (pr.raisedByAdmin != null &&
                (await isSamePerson(user, { adminId: pr.raisedByAdmin }))) ||
            (pr.raisedBy != null && me != null && me === Number(pr.raisedBy))
        ) {
            const e = new Error('raiser_cannot_decide');
            e.userMessage = 'raiser_cannot_decide';
            throw e;
        }
        if (me != null && me === Number(pr.employeeId)) {
            const e = new Error('own_assessment');
            e.userMessage = 'own_assessment';
            throw e;
        }

        const ids = await scopedEmployeeIds(user);
        if (Array.isArray(ids) && !ids.includes(Number(pr.employeeId))) {
            const e = new Error('out_of_scope');
            e.userMessage = 'out_of_scope';
            throw e;
        }

        await db.runTransaction(async () => {
            await db.run(
                `UPDATE post_approval_reviews
                 SET state = ?, decided_by_admin_id = ?, decided_at = now(), decision_note = ?
                 WHERE id = ? AND state = ?`,
                [
                    approve ? 'approved' : 'rejected',
                    user.id,
                    note ? String(note).trim().slice(0, 2000) : null,
                    id,
                    OPEN_STATE,
                ]
            );

            if (approve) {
                // The admin's decision becomes the confirmed level.
                await db.run(
                    `UPDATE supervisor_reviews SET supervisor_rated_level = ?
                     WHERE self_assessment_id = ?`,
                    [pr.proposedLevel, pr.selfAssessmentId]
                );
            }
        });

        await LogService.log({
            adminId: user.id,
            action: approve ? 'POST_APPROVAL_REVIEW_APPROVED' : 'POST_APPROVAL_REVIEW_REJECTED',
            entityType: 'self_assessment',
            entityId: Number(pr.selfAssessmentId),
            details: JSON.stringify({
                postReviewId: Number(id),
                newLevel: approve ? pr.proposedLevel : null,
            }),
        });
        return true;
    },

    /**
     * The raiser may withdraw their own pending case; otherwise only an admin
     * holding approve_assessments whose scope covers the employee — the same
     * test decide applies (an admin who could not decide the case must not be
     * able to make it disappear either).
     */
    async withdraw(user, id) {
        const pr = await db.get(
            'SELECT id, employee_id AS "employeeId", raised_by AS "raisedBy", raised_by_admin_id AS "raisedByAdmin", state::text AS "state" FROM post_approval_reviews WHERE id = ?',
            [id]
        );
        if (!pr) {
            const e = new Error('not_found');
            e.userMessage = 'not_found';
            throw e;
        }
        if (pr.state !== OPEN_STATE) {
            const e = new Error('already_decided');
            e.userMessage = 'already_decided';
            throw e;
        }
        const mine =
            (pr.raisedBy && Number(pr.raisedBy) === Number(user.id) && user.userType !== 'admin') ||
            (pr.raisedByAdmin &&
                Number(pr.raisedByAdmin) === Number(user.id) &&
                user.userType === 'admin');
        if (!mine) {
            if (!isAdmin(user)) {
                const e = new Error('not_yours');
                e.userMessage = 'not_yours';
                throw e;
            }
            const ids = await scopedEmployeeIds(user);
            if (Array.isArray(ids) && !ids.includes(Number(pr.employeeId))) {
                const e = new Error('out_of_scope');
                e.userMessage = 'out_of_scope';
                throw e;
            }
        }
        await db.run(
            "UPDATE post_approval_reviews SET state = 'withdrawn' WHERE id = ? AND state = ?",
            [id, OPEN_STATE]
        );
        return true;
    },

    /** Queue for the console — scoped, newest first. */
    async list(user, opts = {}) {
        const ids = await scopedEmployeeIds(user);
        if (Array.isArray(ids) && ids.length === 0) return [];
        const where = [];
        const params = [];
        if (Array.isArray(ids)) {
            where.push(`q.employee_id IN (${ids.map(() => '?').join(',')})`);
            params.push(...ids);
        }
        if (opts.state) {
            where.push('q.state = ?');
            params.push(opts.state);
        }
        const sql = `SELECT q.id, q.state::text AS "state", q.reason, q.decision_note AS "decisionNote",
                            q.approved_level AS "approvedLevel", q.proposed_level AS "proposedLevel",
                            q.raised_at AS "raisedAt", q.decided_at AS "decidedAt",
                            q.employee_id AS "employeeId", q.employee_name AS "employeeName",
                            q.employee_number AS "employeeNumber", q.site_name AS "siteName",
                            q.department_name AS "departmentName", q.skill_name AS "skillName",
                            q.raised_by_name AS "raisedByName", q.decided_by_name AS "decidedByName"
                     FROM v_post_approval_queue q
                     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                     ORDER BY (q.state = 'pending') DESC, q.raised_at DESC
                     LIMIT 300`;
        return db.all(sql, params);
    },

    async pendingCount(user) {
        const rows = await this.list(user, { state: OPEN_STATE });
        return rows.length;
    },
};

module.exports = PostApprovalReviewService;
