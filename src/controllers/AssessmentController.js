const EmployeeModel = require('../models/EmployeeModel');
const SkillAssessmentModel = require('../models/SkillAssessmentModel');
const AssessmentHistoryModel = require('../models/AssessmentHistoryModel');
const RoleSkillRequirementModel = require('../models/RoleSkillRequirementModel');
const SkillAssessmentService = require('../services/SkillAssessmentService');
const ReadinessService = require('../services/ReadinessService');
const RBACService = require('../services/RBACService');
const { assessmentValidation } = require('../utils/validators');

class AssessmentController {
    async show(req, res) {
        try {
            const { id } = req.params;
            const employee = await EmployeeModel.findByIdWithOrganization(id);

            if (!employee) {
                req.flash('error', req.t ? req.t('flash:emp_not_found') : 'Employee not found');
                return res.redirect('/employees');
            }

            const hasAccess = await RBACService.canAccessEmployeeData(req.user, employee);
            if (!hasAccess) {
                req.flash('error', req.t ? req.t('flash:access_denied') : 'Access denied');
                return res.redirect('/employees');
            }

            // Get role requirements (skills required by employee's role)
            const requirements = await RoleSkillRequirementModel.findByRoleId(employee.roleId);
            const requiredSkillIds = new Set(requirements.map((r) => r.skillId));

            // Get current assessments (all assessments for this employee)
            const assessments = await SkillAssessmentModel.findByEmployeeId(id);
            const assessmentMap = {};
            assessments.forEach((a) => {
                assessmentMap[a.skillId] = a;
            });

            // Build list of role-required skills with their assessments
            const roleSkills = requirements.map((req) => ({
                ...req,
                assessment: assessmentMap[req.skillId] || null,
                currentLevel: assessmentMap[req.skillId]?.currentLevel || 0,
                isMet: (assessmentMap[req.skillId]?.currentLevel || 0) >= req.requiredLevel,
                isAdditional: false, // Part of role requirements
            }));

            // Find assessments for skills NOT in role requirements (additional skills)
            const additionalAssessments = assessments.filter(
                (a) => !requiredSkillIds.has(a.skillId)
            );

            // Add additional assessed skills (outside role requirements)
            const additionalSkills = additionalAssessments.map((a) => ({
                skillId: a.skillId,
                skillName: a.skillName,
                domainName: a.domainName,
                domainId: a.domainId,
                requiredLevel: null, // Not required by role
                isCritical: 0,
                isAdditional: true, // Flag as additional/custom skill
                assessment: a,
                currentLevel: a.currentLevel,
                isMet: false, // Not applicable for additional skills
            }));

            // Combine all skills (role-required + additional assessed)
            const skillsWithAssessments = [...roleSkills, ...additionalSkills];

            // Get readiness
            const readiness = await ReadinessService.getEmployeeReadiness(id);

            // Get assessment history
            const history = await AssessmentHistoryModel.findByEmployeeId(id);

            res.render('pages/assessments/show', {
                title: req.t
                    ? req.t('chrome:pt_assessments_for', {
                          name: `${employee.firstName} ${employee.lastName}`,
                      })
                    : `Assessments: ${employee.firstName} ${employee.lastName}`,
                employee,
                skillsWithAssessments,
                readiness,
                history: history.slice(0, 50), // Last 50 history entries
            });
        } catch (error) {
            console.error('Assessment show error:', error);
            req.flash(
                'error',
                req.t ? req.t('flash:assess_list_load_error') : 'Error loading assessments'
            );
            res.redirect('/employees');
        }
    }

    async update(req, res) {
        try {
            const { id } = req.params;
            const { skillId, currentLevel, notes } = req.body;

            const employee = await EmployeeModel.findById(id);
            if (!employee) {
                return res.status(404).json({ error: 'Employee not found' });
            }

            const hasAccess = await RBACService.canAccessEmployeeData(req.user, employee);
            if (!hasAccess) {
                return res.status(403).json({ error: 'Access denied' });
            }

            await SkillAssessmentService.updateAssessment(
                parseInt(id),
                parseInt(skillId),
                parseInt(currentLevel),
                req.user.id,
                notes || null,
                req
            );

            // Recalculate readiness
            const readiness = await ReadinessService.getEmployeeReadiness(id);

            res.json({
                success: true,
                message: 'Assessment updated successfully',
                readiness,
            });
        } catch (error) {
            console.error('Assessment update error:', error);
            res.status(500).json({ error: 'Error updating assessment' });
        }
    }

    async bulkUpdate(req, res) {
        try {
            const { id } = req.params;
            const { assessments } = req.body;

            const employee = await EmployeeModel.findById(id);
            if (!employee) {
                return res.status(404).json({ error: 'Employee not found' });
            }

            const hasAccess = await RBACService.canAccessEmployeeData(req.user, employee);
            if (!hasAccess) {
                return res.status(403).json({ error: 'Access denied' });
            }

            if (!Array.isArray(assessments)) {
                return res.status(400).json({ error: 'Invalid assessments data' });
            }

            // Was an open-coded loop over updateAssessment: no transaction (a
            // failure half-way left part of the sheet written against an
            // append-only history) and one full dashboard-cache bust PER SKILL.
            // bulkUpdateAssessments is the same write, all-or-nothing, with a
            // single invalidation after commit.
            await SkillAssessmentService.bulkUpdateAssessments(
                parseInt(id),
                assessments.map((a) => ({
                    skillId: parseInt(a.skillId),
                    currentLevel: parseInt(a.currentLevel),
                    notes: a.notes || null,
                })),
                req.user.id,
                req
            );

            const readiness = await ReadinessService.getEmployeeReadiness(id);

            res.json({
                success: true,
                message: 'Assessments updated successfully',
                readiness,
            });
        } catch (error) {
            console.error('Assessment bulk update error:', error);
            res.status(500).json({ error: 'Error updating assessments' });
        }
    }

    async history(req, res) {
        try {
            const { id, skillId } = req.params;
            const employee = await EmployeeModel.findById(id);

            if (!employee) {
                return res.status(404).json({ error: 'Employee not found' });
            }

            const hasAccess = await RBACService.canAccessEmployeeData(req.user, employee);
            if (!hasAccess) {
                return res.status(403).json({ error: 'Access denied' });
            }

            const history = await AssessmentHistoryModel.findByEmployeeId(
                parseInt(id),
                skillId ? parseInt(skillId) : null
            );

            res.json({ history });
        } catch (error) {
            console.error('Assessment history error:', error);
            res.status(500).json({ error: 'Error loading history' });
        }
    }
}

module.exports = new AssessmentController();
