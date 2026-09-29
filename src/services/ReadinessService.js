const RoleSkillRequirementModel = require('../models/RoleSkillRequirementModel');
const EmployeeModel = require('../models/EmployeeModel');
const RBACService = require('./RBACService');
const AppSettingsModel = require('../models/AppSettingsModel');
const CertificationService = require('./CertificationService');
const db = require('../config/database');

class ReadinessService {
    /**
     * Resolved levels for a set of employees — the SAME rows the SQL views see.
     *
     * WHY THIS EXISTS (Wave 2, item 4)
     *   This service used to read SkillAssessmentModel.findByEmployeeIds, i.e.
     *   the `skill_assessments` table only. v_resolved_assessments (migration
     *   71) is a UNION of supervisor-validated rows AND approved
     *   self-assessments, latest-per-(employee, skill). So the moment an
     *   approved self-assessment existed, the employee-facing pages computed a
     *   LOWER readiness than the dashboard for the same person on the same day
     *   — the employee saw a gap their manager's dashboard said was closed.
     *   One source, one answer.
     *
     * Returns rows shaped like the old model output: { employeeId, skillId,
     * currentLevel } — plus `source`, so a caller can tell a validated level
     * from a self-rated one.
     *
     * @param {number[]} employeeIds
     * @returns {Promise<Array<{employeeId:number, skillId:number, currentLevel:number, source:string}>>}
     */
    async _resolvedLevels(employeeIds) {
        const ids = (employeeIds || []).map(Number).filter((n) => Number.isFinite(n));
        if (!ids.length) return [];
        const placeholders = ids.map(() => '?').join(',');
        return db.all(
            `SELECT employee_id AS "employeeId",
                    skill_id    AS "skillId",
                    level       AS "currentLevel",
                    source
               FROM v_resolved_assessments
              WHERE employee_id IN (${placeholders})`,
            ids
        );
    }

    async calculateReadinessMap(employees) {
        if (!employees || employees.length === 0) return {};

        // 1. Bulk fetch role requirements
        const roleIds = [...new Set(employees.map((e) => e.roleId))];
        const allRequirements = await RoleSkillRequirementModel.findByRoleIds(roleIds);

        // Group requirements by roleId
        const requirementsByRole = {};
        allRequirements.forEach((req) => {
            if (!requirementsByRole[req.roleId]) {
                requirementsByRole[req.roleId] = [];
            }
            requirementsByRole[req.roleId].push(req);
        });

        // 2. Bulk fetch assessments — from v_resolved_assessments, the same
        //    union (supervisor-validated + approved self) the dashboard views
        //    read. See _resolvedLevels.
        const employeeIds = employees.map((e) => e.id);
        const allAssessments = await this._resolvedLevels(employeeIds);

        // Group assessments by employeeId
        const assessmentsByEmployee = {};
        allAssessments.forEach((assessment) => {
            if (!assessmentsByEmployee[assessment.employeeId]) {
                assessmentsByEmployee[assessment.employeeId] = [];
            }
            assessmentsByEmployee[assessment.employeeId].push(assessment);
        });

        // 2b. Lapsed certifications — a held statutory certificate that has
        // expired (or been revoked) degrades that skill to level 0 until it is
        // revalidated. Mirrors v_employee_skill_gaps so the JS path and the SQL
        // path agree on the same person. See CertificationService.lapsedPairSet.
        const lapsedPairs = await CertificationService.lapsedPairSet(employeeIds);

        // 3. Calculate readiness for each employee
        const readinessMap = {};

        // Get configurable readiness threshold (default 80)
        const readinessThreshold = await AppSettingsModel.getValue('readinessThreshold', 80);

        for (const employee of employees) {
            const requirements = requirementsByRole[employee.roleId] || [];
            const assessments = assessmentsByEmployee[employee.id] || [];

            readinessMap[employee.id] = this._calculateSingleReadiness(
                employee.id,
                requirements,
                assessments,
                readinessThreshold,
                lapsedPairs
            );
        }

        return readinessMap;
    }

    _calculateSingleReadiness(
        employeeId,
        requirements,
        assessments,
        readinessThreshold,
        lapsedPairs = null
    ) {
        // Only POSITIVE requirements count — mirror v_employee_readiness
        // (WHERE required_level > 0). A required_level=0 row is not a real
        // requirement; counting it inflated skills_met / total_required here and
        // made the dashboard disagree with the Report Builder for the same person.
        requirements = (requirements || []).filter((r) => Number(r.requiredLevel) > 0);
        if (requirements.length === 0) {
            return {
                employeeId,
                totalRequired: 0,
                pointsGained: 0,
                pointsRequired: 0,
                skillsMet: 0,
                skillsNotMet: 0,
                criticalSkillsMet: 0,
                criticalSkillsTotal: 0,
                readinessPercent: null,
                readinessAllRequirements: 0,
                assessedRequired: 0,
                neverAssessedRequired: 0,
                coveragePercent: null,
                isReady: false,
                gaps: [],
            };
        }

        const assessmentMap = {};
        assessments.forEach((a) => {
            assessmentMap[a.skillId] = a.currentLevel;
        });

        let skillsMet = 0;
        let skillsNotMet = 0;
        let criticalSkillsMet = 0;
        let criticalSkillsTotal = 0;
        let pointsGained = 0;
        let pointsRequired = 0;
        // Assessed-only arithmetic, mirroring
        // v_employee_assessment_coverage.readiness_assessed_only exactly.
        let assessedRequired = 0;
        let assessedPointsGained = 0;
        let assessedPointsRequired = 0;
        const gaps = [];

        requirements.forEach((req) => {
            // A lapsed certification degrades the qualification, not the
            // assessment: the skill still counts as a requirement (the
            // department-designed count is untouched), it just no longer counts
            // as HELD until the certificate is revalidated.
            const certLapsed = !!(
                lapsedPairs && lapsedPairs.has(`${Number(employeeId)}:${Number(req.skillId)}`)
            );
            // `isAssessed` is the provenance predicate of
            // v_requirement_provenance: a resolved row EXISTS, whatever its
            // level. A rated 0 is assessed; a missing row is not. A lapsed
            // certificate degrades the LEVEL, not the fact of measurement.
            const rated = assessmentMap[req.skillId];
            const isAssessed = rated !== undefined && rated !== null;
            const currentLevel = certLapsed ? 0 : isAssessed ? Number(rated) : 0;
            const isMet = currentLevel >= req.requiredLevel;

            // Points-based: count actual points gained (capped at required level)
            pointsRequired += req.requiredLevel;
            pointsGained += Math.min(currentLevel, req.requiredLevel);

            if (isAssessed) {
                assessedRequired++;
                assessedPointsRequired += req.requiredLevel;
                assessedPointsGained += Math.min(currentLevel, req.requiredLevel);
            }

            if (req.isCritical) {
                criticalSkillsTotal++;
                if (isMet) {
                    criticalSkillsMet++;
                }
            }

            if (isMet) {
                skillsMet++;
            } else {
                skillsNotMet++;
                gaps.push({
                    skillId: req.skillId,
                    skillName: req.skillName,
                    domainName: req.domainName,
                    requiredLevel: req.requiredLevel,
                    currentLevel: currentLevel,
                    isCritical: req.isCritical,
                    gap: req.requiredLevel - currentLevel,
                    isAssessed,
                    certLapsed,
                });
            }
        });

        // The department-designed requirement count, WHOLE. Never a subset.
        const totalRequired = requirements.length;

        // The all-requirements figure: every never-rated requirement counted as
        // a scored 0. Kept, under its own name, because is_role_ready depends on
        // it — you cannot be certified "ready" on skills nobody measured.
        const readinessAllRequirements =
            pointsRequired > 0 ? Math.round((pointsGained / pointsRequired) * 1000) / 10 : 0;

        // THE canonical number (Wave 2): readiness over the ASSESSED
        // requirements only — arithmetically identical to
        // v_employee_assessment_coverage.readiness_assessed_only, and to
        // readinessAllRequirements whenever coverage is 100 %. null (never 0)
        // when nothing was ever assessed: that is missing data, not a result.
        const readinessPercent =
            assessedPointsRequired > 0
                ? Math.round((assessedPointsGained / assessedPointsRequired) * 1000) / 10
                : null;

        // Employee is ready if:
        // 1. Readiness over ALL requirements >= configured threshold
        // 2. All critical skills are met
        // Deliberately NOT the assessed-only figure: 100 % of the two skills
        // somebody happened to be rated on is not role-readiness. Mirrors
        // v_employee_readiness.is_role_ready, so this value is unchanged.
        const isReady =
            readinessAllRequirements >= readinessThreshold &&
            criticalSkillsMet === criticalSkillsTotal;

        return {
            employeeId,
            totalRequired,
            pointsGained,
            pointsRequired,
            skillsMet,
            skillsNotMet,
            criticalSkillsMet,
            criticalSkillsTotal,
            readinessPercent,
            readinessAllRequirements,
            // Coverage travels with the score, everywhere.
            assessedRequired,
            neverAssessedRequired: totalRequired - assessedRequired,
            coveragePercent:
                totalRequired > 0
                    ? Math.round((assessedRequired / totalRequired) * 1000) / 10
                    : null,
            isReady,
            gaps,
        };
    }

    async calculateReadiness(employeeId) {
        const employee = await EmployeeModel.findById(employeeId);
        if (!employee) {
            return null;
        }

        // Get all required skills for the employee's role
        const requirements = await RoleSkillRequirementModel.findByRoleId(employee.roleId);

        // Resolved levels (supervisor-validated + approved self), the same
        // source the dashboard views read — see _resolvedLevels.
        const assessments = await this._resolvedLevels([employeeId]);

        // Get configurable readiness threshold (default 80)
        const readinessThreshold = await AppSettingsModel.getValue('readinessThreshold', 80);

        const lapsedPairs = await CertificationService.lapsedPairSet([Number(employeeId)]);
        return this._calculateSingleReadiness(
            employeeId,
            requirements,
            assessments,
            readinessThreshold,
            lapsedPairs
        );
    }

    async getEmployeeReadiness(employeeId) {
        return await this.calculateReadiness(employeeId);
    }

    async getOrganizationalReadiness(admin) {
        const employees = await RBACService.getFilteredEmployees(admin);

        const readinessData = [];
        let totalEmployees = 0;
        let readyCount = 0;
        let notReadyCount = 0;
        let noRequirementsCount = 0;
        let measuredCount = 0;
        let assessedRequirements = 0;
        let expectedRequirements = 0;
        let measuredReadinessSum = 0;
        const readinessDistribution = {
            '0-20': 0,
            '21-40': 0,
            '41-60': 0,
            '61-79': 0,
            '80-100': 0,
            // People nobody has measured get their own bucket instead of being
            // piled into 0-20 as if they had been tested and failed.
            'never-assessed': 0,
        };
        const gapAnalysis = {};

        const readinessMap = await this.calculateReadinessMap(employees);

        for (const employee of employees) {
            const readiness = readinessMap[employee.id];
            // An employee whose role has no positive requirements has nothing to be
            // "ready" against. _calculateSingleReadiness returns totalRequired:0 for
            // that case (it never returns null), so key off that — otherwise these
            // employees were miscounted as 0%/not-ready and deflated the whole org rate.
            if (!readiness || readiness.totalRequired === 0) {
                noRequirementsCount++;
                continue;
            }

            totalEmployees++;
            readinessData.push({
                employee: {
                    id: employee.id,
                    employeeNumber: employee.employeeNumber,
                    firstName: employee.firstName,
                    lastName: employee.lastName,
                    roleName: employee.roleName,
                    siteName: employee.siteName,
                    departmentName: employee.departmentName,
                    serviceName: employee.serviceName,
                },
                ...readiness,
            });

            if (readiness.isReady) {
                readyCount++;
            } else {
                notReadyCount++;
            }

            assessedRequirements += readiness.assessedRequired;
            expectedRequirements += readiness.totalRequired;

            // Distribution over the canonical (assessed-only) readiness.
            if (readiness.readinessPercent === null) {
                readinessDistribution['never-assessed']++;
            } else {
                measuredCount++;
                measuredReadinessSum += readiness.readinessPercent;
                if (readiness.readinessPercent <= 20) {
                    readinessDistribution['0-20']++;
                } else if (readiness.readinessPercent <= 40) {
                    readinessDistribution['21-40']++;
                } else if (readiness.readinessPercent <= 60) {
                    readinessDistribution['41-60']++;
                } else if (readiness.readinessPercent < 80) {
                    readinessDistribution['61-79']++;
                } else {
                    readinessDistribution['80-100']++;
                }
            }

            // Gap analysis. Key by (skill, requiredLevel, isCritical): the same
            // skill+level can be critical in one role and not in another, so keying
            // on skill+level alone let the first-seen criticality win for everyone.
            readiness.gaps.forEach((gap) => {
                // MEASURED gaps only — the JS mirror of migration 79's
                // `is_assessed = 1` predicate on total_gap_points. Counting a
                // never-rated requirement as a full-size deficit is what put
                // the UNMEASURED at the top of the "worst gaps" list.
                if (!gap.isAssessed) return;
                const key = `${gap.skillId}_${gap.requiredLevel}_${gap.isCritical ? 1 : 0}`;
                if (!gapAnalysis[key]) {
                    gapAnalysis[key] = {
                        skillId: gap.skillId,
                        skillName: gap.skillName,
                        domainName: gap.domainName,
                        requiredLevel: gap.requiredLevel,
                        isCritical: gap.isCritical,
                        employeesAffected: 0,
                        totalGap: 0,
                    };
                }
                gapAnalysis[key].employeesAffected++;
                gapAnalysis[key].totalGap += gap.gap;
            });
        }

        const overallReadinessPercent =
            totalEmployees > 0 ? Math.round((readyCount / totalEmployees) * 100) : 0;

        return {
            totalEmployees,
            readyCount,
            notReadyCount,
            noRequirementsCount,
            overallReadinessPercent,
            // Coverage-aware headline: the canonical readiness averaged over the
            // people actually measured, with the denominators that make it
            // readable. null (never 0) when nobody in scope was ever assessed.
            measuredCount,
            avgReadinessAssessedOnly:
                measuredCount > 0
                    ? Math.round((measuredReadinessSum / measuredCount) * 10) / 10
                    : null,
            assessedRequirements,
            expectedRequirements,
            coveragePercent:
                expectedRequirements > 0
                    ? Math.round((1000 * assessedRequirements) / expectedRequirements) / 10
                    : null,
            readinessDistribution,
            gapAnalysis: Object.values(gapAnalysis).sort(
                (a, b) => b.employeesAffected - a.employeesAffected
            ),
            readinessData,
        };
    }

    async getDepartmentReadiness(admin) {
        const employees = await RBACService.getFilteredEmployees(admin);
        const departmentStats = {};

        const readinessMap = await this.calculateReadinessMap(employees);

        for (const employee of employees) {
            if (!departmentStats[employee.departmentName]) {
                departmentStats[employee.departmentName] = {
                    name: employee.departmentName,
                    totalEmployees: 0,
                    measuredEmployees: 0,
                    totalReadiness: 0,
                    assessedRequirements: 0,
                    expectedRequirements: 0,
                    readyCount: 0,
                };
            }

            const readiness = readinessMap[employee.id];
            // Exclude no-requirement employees (totalRequired:0) from the department
            // average so a site whose roles have no benchmark yet isn't shown as 0% ready.
            if (readiness && readiness.totalRequired > 0) {
                const d = departmentStats[employee.departmentName];
                d.totalEmployees++;
                d.assessedRequirements += readiness.assessedRequired;
                d.expectedRequirements += readiness.totalRequired;
                // Average over the MEASURED people only; a never-assessed
                // employee is null, and adding null silently produced NaN
                // (and, before that, dragged the department toward 0).
                if (readiness.readinessPercent !== null) {
                    d.measuredEmployees++;
                    d.totalReadiness += readiness.readinessPercent;
                }
                if (readiness.isReady) {
                    d.readyCount++;
                }
            }
        }

        return Object.values(departmentStats)
            .map((dept) => ({
                name: dept.name,
                employeeCount: dept.totalEmployees,
                measuredCount: dept.measuredEmployees,
                averageReadiness:
                    dept.measuredEmployees > 0
                        ? Math.round((dept.totalReadiness / dept.measuredEmployees) * 10) / 10
                        : null,
                coveragePercent:
                    dept.expectedRequirements > 0
                        ? Math.round(
                              (1000 * dept.assessedRequirements) / dept.expectedRequirements
                          ) / 10
                        : null,
                assessedRequirements: dept.assessedRequirements,
                expectedRequirements: dept.expectedRequirements,
                readyCount: dept.readyCount,
            }))
            .sort((a, b) => (b.averageReadiness ?? -1) - (a.averageReadiness ?? -1));
    }
}

module.exports = new ReadinessService();
