const SupervisorReviewModel = require('../models/SupervisorReviewModel');
const SelfAssessmentModel = require('../models/SelfAssessmentModel');
const EmployeeModel = require('../models/EmployeeModel');
const SelfAssessmentService = require('../services/SelfAssessmentService');

/**
 * Route identifier → positive integer, or null.
 *
 * `parseInt('abc')` is NaN, and NaN reaching a bigint column made PostgreSQL
 * answer `invalid input syntax for type bigint: "NaN"` — a 500 whose text told
 * the caller the column type. Every id used here goes through this first.
 */
function toId(raw) {
    const n = Number(String(raw ?? '').trim());
    return Number.isInteger(n) && n > 0 ? n : null;
}

class SupervisorReviewController {
    async index(req, res) {
        try {
            // Team-wide, not "assigned to me": a supervisor or manager must see
            // every review of their staff whoever performed it — including
            // people covered only through an admin scope. Rows carry isMine and
            // reviewerName so the page can still show who acted.
            const pendingReviews = await SupervisorReviewModel.findForReviewer(req.user, {
                pendingOnly: true,
            });
            const allReviews = await SupervisorReviewModel.findForReviewer(req.user, {
                limit: 200,
            });

            res.render('pages/supervisor/reviews', {
                title: req.t ? req.t('chrome:pt_supervisor_reviews') : 'Supervisor Reviews',
                pendingReviews,
                allReviews: allReviews.slice(0, 20),
            });
        } catch (error) {
            console.error('Supervisor reviews error:', error);
            req.flash(
                'error',
                req.t ? req.t('flash:review_list_load_error') : 'Error loading supervisor reviews'
            );
            res.redirect('/employees');
        }
    }

    async review(req, res, next) {
        try {
            // A malformed id is a mis-typed URL, not a server fault: hand a
            // status-tagged Error to the shared error middleware so the styled
            // error page renders (HTML) instead of a naked JSON blob. The route
            // also guards this (requireNumericParam) — this is the second line.
            const reviewId = toId(req.params.reviewId);
            if (reviewId === null) {
                const e = new Error(
                    req.t ? req.t('flash:invalid_identifier') : 'Identifiant invalide'
                );
                e.status = 404;
                e.expose = true;
                return typeof next === 'function' ? next(e) : res.status(404).end();
            }
            // reviewId could be either supervisorReview.id or selfAssessmentId.
            // Use the joined lookups so skillName/domainName populate the detail page
            // (the plain findById returned no joins → blank "Skill:" / "Domain:").
            let review = await SupervisorReviewModel.findByIdWithSkill(reviewId);

            // If not found, try as selfAssessmentId
            if (!review) {
                review = await SupervisorReviewModel.findBySelfAssessmentId(reviewId);
            }

            if (!review) {
                req.flash('error', req.t ? req.t('flash:review_not_found') : 'Review not found');
                return res.redirect('/supervisor/reviews');
            }

            // Access follows the REPORTING LINE, not the assignment: a supervisor
            // or manager may open any review of their own staff whoever performed
            // it, and a local admin may open reviews of the people their scope
            // covers. Previously only the originally assigned reviewer could get
            // in, which hid a colleague's or a delegate's decision from the person
            // actually accountable for that employee.
            const GovernanceService = require('../services/GovernanceService');
            if (!(await GovernanceService.canReview(req.user, review.employeeId))) {
                req.flash('error', req.t ? req.t('flash:access_denied') : 'Access denied');
                return res.redirect('/supervisor/reviews');
            }

            const employee = await EmployeeModel.findByIdWithOrganization(review.employeeId);
            // Get self-assessment using BaseModel's findById
            const selfAssessment = review.selfAssessmentId
                ? await SelfAssessmentModel.findById(review.selfAssessmentId)
                : null;

            // 3.23.21: what the skill and its levels mean, plus the level the
            // person's role requires — best-effort, never fails the review page.
            let skillHelp = null;
            let requiredLevel = null;
            try {
                if (review.skillId != null) {
                    const map = await require('../services/SkillHelpService').forSkills([
                        review.skillId,
                    ]);
                    skillHelp = map.get(String(review.skillId)) || null;
                    if (employee && employee.roleId != null) {
                        const rsr =
                            await require('../models/RoleSkillRequirementModel').findByRoleIdAndSkillId(
                                employee.roleId,
                                review.skillId
                            );
                        requiredLevel =
                            rsr && rsr.requiredLevel != null ? Number(rsr.requiredLevel) : null;
                    }
                }
            } catch (e) {
                console.error('Review skill help:', e.message);
            }

            res.render('pages/supervisor/review', {
                title: req.t ? req.t('chrome:pt_review_self_assessment') : 'Review Self-Assessment',
                review,
                employee,
                selfAssessment,
                skillHelp,
                requiredLevel,
            });
        } catch (error) {
            console.error('Review error:', error);
            req.flash('error', req.t ? req.t('flash:review_load_error') : 'Error loading review');
            res.redirect('/supervisor/reviews');
        }
    }

    async completeReview(req, res) {
        try {
            const { supervisorRatedLevel, gapReason, supervisorNotes } = req.body;

            // JSON endpoint: a malformed id is the caller's fault (400), and must
            // be rejected BEFORE the bigint query that would otherwise surface the
            // driver's "invalid input syntax for type bigint" text as a 500.
            const reviewId = toId(req.params.reviewId);
            if (reviewId === null) {
                return res.status(400).json({
                    error: req.t ? req.t('flash:invalid_identifier') : 'Identifiant invalide',
                });
            }
            const level = Number(supervisorRatedLevel);
            if (!Number.isInteger(level)) {
                return res.status(400).json({
                    error: req.t ? req.t('flash:invalid_identifier') : 'Identifiant invalide',
                });
            }

            // reviewId is actually the supervisorReview id
            const review = await SupervisorReviewModel.findById(reviewId);
            if (!review) {
                return res.status(404).json({ error: 'Review not found' });
            }

            // Same reporting-line rule as opening the review: whoever is
            // accountable for this employee may complete it, not only the person
            // it was originally assigned to.
            const GovernanceService = require('../services/GovernanceService');
            if (!(await GovernanceService.canReview(req.user, review.employeeId))) {
                return res.status(403).json({ error: 'Access denied' });
            }

            await SelfAssessmentService.completeSupervisorReview(
                reviewId,
                level,
                gapReason || null,
                supervisorNotes || null,
                req
            );

            res.json({
                success: true,
                message: 'Review completed successfully',
            });
        } catch (error) {
            console.error('Complete review error:', error);
            // Don't leak raw DB/driver messages to the supervisor's alert.
            res.status(500).json({ error: 'Could not complete the review. Please try again.' });
        }
    }

    /**
     * Gaps against the ROLE's required levels, for everyone this person governs.
     *
     * This page used to be built from `supervisor_reviews` — i.e. from review
     * PAPERWORK — while telling the manager it measured "par rapport aux niveaux
     * requis de chaque rôle". Where no review row existed, no gap existed. On a
     * 16-person team that read as **1 employee with 2 gaps**, against a real
     * **14 employees with 90 unmet requirements**. Absence of review was being
     * reported as absence of gap, on the manager's primary decision page, and
     * `/reports/gaps` and `/api/dashboard/skill-gaps` disagreed with it.
     *
     * It now reads `v_employee_skill_gaps`, the same source as those two, so the
     * three agree. A GAP is a MEASURED shortfall (`is_assessed = 1`); never-
     * assessed requirements are counted and shown separately, because "not
     * measured" is a different instruction to a manager than "below target" —
     * and the view coalesces an absent level to 0, so counting them as gaps
     * would invent shortfalls nobody observed.
     */
    async viewGapAnalysis(req, res) {
        try {
            const { scopedEmployeeIds } = require('../utils/rbacScope');
            const db = require('../config/database');
            const ids = await scopedEmployeeIds(req.user);

            let rows = [];
            if (ids === null || (Array.isArray(ids) && ids.length)) {
                const params = [];
                let scope = '';
                if (Array.isArray(ids)) {
                    scope = ` AND g.employee_id IN (${ids.map(() => '?').join(',')})`;
                    params.push(...ids);
                }
                rows = await db.all(
                    `SELECT g.employee_id AS "employeeId",
                            e.full_name   AS "employeeName",
                            COUNT(*) FILTER (WHERE g.is_assessed = 1 AND g.gap > 0)::int AS "totalGaps",
                            COUNT(*) FILTER (WHERE g.is_assessed = 1 AND g.gap > 0 AND g.is_critical)::int AS "criticalGaps",
                            COUNT(*) FILTER (WHERE g.is_assessed = 0)::int AS "unmeasured"
                       FROM v_employee_skill_gaps g
                       JOIN v_employee_details e ON e.employee_id = g.employee_id
                      WHERE 1 = 1${scope}
                      GROUP BY g.employee_id, e.full_name
                     HAVING COUNT(*) FILTER (WHERE g.is_assessed = 1 AND g.gap > 0) > 0
                         OR COUNT(*) FILTER (WHERE g.is_assessed = 0) > 0
                      ORDER BY "criticalGaps" DESC, "totalGaps" DESC, e.full_name`,
                    params
                );
            }

            res.render('pages/supervisor/gap-analysis', {
                title: req.t ? req.t('chrome:pt_gap_analysis') : 'Gap Analysis',
                gapAnalysis: rows,
            });
        } catch (error) {
            console.error('Gap analysis error:', error);
            req.flash(
                'error',
                req.t ? req.t('flash:gap_load_error') : 'Error loading gap analysis'
            );
            res.redirect('/supervisor/reviews');
        }
    }
}

module.exports = new SupervisorReviewController();
