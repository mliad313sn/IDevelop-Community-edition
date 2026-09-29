'use strict';
const db = require('../config/database');

/**
 * Benchmark = the required proficiency each role demands per skill
 * (role_skill_requirements). Two views:
 *   getMatrix — roles (X) × domain→sub-domain→skill (Y), cells = required level;
 *               shows how the benchmark VARIES role-to-role.
 *   getFit    — per role, how current occupants' ACTUAL levels meet the benchmark
 *               (fit %), from v_employee_skill_gaps.
 *
 * Written in native PostgreSQL (snake_case, real column names, LEAST/::numeric) so
 * nothing depends on the SQLite-compat identifier translation. db.all still maps
 * `?`→`$n` and returns camelCase rows via the generic snake→camel fallback.
 */
class BenchmarkModel {
    // RBAC + query scope on an aliased view that carries site/department/service ids.
    _scope(filters, params, alias = 'g') {
        let c = '';
        if (filters.siteName) {
            c += ` AND ${alias}.site_name = ?`;
            params.push(filters.siteName);
        }
        if (filters.departmentName) {
            c += ` AND ${alias}.department_name = ?`;
            params.push(filters.departmentName);
        }
        if (filters.serviceName) {
            c += ` AND ${alias}.service_name = ?`;
            params.push(filters.serviceName);
        }
        if (filters.siteIds && filters.siteIds.length) {
            c += ` AND ${alias}.site_id IN (${filters.siteIds.map(() => '?').join(',')})`;
            params.push(...filters.siteIds);
        }
        if (filters.departmentIds && filters.departmentIds.length) {
            c += ` AND ${alias}.department_id IN (${filters.departmentIds.map(() => '?').join(',')})`;
            params.push(...filters.departmentIds);
        }
        if (filters.serviceIds && filters.serviceIds.length) {
            c += ` AND ${alias}.service_id IN (${filters.serviceIds.map(() => '?').join(',')})`;
            params.push(...filters.serviceIds);
        }
        if (filters.employeeIds && filters.employeeIds.length) {
            c += ` AND ${alias}.employee_id IN (${filters.employeeIds.map(() => '?').join(',')})`;
            params.push(...filters.employeeIds);
        }
        return c;
    }

    /**
     * Benchmark matrix: roles × (domain→sub-domain→skill), cell = required level.
     * Only skills required by ≥1 in-scope role are returned. Filters narrow both axes.
     */
    async getMatrix(filters = {}) {
        const params = [];
        const where = ['rsr.required_level > 0', 'r.is_active = true', 's.is_active = true'];
        if (filters.domainName) {
            where.push('d.name = ?');
            params.push(filters.domainName);
        }
        if (filters.subDomainId) {
            where.push('sd.id = ?');
            params.push(Number(filters.subDomainId));
        }
        if (filters.roleFamilyId) {
            where.push('r.role_family_id = ?');
            params.push(Number(filters.roleFamilyId));
        }
        if (filters.roleName) {
            where.push('r.name = ?');
            params.push(filters.roleName);
        }
        if (filters.category) {
            where.push('s.category = ?');
            params.push(filters.category);
        }
        if (filters.criticalOnly === true || filters.criticalOnly === 'true')
            where.push('rsr.is_critical = true');
        if (filters.skillQuery) {
            where.push(require('../utils/searchSql').ilike('s.name'));
            params.push('%' + filters.skillQuery + '%');
        }
        if (filters.minLevel) {
            where.push('rsr.required_level >= ?');
            params.push(Number(filters.minLevel));
        }

        const rows = await db.all(
            `SELECT r.id AS role_id, r.name AS role_name,
                    d.name AS domain_name, sd.id AS sub_domain_id, sd.name AS sub_domain_name, sd.position AS sub_pos,
                    s.id AS skill_id, s.name AS skill_name, s.category AS category,
                    rsr.required_level AS required_level, rsr.is_critical AS is_critical
             FROM role_skill_requirements rsr
             JOIN roles r        ON r.id = rsr.role_id
             JOIN skills s       ON s.id = rsr.skill_id
             JOIN sub_domains sd ON sd.id = s.sub_domain_id
             JOIN domains d      ON d.id = sd.domain_id
             WHERE ${where.join(' AND ')}
             ORDER BY d.name, sd.position, s.name, r.name`,
            params
        );

        // Distinct roles (columns), in first-seen order sorted by name.
        const roleMap = new Map();
        for (const r of rows)
            if (!roleMap.has(r.roleId)) roleMap.set(r.roleId, { id: r.roleId, name: r.roleName });
        const roles = [...roleMap.values()].sort((a, b) => a.name.localeCompare(b.name));

        // Group skills by domain → sub-domain; each skill row carries a cell map roleId->{level,critical}.
        const domains = [];
        const dMap = new Map();
        const skillMap = new Map();
        for (const r of rows) {
            let d = dMap.get(r.domainName);
            if (!d) {
                d = { name: r.domainName, subs: [], _subMap: new Map() };
                dMap.set(r.domainName, d);
                domains.push(d);
            }
            let sd = d._subMap.get(r.subDomainId);
            if (!sd) {
                sd = { id: r.subDomainId, name: r.subDomainName, skills: [], _skMap: new Map() };
                d._subMap.set(r.subDomainId, sd);
                d.subs.push(sd);
            }
            let sk = sd._skMap.get(r.skillId);
            if (!sk) {
                sk = { id: r.skillId, name: r.skillName, category: r.category, cells: {} };
                sd._skMap.set(r.skillId, sk);
                sd.skills.push(sk);
                skillMap.set(r.skillId, sk);
            }
            sk.cells[r.roleId] = { level: Number(r.requiredLevel), critical: !!r.isCritical };
        }
        // Per-skill variation (max-min required level across the shown roles) — the headline "variation" signal.
        for (const sk of skillMap.values()) {
            const levels = Object.values(sk.cells).map((c) => c.level);
            sk.minLevel = Math.min(...levels);
            sk.maxLevel = Math.max(...levels);
            sk.variation = sk.maxLevel - sk.minLevel;
            sk.rolesRequiring = levels.length;
        }

        return { roles, domains, skillCount: skillMap.size };
    }

    /**
     * Benchmark fit per role: how well current occupants meet the role's benchmark.
     * fit% = avg over occupants of SUM(min(actual,required)) / SUM(required).
     * Also criticalFit% (critical skills only) and the occupant count.
     */
    async getFit(filters = {}) {
        const params = [];
        const scope = this._scope(filters, params, 'g');
        let extra = '';
        if (filters.roleName) {
            extra += ' AND g.role_name = ?';
            params.push(filters.roleName);
        }
        if (filters.roleFamilyId) {
            extra +=
                ' AND EXISTS (SELECT 1 FROM roles fr WHERE fr.id = g.role_id AND fr.role_family_id = ?)';
            params.push(Number(filters.roleFamilyId));
        }
        if (filters.domainName) {
            extra += ' AND g.domain_name = ?';
            params.push(filters.domainName);
        }

        return await db.all(
            `WITH occ AS (
                 SELECT g.role_id, g.role_name, g.employee_id,
                        SUM(CASE WHEN g.is_assessed = 1 THEN LEAST(g.actual_level, g.required_level) ELSE 0 END)::numeric AS met,
                        SUM(CASE WHEN g.is_assessed = 1 THEN g.required_level ELSE 0 END)::numeric AS req,
                        SUM(CASE WHEN g.is_critical AND g.is_assessed = 1 THEN LEAST(g.actual_level, g.required_level) ELSE 0 END)::numeric AS crit_met,
                        SUM(CASE WHEN g.is_critical AND g.is_assessed = 1 THEN g.required_level ELSE 0 END)::numeric AS crit_req,
                        COUNT(*)::numeric AS req_skills,
                        SUM(g.is_assessed)::numeric AS assessed_skills,  -- is_assessed is integer 0/1
                        SUM(CASE WHEN g.is_critical THEN g.is_assessed ELSE 0 END)::numeric AS crit_assessed,
                        -- An occupant "below" a critical benchmark = under the required level on >=1
                        -- critical skill THAT WAS ACTUALLY ASSESSED. Without the is_assessed guard the
                        -- view coalesces an absent level to 0, so every never-measured critical
                        -- requirement read as a shortfall and every unmeasured occupant was counted
                        -- as having a critical gap.
                        MAX(CASE WHEN g.is_critical AND g.is_assessed = 1 AND g.actual_level < g.required_level
                                 THEN 1 ELSE 0 END) AS has_crit_gap
                 FROM v_employee_skill_gaps g
                 WHERE g.required_level > 0 ${scope} ${extra}
                 GROUP BY g.role_id, g.role_name, g.employee_id
             )
             SELECT role_id, role_name,
                    COUNT(*)::int AS occupants,
                    -- Fit is only defined for an occupant somebody has actually assessed.
                    -- AVG skips NULL, so an unmeasured occupant contributes nothing; a role where
                    -- NOBODY has been assessed yields NULL, never 0. This is the same predicate
                    -- jobs/fit-history.js applies before persisting - it was fixed there while this
                    -- model went on SERVING the fabricated 0 to /benchmark and its drill-through,
                    -- which then contradicted /supervisor/gap-analysis about the same people.
                    ROUND(AVG(CASE WHEN assessed_skills > 0 AND req > 0 THEN 100.0 * met / req END), 0) AS benchmark_fit,
                    ROUND(AVG(CASE WHEN crit_assessed > 0 AND crit_req > 0 THEN 100.0 * crit_met / crit_req END), 0) AS critical_fit,
                    -- assessment coverage: share of required skills that have been assessed (so a low
                    -- fit at low coverage is read as "unmeasured", not "incompetent")
                    ROUND(AVG(CASE WHEN req_skills > 0 THEN 100.0 * assessed_skills / req_skills END), 0) AS coverage,
                    -- Gap points, ready and critical-gap counts are MEASURED quantities too.
                    SUM(CASE WHEN assessed_skills > 0 THEN req - met ELSE 0 END)::int AS gap_points,
                    COUNT(*) FILTER (WHERE assessed_skills > 0)::int AS measured_occupants,
                    COUNT(*) FILTER (WHERE assessed_skills > 0 AND req > 0 AND 100.0 * met / req >= 80)::int AS occupants_ready,
                    COUNT(*) FILTER (WHERE has_crit_gap = 1)::int AS occupants_critical_gap
             FROM occ
             GROUP BY role_id, role_name
             ORDER BY benchmark_fit ASC NULLS FIRST, role_name`,
            params
        );
    }

    /**
     * Drill-through: the current occupants of a role × the role's required skills,
     * showing each occupant's ACTUAL level vs the required benchmark (who has which gap).
     * Returns { occupants:[{employeeId,fullName,employeeNumber,fit,critGap,assessed,reqCount}],
     *           domains:[{name,subs:[{name,skills:[{id,name,required,isCritical,cells:{empId:{actual,met,assessed}}}]}]}] }
     */
    async getRoleOccupants(roleId, filters = {}) {
        const params = [Number(roleId)];
        const scope = this._scope(filters, params, 'g');
        const rows = await db.all(
            `SELECT g.employee_id, d.full_name, d.employee_number,
                    dom.name AS domain_name, sd.name AS sub_domain_name, sd.position AS sub_pos,
                    g.skill_id, g.skill_name, g.required_level, g.actual_level, g.is_critical, g.is_assessed
             FROM v_employee_skill_gaps g
             JOIN v_employee_details d ON d.employee_id = g.employee_id
             JOIN skills s      ON s.id = g.skill_id
             JOIN sub_domains sd ON sd.id = s.sub_domain_id
             JOIN domains dom   ON dom.id = sd.domain_id
             WHERE g.role_id = ? AND g.required_level > 0 ${scope}
             ORDER BY dom.name, sd.position, g.skill_name, d.full_name`,
            params
        );

        const occMap = new Map(); // employeeId -> summary
        const domains = [];
        const dMap = new Map();
        const skMap = new Map();
        for (const r of rows) {
            const eid = r.employeeId;
            let occ = occMap.get(eid);
            if (!occ) {
                occ = {
                    employeeId: eid,
                    fullName: r.fullName,
                    employeeNumber: r.employeeNumber,
                    met: 0,
                    req: 0,
                    critGapN: 0,
                    assessed: 0,
                    reqCount: 0,
                };
                occMap.set(eid, occ);
            }
            const actual = Number(r.actualLevel),
                required = Number(r.requiredLevel);
            // MEASURED over MEASURED, the same rule getRoleCandidates applies.
            // The view coalesces an absent level to 0, so folding every
            // requirement into met/req made a never-assessed requirement a
            // full-weight miss: employee 158 read 74 % here and 91 % as a
            // candidate for the SAME role on the SAME page, and the occupant
            // list's 80/50 colour bands were being driven by requirements
            // nobody had measured. reqCount stays the department-designed
            // total so coverage below is unchanged.
            if (r.isAssessed) {
                occ.met += Math.min(actual, required);
                occ.req += required;
                occ.assessed++;
            }
            occ.reqCount++;
            // A critical gap has to be MEASURED. The view coalesces an absent level
            // to 0, so without the is_assessed guard every never-assessed critical
            // requirement counted as a shortfall — one occupant with zero
            // assessments was published as having 11 critical gaps.
            if (r.isCritical && r.isAssessed && actual < required) occ.critGapN++;

            let dd = dMap.get(r.domainName);
            if (!dd) {
                dd = { name: r.domainName, subs: [], _sm: new Map() };
                dMap.set(r.domainName, dd);
                domains.push(dd);
            }
            let sd = dd._sm.get(r.subDomainName);
            if (!sd) {
                sd = { name: r.subDomainName, skills: [], _km: new Map() };
                dd._sm.set(r.subDomainName, sd);
                dd.subs.push(sd);
            }
            let sk = sd._km.get(r.skillId);
            if (!sk) {
                sk = {
                    id: r.skillId,
                    name: r.skillName,
                    required,
                    isCritical: !!r.isCritical,
                    cells: {},
                };
                sd._km.set(r.skillId, sk);
                sd.skills.push(sk);
                skMap.set(r.skillId, sk);
            }
            sk.cells[eid] = { actual, met: actual >= required, assessed: !!r.isAssessed };
        }
        const occupants = [...occMap.values()]
            .map((o) => ({
                employeeId: o.employeeId,
                fullName: o.fullName,
                employeeNumber: o.employeeNumber,
                // Fit is undefined for an occupant nobody assessed — null, never 0.
                fit: o.assessed > 0 && o.req > 0 ? Math.round((100 * o.met) / o.req) : null,
                coverage: o.reqCount > 0 ? Math.round((100 * o.assessed) / o.reqCount) : 0,
                critGap: o.critGapN,
                reqCount: o.reqCount,
            }))
            .sort((a, b) => (a.fit ?? -1) - (b.fit ?? -1));
        return { occupants, domains };
    }

    /**
     * Succession — "who's ready to move up": in-scope active employees NOT already in
     * this role, ranked by their fit against THIS role's benchmark. Reuses the same
     * required-points-met math as occupant fit.
     *
     * Same rule as getRoleOccupants: fit is computed over the requirements somebody
     * ACTUALLY ASSESSED and is NULL (never 0) when none was; gap_skills and
     * crit_gap_skills count MEASURED shortfalls only. The raw query used to fold
     * every never-assessed requirement in as level 0, so against a 161-skill role
     * a candidate rated on ONE skill (met at 75 %) was published at 1 % fit with
     * 161 gaps and 56 critical gaps. req_skills stays the full department-designed
     * requirement count; assessed_skills / coverage say how much of it was measured.
     */
    async getRoleCandidates(roleId, filters = {}, limit = 25) {
        const params = [Number(roleId), Number(roleId)];
        const scope = this._scope(filters, params, 'd');
        // Effective level: a HELD certificate that has lapsed (expired/revoked,
        // v_certification_lapsed, migration 78) counts as 0 — the candidate may
        // not perform that task today. "Assessed" is the raw assessment's
        // existence (sa.level IS NOT NULL), so coverage and the
        // department-designed requirement count are unchanged by a lapse.
        return await db.all(
            `WITH req AS (
                 SELECT rsr.skill_id, rsr.required_level, rsr.is_critical
                 FROM role_skill_requirements rsr WHERE rsr.role_id = ? AND rsr.required_level > 0
             )
             SELECT d.employee_id, d.full_name, d.employee_number, d.role_name AS current_role,
                    ROUND(100.0 * SUM(CASE WHEN sa.level IS NOT NULL
                                           THEN LEAST(CASE WHEN cl.employee_id IS NOT NULL THEN 0 ELSE sa.level END, req.required_level) END)
                          / NULLIF(SUM(CASE WHEN sa.level IS NOT NULL THEN req.required_level END), 0), 0) AS fit,
                    COUNT(*) FILTER (WHERE sa.level IS NOT NULL
                                       AND (CASE WHEN cl.employee_id IS NOT NULL THEN 0 ELSE sa.level END) < req.required_level)::int AS gap_skills,
                    COUNT(*) FILTER (WHERE req.is_critical AND sa.level IS NOT NULL
                                       AND (CASE WHEN cl.employee_id IS NOT NULL THEN 0 ELSE sa.level END) < req.required_level)::int AS crit_gap_skills,
                    SUM(CASE WHEN sa.level IS NOT NULL THEN 1 ELSE 0 END)::int AS assessed_skills,
                    COUNT(*)::int AS req_skills,
                    (COUNT(*) - SUM(CASE WHEN sa.level IS NOT NULL THEN 1 ELSE 0 END))::int AS unmeasured_skills,
                    ROUND(100.0 * SUM(CASE WHEN sa.level IS NOT NULL THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 0) AS coverage,
                    -- Is this fit trustworthy enough to rank on? Same 80 %
                    -- threshold the succession bench already applies
                    -- (ContinuityService.READY_NOW_COVERAGE_FLOOR), so the two
                    -- surfaces cannot disagree about who is "measured enough".
                    (100.0 * SUM(CASE WHEN sa.level IS NOT NULL THEN 1 ELSE 0 END)
                        / NULLIF(COUNT(*), 0) >= 80) AS meets_coverage_floor
             FROM v_employee_details d
             CROSS JOIN req
             LEFT JOIN v_resolved_assessments sa ON sa.employee_id = d.employee_id AND sa.skill_id = req.skill_id
             LEFT JOIN v_certification_lapsed cl ON cl.employee_id = d.employee_id AND cl.skill_id = req.skill_id
             WHERE d.is_active = true AND d.role_id IS NOT NULL AND d.role_id <> ? ${scope}
               -- Perf: only rank employees with >= 1 assessment overlapping the role's
               -- requirements. An unassessed candidate scores 0/NULL anyway, and this
               -- collapses the CROSS JOIN from (all employees x req skills) to the
               -- plausible pool.
               --
               -- Reads the RESOLVED view, like the join above: over the raw
               -- table a candidate whose every measurement came through the
               -- approved self-assessment workflow failed this test and never
               -- appeared as a candidate at all.
               AND EXISTS (SELECT 1 FROM v_resolved_assessments x JOIN req rq ON rq.skill_id = x.skill_id
                            WHERE x.employee_id = d.employee_id)
             GROUP BY d.employee_id, d.full_name, d.employee_number, d.role_name
             HAVING SUM(req.required_level) > 0
             -- Coverage-aware ranking. fit is computed over the ASSESSED
             -- requirements only, so it says nothing about how much of the role
             -- was actually measured: on role 87 (63 requirements) a candidate
             -- measured on FOUR of them scored 100 % and was published third,
             -- above candidates measured on 25. Fit alone cannot order this
             -- list — a planner reading top-down met the least-measured person
             -- first. Adequately measured candidates now rank above thinly
             -- measured ones; within a band the better fit wins, and coverage
             -- breaks a fit tie so the better-evidenced candidate leads.
             ORDER BY meets_coverage_floor DESC NULLS LAST,
                      fit DESC NULLS LAST,
                      coverage DESC NULLS LAST,
                      crit_gap_skills ASC, full_name
             LIMIT ${Number(limit) || 25}`,
            params
        );
    }
}

module.exports = new BenchmarkModel();
