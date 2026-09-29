const db = require('../config/database');
const SkillAssessmentModel = require('../models/SkillAssessmentModel');
const LogService = require('./LogService');
const { dashboardCache } = require('../utils/ttlCache');

class SkillAssessmentService {
    /**
     * @param {object} [opts]
     * @param {boolean} [opts.bustCache=true] set false when the CALLER will
     *        invalidate once for a whole batch — see bulkUpdateAssessments.
     */
    async updateAssessment(
        employeeId,
        skillId,
        currentLevel,
        assessedBy,
        notes = null,
        req = null,
        { bustCache = true } = {}
    ) {
        // Get previous level (for the audit-log message only).
        const previous = await SkillAssessmentModel.findByEmployeeIdAndSkillId(employeeId, skillId);
        const previousLevel = previous ? previous.currentLevel : null;

        // NOTE: skill-evolution history is captured automatically by the DB
        // trigger `trg_skill_assessment_history` on every level change — writing
        // assessment_history here too would double-log.

        // Upsert the assessment
        const assessment = await SkillAssessmentModel.upsert({
            employeeId,
            skillId,
            currentLevel,
            assessedBy,
            notes,
        });

        // Log the action
        if (req) {
            await LogService.log({
                adminId: assessedBy,
                action: 'ASSESSMENT_UPDATED',
                entityType: 'skillAssessment',
                entityId: assessment.id,
                details: `Employee ${employeeId}, Skill ${skillId}: ${previousLevel || 'N/A'} → ${currentLevel}`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
        }

        // Dashboard aggregates are derived from assessments — drop the cache.
        if (bustCache) dashboardCache.bust();

        return assessment;
    }

    async bulkUpdateAssessments(employeeId, assessments, assessedBy, req = null) {
        // All-or-nothing: assessment_history is append-only/immutable, so a
        // partial failure must not leave a half-written, uncorrectable state.
        const results = await db.runTransaction(async () => {
            const out = [];
            for (const assessment of assessments) {
                const result = await this.updateAssessment(
                    employeeId,
                    assessment.skillId,
                    assessment.currentLevel,
                    assessedBy,
                    assessment.notes || null,
                    req,
                    // ONE invalidation for the whole sheet, AFTER the commit.
                    //
                    // dashboardCache.bust is org-global by design (a single
                    // level change moves an aggregate in every scope that
                    // contains this employee, and the cache key cannot tell you
                    // which those are — so it fails closed and drops all of
                    // them). Doing that per skill meant saving one employee's
                    // 45-skill sheet wiped the cache 45 times; during a campaign
                    // at 4 000 employees the cache was structurally always
                    // empty and every dashboard load paid the cold path.
                    //
                    // Busting AFTER the transaction commits also closes a small
                    // correctness hole: busting mid-transaction let a concurrent
                    // reader repopulate the cache from the PRE-commit snapshot
                    // and then keep serving it for a full TTL.
                    { bustCache: false }
                );
                out.push(result);
            }
            return out;
        });
        dashboardCache.bust();
        return results;
    }
}

module.exports = new SkillAssessmentService();
