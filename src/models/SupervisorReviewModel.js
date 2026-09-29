const BaseModel = require('./BaseModel');
const db = require('../config/database');

/**
 * A REVIEW BELONGS TO THE ROUND IT JUDGED.
 *
 * Since migration 113 `self_assessments` is no longer a table but a VIEW:
 *     SELECT … FROM self_assessment_rounds WHERE superseded_at IS NULL
 * i.e. the CURRENT measurement of each (employee, skill). Every query below
 * joins the self-assessment through `sr.selfAssessmentId = sa.id`, and
 * `supervisor_reviews.self_assessment_id` is a foreign key onto ONE ROUND —
 * never onto "whatever the current round happens to be". Joining the view
 * therefore DROPPED (INNER JOIN) or BLANKED (LEFT JOIN) every review the
 * moment the person was asked again by a new campaign:
 *
 *   measured on a development database, review 1023 / round 223929
 *   (superseded 2026-09-13, self_rated_level = 3):
 *     findForReviewer(supervisor 136)   → 0 rows          (the review vanished)
 *     findByEmployeeId(138)             → 0 rows          (so did the employee's
 *                                                          only "Contester" button)
 *     findByIdWithSkill(1023)           → selfRatedLevel null, notes null
 *                                         → the page printed "—" and then the
 *                                           gap script fell back to ZERO, so a
 *                                           reviewer entering 3 was told the
 *                                           gap was +3 when it was 0.
 *   and the same review could never be completed again (TypeError → HTTP 500).
 *
 * Every join here therefore addresses `self_assessment_rounds`, the table. The
 * join key is that table's PRIMARY KEY, so no row can fan out into duplicates.
 * `supersededAt` is carried on the reads that feed a screen, so a surface can
 * say "this round was replaced on …" instead of silently showing nothing —
 * the house rule is that nothing disappears, it changes state.
 *
 * What deliberately KEEPS reading the view lives elsewhere: a queue of
 * measurements to take or to approve (SelfAssessmentWorkflowService.reviewQueue,
 * bulkApproveForEmployee, completionStats) means "the current round" and must
 * not resurrect history.
 */
class SupervisorReviewModel extends BaseModel {
    constructor() {
        super('supervisorReviews');
    }

    async findByEmployeeId(employeeId) {
        return await db.all(
            `
            SELECT sr.*,
                   sa.selfRatedLevel,
                   sa.superseded_at,
                   s.name as skillName,
                   d.name as domainName,
                   e.firstName || ' ' || e.lastName as employeeName,
                   sup.firstName || ' ' || sup.lastName as supervisorName
            FROM supervisorReviews sr
            INNER JOIN self_assessment_rounds sa ON sr.selfAssessmentId = sa.id
            INNER JOIN employees e ON sr.employeeId = e.id
            INNER JOIN employees sup ON sr.reviewedBy = sup.id
            INNER JOIN skills s ON sr.skillId = s.id
            INNER JOIN domains d ON s.domainId = d.id
            WHERE sr.employeeId = ?
            ORDER BY sr.reviewedAt DESC
        `,
            [employeeId]
        );
    }

    async findBySupervisorId(supervisorId) {
        return await db.all(
            `
            SELECT sr.*,
                   sa.selfRatedLevel,
                   sa.superseded_at,
                   s.name as skillName,
                   d.name as domainName,
                   e.firstName || ' ' || e.lastName as employeeName,
                   e.employeeNumber
            FROM supervisorReviews sr
            INNER JOIN self_assessment_rounds sa ON sr.selfAssessmentId = sa.id
            INNER JOIN employees e ON sr.employeeId = e.id
            INNER JOIN skills s ON sr.skillId = s.id
            INNER JOIN domains d ON s.domainId = d.id
            WHERE sr.reviewedBy = ?
            ORDER BY sr.reviewedAt DESC
        `,
            [supervisorId]
        );
    }

    async findBySelfAssessmentId(selfAssessmentId) {
        return await db.get(
            `
            SELECT sr.*,
                   sa.selfRatedLevel,
                   sa.notes as selfAssessmentNotes,
                   sa.superseded_at,
                   s.name as skillName,
                   d.name as domainName
            FROM supervisorReviews sr
            INNER JOIN self_assessment_rounds sa ON sr.selfAssessmentId = sa.id
            INNER JOIN skills s ON sr.skillId = s.id
            INNER JOIN domains d ON s.domainId = d.id
            WHERE sr.selfAssessmentId = ?
        `,
            [selfAssessmentId]
        );
    }

    // Joined single-review lookup by supervisor_review id — carries skillName/
    // domainName (and the self-rating) so the review detail page isn't blank.
    // Uses a LEFT JOIN on the self-assessment so a review whose linked round is
    // missing still returns (skill/domain populated, self fields null) instead of
    // vanishing and rendering an empty page. The join is on the ROUNDS TABLE: on
    // the view it degraded to exactly that "missing" case for every replaced
    // round, which is how a measurement of 3 came to be rendered as a gap
    // computed against 0.
    async findByIdWithSkill(id) {
        return await db.get(
            `
            SELECT sr.*,
                   sa.selfRatedLevel,
                   sa.notes as selfAssessmentNotes,
                   sa.superseded_at,
                   sa.superseded_by,
                   s.name as skillName,
                   d.name as domainName
            FROM supervisorReviews sr
            LEFT JOIN self_assessment_rounds sa ON sr.selfAssessmentId = sa.id
            INNER JOIN skills s ON sr.skillId = s.id
            INNER JOIN domains d ON s.domainId = d.id
            WHERE sr.id = ?
        `,
            [id]
        );
    }

    /**
     * TEAM-WIDE review visibility.
     *
     * findBySupervisorId/findPendingReviews filter on `reviewedBy = me`, so a
     * supervisor only ever saw the rows assigned to them personally: a review
     * approved by a colleague, by a delegate or by an admin was invisible to
     * the person actually accountable for that employee. This returns every
     * review of everyone the caller is responsible for, WHOEVER performed it —
     * including the people covered only through an admin scope (see
     * GovernanceService), so nothing dead-ends.
     *
     * `firstName`/`lastName` are carried alongside `employeeName` because
     * views/pages/supervisor/reviews.ejs renders `r.firstName + ' ' +
     * r.lastName`, which this projection never provided: the pending queue drew
     * an EMPTY name cell beside a real review (measured over HTTP on a
     * development database). Additive — `employeeName` is untouched.
     *
     * @param opts.pendingOnly  only rows still awaiting a decision
     * @param opts.limit        default 500
     */
    async findForReviewer(user, opts = {}) {
        const GovernanceService = require('../services/GovernanceService');
        const ids = await GovernanceService.reviewableEmployeeIds(user);
        if (Array.isArray(ids) && ids.length === 0) return [];

        const where = [];
        const params = [];
        if (Array.isArray(ids)) {
            where.push(`sr.employeeId IN (${ids.map(() => '?').join(',')})`);
            params.push(...ids);
        }
        if (opts.pendingOnly) where.push("sr.status = 'pending'");
        const limit = Number.isFinite(Number(opts.limit)) ? Number(opts.limit) : 500;

        return await db.all(
            `
            SELECT sr.*,
                   sa.selfRatedLevel,
                   sa.submittedAt,
                   sa.superseded_at,
                   s.name as skillName,
                   d.name as domainName,
                   e.firstName || ' ' || e.lastName as employeeName,
                   e.firstName, e.lastName,
                   e.employeeNumber,
                   rev.firstName || ' ' || rev.lastName as reviewerName,
                   CASE WHEN sr.reviewedBy = ? THEN 1 ELSE 0 END as isMine
            FROM supervisorReviews sr
            INNER JOIN self_assessment_rounds sa ON sr.selfAssessmentId = sa.id
            INNER JOIN employees e ON sr.employeeId = e.id
            INNER JOIN skills s ON sr.skillId = s.id
            INNER JOIN domains d ON s.domainId = d.id
            LEFT JOIN employees rev ON rev.id = sr.reviewedBy
            ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
            ORDER BY sr.status ASC, sa.submittedAt ASC
            LIMIT ${limit}
        `,
            [user && user.id, ...params]
        );
    }

    async findPendingReviews(supervisorId) {
        return await db.all(
            `
            SELECT sr.*,
                   sa.selfRatedLevel,
                   sa.submittedAt,
                   sa.superseded_at,
                   s.name as skillName,
                   d.name as domainName,
                   e.firstName || ' ' || e.lastName as employeeName,
                   e.employeeNumber
            FROM supervisorReviews sr
            INNER JOIN self_assessment_rounds sa ON sr.selfAssessmentId = sa.id
            INNER JOIN employees e ON sr.employeeId = e.id
            INNER JOIN skills s ON sr.skillId = s.id
            INNER JOIN domains d ON s.domainId = d.id
            WHERE sr.reviewedBy = ? AND sr.status = 'pending'
            ORDER BY sa.submittedAt ASC
        `,
            [supervisorId]
        );
    }

    async findAll(conditions = {}) {
        let sql = `
            SELECT sr.*,
                   sa.selfRatedLevel,
                   sa.superseded_at,
                   s.name as skillName,
                   d.name as domainName,
                   e.firstName || ' ' || e.lastName as employeeName
            FROM supervisorReviews sr
            INNER JOIN self_assessment_rounds sa ON sr.selfAssessmentId = sa.id
            INNER JOIN employees e ON sr.employeeId = e.id
            INNER JOIN skills s ON sr.skillId = s.id
            INNER JOIN domains d ON s.domainId = d.id
        `;
        const params = [];
        const conditionsList = [];

        if (Object.keys(conditions).length > 0) {
            Object.keys(conditions).forEach((key) => {
                BaseModel._assertCol(key); // reject non-identifier keys → no column-name injection
                conditionsList.push(`sr.${key} = ?`);
                params.push(conditions[key]);
            });
            sql += ` WHERE ${conditionsList.join(' AND ')}`;
        }

        sql += ` ORDER BY sr.reviewedAt DESC`;

        return await db.all(sql, params);
    }
}

module.exports = new SupervisorReviewModel();
