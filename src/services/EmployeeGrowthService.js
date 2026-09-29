'use strict';

/**
 * EmployeeGrowthService — the employee's OWN view of where they stand against a
 * role: "my gap against my target role" and "the roles I'm closest to".
 *
 * Both answers reuse the arithmetic the manager-side surfaces already publish,
 * so the employee never reads a third opinion about themselves:
 *   - the target-role gap is the SAME query and the SAME summary as
 *     TalentActionsController.careerPathData (the manager's career-path tool),
 *     which now calls roleGap() below;
 *   - the closest-roles ranking runs ReadinessService._calculateSingleReadiness
 *     for every role against the employee's resolved levels
 *     (v_resolved_assessments + lapsed certificates), exactly as the dashboards do.
 *
 * Measured-denominator honesty, everywhere: a requirement nobody has assessed is
 * UNMEASURED — never a level 0, never a gap, never a failure. Readiness is over
 * the measured requirements only, and the coverage travels with it.
 */
const db = require('../config/database');

/**
 * Pure. Summarise one person's rows against one role.
 *
 * @param {Array<{skillName:string, domainName?:string, required:number,
 *                current:(number|null), isAssessed:(number|boolean),
 *                isCritical:(number|boolean)}>} rawRows
 *   `current` is ignored when `isAssessed` is falsy.
 * @returns {{rows:Array, total:number, measured:number, met:number,
 *            unmeasured:number, gaps:number, criticalGaps:number,
 *            readiness:(number|null), coverage:(number|null),
 *            metRows:Array, growRows:Array, unmeasuredRows:Array}}
 */
function summariseRoleGap(rawRows) {
    const rows = (rawRows || [])
        .map((r) => {
            const required = Number(r.required) || 0;
            const assessed = r.isAssessed === true || Number(r.isAssessed) === 1;
            const current = assessed ? Number(r.current) || 0 : null;
            const gap = assessed ? Math.max(0, required - current) : null;
            return {
                skillName: r.skillName,
                domainName: r.domainName || null,
                required,
                current,
                gap,
                met: assessed && gap === 0,
                assessed,
                critical: r.isCritical === true || Number(r.isCritical) === 1,
            };
        })
        // required_level = 0 means NOT REQUIRED — never part of the denominator.
        .filter((r) => r.required > 0);
    const total = rows.length;
    const measuredRows = rows.filter((r) => r.assessed);
    const measured = measuredRows.length;
    const metRows = rows.filter((r) => r.met);
    const growRows = measuredRows
        .filter((r) => !r.met)
        .sort(
            (a, b) =>
                Number(b.critical) - Number(a.critical) ||
                b.gap - a.gap ||
                String(a.skillName).localeCompare(String(b.skillName))
        );
    const unmeasuredRows = rows.filter((r) => !r.assessed);
    const met = metRows.length;
    return {
        rows,
        total,
        measured,
        met,
        unmeasured: total - measured,
        gaps: growRows.length,
        criticalGaps: growRows.filter((r) => r.critical).length,
        // null (never 0) when nothing was measured, or the role asks for nothing.
        readiness: measured > 0 ? Math.round((met / measured) * 100) : null,
        coverage: total > 0 ? Math.round((measured / total) * 100) : null,
        metRows,
        growRows,
        unmeasuredRows,
    };
}

/** Below this coverage a role's readiness rests on thin evidence. */
const THIN_EVIDENCE_COVERAGE = 50;

/**
 * Pure. Rank roles by readiness for one person, honestly.
 *
 * Input items are ReadinessService._calculateSingleReadiness results carrying
 * `roleId` and `roleName` (its per-requirement verdicts: resolved levels, lapsed
 * certificates, required_level > 0 only). Readiness here is requirements met
 * over requirements measured. A role with no measured requirement has no
 * readiness and is left out — "closest" on zero evidence is a guess. Roles whose
 * coverage is under THIN_EVIDENCE_COVERAGE rank AFTER the well-measured ones,
 * so 100 % of one assessed skill never outranks 90 % of eighteen.
 *
 * @param {Array<object>} results
 * @param {{excludeRoleIds?:Array<number>, limit?:number}} [opts]
 */
function rankClosestRoles(results, { excludeRoleIds = [], limit = 5 } = {}) {
    const exclude = new Set((excludeRoleIds || []).filter((x) => x != null).map(Number));
    return (results || [])
        .filter(
            (r) =>
                r &&
                !exclude.has(Number(r.roleId)) &&
                Number(r.totalRequired) > 0 &&
                Number(r.assessedRequired) > 0
        )
        .map((r) => {
            const measured = Number(r.assessedRequired);
            const measuredGaps = (r.gaps || []).filter((g) => g.isAssessed).length;
            const met = measured - measuredGaps;
            const coverage = r.coveragePercent == null ? 0 : Number(r.coveragePercent);
            return {
                roleId: Number(r.roleId),
                roleName: r.roleName,
                // Requirements met over requirements MEASURED — the same figure
                // as the target-role gap (summariseRoleGap) and the manager's
                // career-path tool, so one role never shows two percentages.
                readiness: Math.round((met / measured) * 100),
                total: Number(r.totalRequired),
                measured,
                unmeasured: Number(r.totalRequired) - measured,
                met,
                gaps: measuredGaps,
                coverage: Math.round(coverage),
                thinEvidence: coverage < THIN_EVIDENCE_COVERAGE,
            };
        })
        .sort(
            (a, b) =>
                Number(a.thinEvidence) - Number(b.thinEvidence) ||
                b.readiness - a.readiness ||
                b.measured - a.measured ||
                String(a.roleName).localeCompare(String(b.roleName))
        )
        .slice(0, Math.max(0, Number(limit) || 0));
}

/**
 * The resolved rows of one person against one role — the career-path query.
 * Reads v_resolved_assessments (validated + approved self) and honours a lapsed
 * certificate; a never-assessed requirement comes back with is_assessed = 0.
 */
async function roleGapRows(employeeId, roleId) {
    return db.all(
        `SELECT s.name AS skill_name, d.name AS domain_name, rsr.required_level AS required, rsr.is_critical,
                CASE WHEN cl.employee_id IS NOT NULL THEN 0 ELSE ra.level END AS current,
                CASE WHEN ra.level IS NOT NULL THEN 1 ELSE 0 END AS is_assessed
           FROM role_skill_requirements rsr
           JOIN skills s ON s.id = rsr.skill_id
           LEFT JOIN domains d ON d.id = s.domain_id
           LEFT JOIN v_resolved_assessments ra ON ra.employee_id = ? AND ra.skill_id = rsr.skill_id
           LEFT JOIN v_certification_lapsed cl ON cl.employee_id = ? AND cl.skill_id = rsr.skill_id
          WHERE rsr.role_id = ? AND rsr.required_level > 0
          ORDER BY rsr.is_critical DESC, s.name`,
        [employeeId, employeeId, roleId]
    );
}

/** One person against one role, summarised (see summariseRoleGap). */
async function roleGap(employeeId, roleId) {
    return summariseRoleGap(await roleGapRows(Number(employeeId), Number(roleId)));
}

/**
 * The person's target role (employee_aspirations.target_role_id) and their gap
 * against it, or null when no target is set / the role no longer exists.
 */
async function targetRoleGap(employeeId) {
    const eid = Number(employeeId);
    if (!eid) return null;
    const asp = await db.get(
        `SELECT a.target_role_id AS "targetRoleId", r.name AS "roleName"
           FROM employee_aspirations a JOIN roles r ON r.id = a.target_role_id
          WHERE a.employee_id = ?`,
        [eid]
    );
    if (!asp || !asp.targetRoleId) return null;
    const gap = await roleGap(eid, asp.targetRoleId);
    return { roleId: Number(asp.targetRoleId), roleName: asp.roleName, ...gap };
}

/**
 * The roles this person is closest to, ranked by the canonical readiness
 * (ReadinessService, assessed-only), their current role excluded.
 */
async function closestRoles(employeeId, { limit = 5 } = {}) {
    const eid = Number(employeeId);
    if (!eid) return [];
    const ReadinessService = require('./ReadinessService');
    const RoleSkillRequirementModel = require('../models/RoleSkillRequirementModel');
    const CertificationService = require('./CertificationService');
    const AppSettingsModel = require('../models/AppSettingsModel');

    const me = await db.get('SELECT role_id AS "roleId" FROM employees WHERE id = ?', [eid]);
    const roles = await db.all(
        `SELECT r.id, r.name FROM roles r
          WHERE r.is_active = true
            AND EXISTS (SELECT 1 FROM role_skill_requirements q
                         WHERE q.role_id = r.id AND q.required_level > 0)`
    );
    if (!roles.length) return [];
    const reqs = await RoleSkillRequirementModel.findByRoleIds(roles.map((r) => Number(r.id)));
    const byRole = new Map();
    for (const q of reqs) {
        const k = Number(q.roleId);
        if (!byRole.has(k)) byRole.set(k, []);
        byRole.get(k).push(q);
    }
    const assessments = await ReadinessService._resolvedLevels([eid]);
    const lapsed = await CertificationService.lapsedPairSet([eid]);
    const threshold = await AppSettingsModel.getValue('readinessThreshold', 80);
    const results = roles.map((r) => ({
        roleId: Number(r.id),
        roleName: r.name,
        ...ReadinessService._calculateSingleReadiness(
            eid,
            byRole.get(Number(r.id)) || [],
            assessments,
            threshold,
            lapsed
        ),
    }));
    return rankClosestRoles(results, {
        excludeRoleIds: me && me.roleId != null ? [Number(me.roleId)] : [],
        limit,
    });
}

/**
 * The top learning suggestions for this person's gaps (SkillsIntelligence),
 * measured gaps first — each either a course to follow or, for an unmeasured
 * requirement, "get it assessed". Never throws: an empty list is the empty state.
 */
async function learningSuggestions(employeeId, limit = 3) {
    try {
        const SI = require('./SkillsIntelligenceService');
        const all = (await SI.recommendLearning(Number(employeeId), 10)) || [];
        // Measured gaps with a mapped course are the most actionable; then other
        // measured gaps; then "get it assessed". Stable within each band.
        const band = (x) => (x.status === 'gap' ? (x.course ? 0 : 1) : 2);
        return all
            .map((x, i) => ({ x, i }))
            .sort((a, b) => band(a.x) - band(b.x) || a.i - b.i)
            .slice(0, limit)
            .map(({ x }) => ({
                ...x,
                course: x.course ? { ...x.course, url: safeUrl(x.course.url) } : null,
            }));
    } catch (_) {
        return [];
    }
}

/** Only an absolute http(s) URL is ever rendered as a link. */
function safeUrl(u) {
    if (!u) return null;
    try {
        const p = new URL(String(u));
        return p.protocol === 'http:' || p.protocol === 'https:' ? p.href : null;
    } catch (_) {
        return null;
    }
}

module.exports = {
    summariseRoleGap,
    rankClosestRoles,
    roleGapRows,
    roleGap,
    targetRoleGap,
    closestRoles,
    learningSuggestions,
    safeUrl,
    THIN_EVIDENCE_COVERAGE,
};
