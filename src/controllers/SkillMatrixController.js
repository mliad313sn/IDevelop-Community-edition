const EmployeeModel = require('../models/EmployeeModel');
const SkillModel = require('../models/SkillModel');
const SkillAssessmentModel = require('../models/SkillAssessmentModel');
const DomainModel = require('../models/DomainModel');
const RoleSkillRequirementModel = require('../models/RoleSkillRequirementModel');
const RoleModel = require('../models/RoleModel');
const RBACService = require('../services/RBACService');
const ReadinessService = require('../services/ReadinessService');
const { bc } = require('../utils/breadcrumbLabel');

class SkillMatrixController {
    async index(req, res) {
        try {
            // Get filtered employees based on RBAC (full in-scope universe)
            let scoped = await RBACService.getFilteredEmployees(req.user);

            // LEAVERS ARE NEVER ASSESSABLE.
            //
            // The matrix exists to rate and develop CURRENT staff, so a deactivated
            // person has no place in it: their row invites an assessment that cannot
            // mean anything, and it inflates the visible population. A manager's view
            // already excluded them (findGovernedIds filters is_active); superadmins
            // and local admins did not, which was an accident rather than a decision.
            //
            // Unlike the employee list there is no "show leavers" toggle here — the
            // employee list is where a departed record is found and reactivated.
            scoped = scoped.filter((e) => e.isActive !== false && e.isActive !== 0);

            // ---- Server-side filtering (narrow BEFORE paginating) ----
            // The matrix is employees × ~all skills; rendering every row server-side
            // for a large org produces a multi-MB page that lags the browser. We
            // filter then paginate so only a bounded slice is ever rendered.
            const filters = {
                site: (req.query.site || '').trim(),
                department: (req.query.department || '').trim(),
                service: (req.query.service || '').trim(),
                role: (req.query.role || '').trim(),
                q: (req.query.q || '').trim().toLowerCase(),
            };
            if (filters.site) scoped = scoped.filter((e) => (e.siteName || '') === filters.site);
            if (filters.department)
                scoped = scoped.filter((e) => (e.departmentName || '') === filters.department);
            if (filters.service)
                scoped = scoped.filter((e) => (e.serviceName || '') === filters.service);
            if (filters.role) scoped = scoped.filter((e) => (e.roleName || '') === filters.role);
            if (filters.q) {
                scoped = scoped.filter(
                    (e) =>
                        `${e.firstName} ${e.lastName}`.toLowerCase().includes(filters.q) ||
                        String(e.employeeNumber || '')
                            .toLowerCase()
                            .includes(filters.q)
                );
            }

            // ---- Pagination ----
            const filteredTotal = scoped.length;
            const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 25, 5), 200);
            const totalPages = Math.max(1, Math.ceil(filteredTotal / pageSize));
            let page = parseInt(req.query.page, 10) || 1;
            if (page < 1) page = 1;
            if (page > totalPages) page = totalPages;
            const employees = scoped.slice((page - 1) * pageSize, page * pageSize);

            // Get all skills grouped by domain (columns — unchanged)
            const domains = await DomainModel.findAll();
            const allSkills = await SkillModel.findWithDomain();

            // Group skills by domain
            const skillsByDomain = {};
            domains.forEach((domain) => {
                skillsByDomain[domain.id] = {
                    domain,
                    skills: allSkills.filter((s) => s.domainId === domain.id),
                };
            });

            // Get assessments for THIS PAGE's employees only
            const employeeIds = employees.map((e) => e.id);
            let allAssessments = [];

            if (employeeIds.length > 0) {
                allAssessments = await SkillAssessmentModel.findByEmployeeIds(employeeIds);
            }

            // Create assessment map: employeeId -> skillId -> assessment
            const assessmentMap = {};
            allAssessments.forEach((assessment) => {
                if (!assessmentMap[assessment.employeeId]) {
                    assessmentMap[assessment.employeeId] = {};
                }
                assessmentMap[assessment.employeeId][assessment.skillId] = assessment;
            });

            // Get role requirements for this page's employees
            const roleRequirementsMap = {};
            const roleIds = [...new Set(employees.map((e) => e.roleId))];

            if (roleIds.length > 0) {
                const allReqs = await RoleSkillRequirementModel.findByRoleIds(roleIds);

                allReqs.forEach((req) => {
                    if (!roleRequirementsMap[req.roleId]) {
                        roleRequirementsMap[req.roleId] = {};
                    }
                    roleRequirementsMap[req.roleId][req.skillId] = req;
                });
            }

            // Get readiness for this page's employees (bulk)
            const readinessMap = await ReadinessService.calculateReadinessMap(employees);

            // Filter options
            const sites = await RBACService.getFilteredSites(req.user);
            const departments = await RBACService.getFilteredDepartments(req.user);
            const services = await RBACService.getFilteredServices(req.user);

            // Get all roles for filter
            const roles = await RoleModel.findAll({ isActive: 1 }, 'name ASC');

            // Helper to deduplicate by name and sort
            const distinctByName = (items) => {
                const seen = new Set();
                return items
                    .filter((item) => {
                        const name = item.name.trim();
                        if (seen.has(name)) return false;
                        seen.add(name);
                        return true;
                    })
                    .sort((a, b) => a.name.localeCompare(b.name));
            };

            const uniqueSites = distinctByName(sites);
            const uniqueDepartments = distinctByName(departments);
            const uniqueServices = distinctByName(services);
            const uniqueRoles = distinctByName(roles);

            res.render('pages/skill-matrix/index', {
                title: req.t ? req.t('chrome:pt_skill_matrix') : 'Skill Matrix',
                employees,
                skillsByDomain,
                assessmentMap,
                roleRequirementsMap,
                readinessMap,
                sites: uniqueSites,
                departments: uniqueDepartments,
                services: uniqueServices,
                roles: uniqueRoles,
                allSkills,
                totalSkills: allSkills.length,
                totalEmployees: filteredTotal,
                pageInfo: {
                    page,
                    pageSize,
                    totalPages,
                    total: filteredTotal,
                    showing: employees.length,
                },
                filters,
                // translated crumbs; « Main » also named the destination
                // wrongly: the link goes to the dashboard, so it says so.
                breadcrumbs: [
                    { label: bc(req, 'chrome:nav_dashboard', 'Dashboard'), url: '/dashboard' },
                    { label: bc(req, 'chrome:pt_skill_matrix', 'Skill Matrix') },
                ],
            });
        } catch (error) {
            console.error('Skill Matrix error:', error);
            req.flash(
                'error',
                req.t ? req.t('flash:matrix_load_error') : 'Error loading skill matrix'
            );
            res.redirect('/dashboard');
        }
    }

    async updateAssessment(req, res) {
        try {
            const { employeeId, skillId, currentLevel, notes } = req.body;

            const employee = await EmployeeModel.findById(parseInt(employeeId));
            if (!employee) {
                return res.status(404).json({ error: 'Employee not found' });
            }

            const hasAccess = await RBACService.canAccessEmployeeData(req.user, employee);
            if (!hasAccess) {
                return res.status(403).json({ error: 'Access denied' });
            }

            const SkillAssessmentService = require('../services/SkillAssessmentService');
            await SkillAssessmentService.updateAssessment(
                parseInt(employeeId),
                parseInt(skillId),
                parseInt(currentLevel),
                req.user.id,
                notes || null,
                req
            );

            // Recalculate readiness
            const readiness = await ReadinessService.getEmployeeReadiness(parseInt(employeeId));

            res.json({
                success: true,
                message: 'Assessment updated successfully',
                readiness,
            });
        } catch (error) {
            console.error('Skill matrix update assessment error:', error);
            res.status(500).json({ error: error.message || 'Error updating assessment' });
        }
    }
}

module.exports = new SkillMatrixController();
