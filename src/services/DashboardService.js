const DashboardModel = require('../models/DashboardModel');
const db = require('../config/database');
const { TtlCache, dashboardCache } = require('../utils/ttlCache');

const THRESHOLDS = {
    READINESS_GOOD: 80,
    READINESS_WARNING: 50,
    COVERAGE_GOOD: 90,
    COVERAGE_WARNING: 70,
    CRITICAL_COMPLIANCE_GOOD: 95,
    CRITICAL_COMPLIANCE_WARNING: 80,
};

// ---------------------------------------------------------------------------
// Executive-overview cache — SHORT TTL, SCOPE-KEYED, EXPLICITLY INVALIDATED.
//
// getExecutiveData fires seven view aggregates plus the provenance rollup on
// every call, and it is the single hottest read in the product (the dashboard
// landing page, and every filter change on it). Nothing about it is per-user
// EXCEPT the scope — so the cache key must be the resolved scope, and only the
// resolved scope.
//
// SECURITY, not performance, drives the key design:
//   * `scopeKey` below enumerates every filter dimension DashboardModel
//     actually reads. If a caller passes a dimension that is NOT on that list,
//     scopeKey returns null and the request BYPASSES the cache entirely. A
//     future filter can therefore never be silently dropped from the key and
//     hand one site's numbers to another site's director — the failure mode is
//     a slow request, not a leak.
//   * ID arrays are normalised (stringified + sorted) so [2,1] and ['1','2']
//     are one scope rather than two entries with identical contents.
//   * Every hit returns a deep clone, so a caller that decorates the object it
//     got back can never mutate what the next caller in the same scope sees.
//
// INVALIDATION: assessment writes (SkillAssessmentService.record*) and bulk
// imports (UnifiedJsonService) already call dashboardCache.bust; this cache
// subscribes to that same signal, so there is exactly ONE invalidation point in
// the codebase and it cannot drift. Talent-placement writes go through
// DashboardService.invalidate for callers that need it. The 20 s TTL is the
// backstop for anything that writes the underlying tables outside those paths
// (SQL console, migrations, direct psql) — it bounds staleness without being
// relied upon as the primary mechanism.
// ---------------------------------------------------------------------------
// SIZING: one entry per distinct RESOLVED SCOPE (not per user), so the working
// set is the number of distinct site/department/service/employee-id combinations
// in flight. 300 was below the ~200-concurrent-manager figure this is sized for
// once each manager's own governed-id list counts as its own scope, and eviction
// used to be FIFO — a scope being read every second was dropped as readily as
// one nobody had touched (TtlCache is LRU as of this pass). The full executive
// payload measured 10.7 KB on the the dev dataset org shape, so 1 000 entries is ~11 MB
// at full occupancy. Override with DASHBOARD_EXEC_CACHE_MAX_ENTRIES.
const EXEC_CACHE_TTL_MS = Number(process.env.DASHBOARD_EXEC_CACHE_TTL_MS || 20_000);
const EXEC_CACHE_MAX = Math.max(50, Number(process.env.DASHBOARD_EXEC_CACHE_MAX_ENTRIES) || 1000);
const execCache = new TtlCache(EXEC_CACHE_TTL_MS, EXEC_CACHE_MAX);
// One bust signal for both caches — see SkillAssessmentService / UnifiedJsonService.
if (typeof dashboardCache.onBust === 'function') dashboardCache.onBust(() => execCache.bust());

// Every filter dimension DashboardModel._buildFilterClause / the model queries
// consume. Keep in lockstep with the model: anything missing here disables the
// cache for that request rather than mis-keying it.
const SCOPE_FIELDS = [
    'siteName',
    'departmentName',
    'serviceName',
    'roleName',
    'domainName',
    'siteIds',
    'departmentIds',
    'serviceIds',
    'employeeIds',
    'requiredOnly',
];

const isEmptyFilterValue = (v) =>
    v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/**
 * Canonical cache key for a resolved RBAC scope, or null when the scope
 * contains a dimension this function cannot key (→ do not cache).
 */
function scopeKey(prefix, filters) {
    const f = filters || {};
    for (const k of Object.keys(f)) {
        if (isEmptyFilterValue(f[k])) continue;
        if (!SCOPE_FIELDS.includes(k)) return null; // fail closed
    }
    const parts = SCOPE_FIELDS.map((k) => {
        const v = f[k];
        if (isEmptyFilterValue(v)) return null;
        return Array.isArray(v) ? v.map(String).sort() : String(v);
    });
    // JSON, not a delimiter join: a site literally named "A|B" must not be able
    // to collide with the scope {site:'A', department:'B'}. The key is a
    // security boundary, so it gets an unambiguous encoding.
    return `${prefix}|${JSON.stringify(parts)}`;
}

const clone = (v) => (v === null || v === undefined ? v : structuredClone(v));

// Single-flight: concurrent misses in the SAME scope share one computation
// instead of each stampeding the seven aggregates. Keyed by the scope key, so a
// shared result is always inside one scope.
const inflight = new Map();

class DashboardService {
    constructor() {
        this.THRESHOLDS = THRESHOLDS;
    }

    /**
     * Drop every cached executive-overview payload. Call after any write that
     * moves assessments, requirements or talent placements. Assessment writes
     * and imports already reach this through dashboardCache.bust.
     */
    invalidate() {
        execCache.bust();
        inflight.clear();
    }

    /** Test/diagnostic hook: current cached-entry count. */
    _cacheSize() {
        return execCache.map.size;
    }

    // -------------------------------------------------------------------------
    // Assessment provenance (migration 71)
    //
    // Every readiness/gap number in this app resolves a MISSING assessment to
    // level 0 (v_employee_skill_gaps does COALESCE(ra.level, 0)). That makes
    // "never assessed" indistinguishable from an honest, earned zero: an org
    // where nobody has been evaluated reads as 0 % readiness, exactly like an
    // org that was fully evaluated and failed.
    //
    // Nothing below recomputes an existing number. The legacy KPIs are returned
    // untouched; these methods ADD the denominators (assessed / expected) and
    // the per-requirement provenance a reader needs to interpret them.
    // -------------------------------------------------------------------------

    /**
     * Org-level provenance rollup for the current scope.
     * Returns null (never a fake zero) if the provenance views are unavailable.
     */
    async getAssessmentProvenance(filters) {
        try {
            const params = [];
            const filterClause = DashboardModel._buildFilterClause(filters, params, 'c');

            const sql = `
                SELECT
                    COUNT(*) as employees_total,
                    COUNT(CASE WHEN c.assessed_skills > 0 THEN 1 END) as employees_assessed,
                    COUNT(CASE WHEN c.never_assessed_skills = 0 THEN 1 END) as employees_fully_assessed,
                    COALESCE(SUM(c.expected_skills), 0) as expected_skills,
                    COALESCE(SUM(c.assessed_skills), 0) as assessed_skills,
                    COALESCE(SUM(c.never_assessed_skills), 0) as never_assessed_skills,
                    COALESCE(SUM(c.self_only_skills), 0) as self_only_skills,
                    COALESCE(SUM(c.validated_skills), 0) as validated_skills,
                    ROUND(AVG(c.readiness_assessed_only), 1) as avg_readiness_assessed_only
                FROM v_employee_assessment_coverage c
                WHERE 1=1 ${filterClause}
            `;

            const row = await db.get(sql, params);
            if (!row) return null;

            const expected = Number(row.expectedSkills) || 0;
            const assessed = Number(row.assessedSkills) || 0;
            const employeesTotal = Number(row.employeesTotal) || 0;
            const employeesAssessed = Number(row.employeesAssessed) || 0;

            return {
                employeesTotal,
                employeesAssessed,
                employeesNeverAssessed: employeesTotal - employeesAssessed,
                employeesFullyAssessed: Number(row.employeesFullyAssessed) || 0,
                expectedSkills: expected,
                assessedSkills: assessed,
                neverAssessedSkills: Number(row.neverAssessedSkills) || 0,
                selfOnlySkills: Number(row.selfOnlySkills) || 0,
                validatedSkills: Number(row.validatedSkills) || 0,
                // assessed / expected — the denominator a director needs to read
                // any readiness percentage honestly.
                skillCoverage: expected > 0 ? Math.round((1000 * assessed) / expected) / 10 : null,
                employeeCoverage:
                    employeesTotal > 0
                        ? Math.round((1000 * employeesAssessed) / employeesTotal) / 10
                        : null,
                // Parallel readiness over ASSESSED requirements only. NULL when
                // nothing was ever assessed — deliberately not 0.
                avgReadinessAssessedOnly:
                    row.avgReadinessAssessedOnly === null ||
                    row.avgReadinessAssessedOnly === undefined
                        ? null
                        : Number(row.avgReadinessAssessedOnly),
            };
        } catch (err) {
            // Provenance is additive: a dashboard must still render without it.
            console.error('Error computing assessment provenance:', err.message);
            return null;
        }
    }

    /**
     * Per-skill provenance for a set of skill ids, scoped like every other
     * dashboard query. Map: skillId -> { expected, assessed, neverAssessed, selfOnly }.
     */
    async getSkillProvenance(skillIds, filters) {
        const out = new Map();
        const ids = (skillIds || []).filter((id) => id !== null && id !== undefined);
        if (!ids.length) return out;

        try {
            const params = [];
            const filterClause = DashboardModel._buildFilterClause(filters, params, 'p');
            const placeholders = ids.map(() => '?').join(',');
            params.push(...ids);

            const sql = `
                SELECT
                    p.skill_id,
                    COUNT(*) as expected_employees,
                    COALESCE(SUM(p.is_assessed), 0) as assessed_employees,
                    SUM(CASE WHEN p.assessment_status = 'never_assessed' THEN 1 ELSE 0 END) as never_assessed_employees,
                    SUM(CASE WHEN p.assessment_status = 'self_only' THEN 1 ELSE 0 END) as self_only_employees
                FROM v_requirement_provenance p
                WHERE 1=1 ${filterClause} AND p.skill_id IN (${placeholders})
                GROUP BY p.skill_id
            `;

            const rows = await db.all(sql, params);
            rows.forEach((r) => {
                out.set(String(r.skillId), {
                    expectedEmployees: Number(r.expectedEmployees) || 0,
                    assessedEmployees: Number(r.assessedEmployees) || 0,
                    neverAssessedEmployees: Number(r.neverAssessedEmployees) || 0,
                    selfOnlyEmployees: Number(r.selfOnlyEmployees) || 0,
                });
            });
        } catch (err) {
            console.error('Error computing skill provenance:', err.message);
        }
        return out;
    }

    async getFilterOptions(filters) {
        const opts = await DashboardModel.getFilterOptions(filters);
        // The dashboard filters employees by department/service NAME, and the same
        // name legitimately exists under many sites — so show each name once instead
        // of once per site (was listing e.g. "IT" 9x). Sites/roles/domains are already
        // distinct by name.
        const { distinctByName } = require('../utils/orgFilters');
        if (opts) {
            opts.departments = distinctByName(opts.departments);
            opts.services = distinctByName(opts.services);
        }
        return opts;
    }

    /**
     * Executive Overview Data
     * Aggregates multiple sources to populate the top-level KPI cards and charts.
     *
     * Served from the short-TTL, SCOPE-KEYED cache above unless
     * `options.cache === false` (or the call is inside a transaction). The
     * cached payload is byte-identical to the uncached one — see
     * tests/unit/dashboardExecCache.test.js, which asserts equality and that
     * two different scopes never share an entry.
     */
    async getExecutiveData(filters, options = {}) {
        // options.cache: false = never, true = force (the load test measuring
        // the cached path inside its rollback transaction), omitted = auto.
        // Auto bypasses inside a transaction: caching a mid-transaction read
        // would publish UNCOMMITTED numbers to every other caller in the scope.
        const inTx = typeof db.inTransaction === 'function' && db.inTransaction();
        const useCache = options.cache === false ? false : options.cache === true ? true : !inTx;
        const key = useCache ? scopeKey('exec', filters) : null;

        if (key) {
            const hit = execCache.get(key);
            if (hit !== undefined) return clone(hit);
            const pending = inflight.get(key);
            if (pending) return clone(await pending);
        }

        const compute = this._computeExecutiveData(filters);
        if (!key) return compute;

        inflight.set(key, compute);
        try {
            const data = await compute;
            execCache.set(key, data);
            return clone(data);
        } finally {
            if (inflight.get(key) === compute) inflight.delete(key);
        }
    }

    /** Uncached path. getExecutiveData is the cached wrapper around this. */
    async _computeExecutiveData(filters) {
        try {
            const [
                kpis,
                readinessBySite,
                readinessByService,
                distribution,
                staffing,
                trend, // destructure
                provenance,
            ] = await Promise.all([
                DashboardModel.getOverviewKPIs(filters),
                DashboardModel.getReadinessByGroup('site', filters),
                DashboardModel.getReadinessByGroup('service', filters),
                DashboardModel.getReadinessDistribution(filters),
                DashboardModel.getRoleStaffing(filters),
                this.getReadinessTrend(filters), // New trend data
                this.getAssessmentProvenance(filters),
            ]);

            // Attach — never overwrite. Every legacy KPI keeps the exact value it
            // had; `provenance` only says how much of the workforce those values
            // are actually based on.
            if (kpis) kpis.provenance = provenance;

            // Month-on-month movement from the RECORDED snapshots (migration 82).
            //
            // ABSENT, NOT ZERO: `deltas.values` carries a key only for metrics
            // that have a real prior value AND a real current value. With no
            // prior snapshot the object is empty and every card renders without
            // a delta. This is a dev machine with almost no history — a
            // confident "+0" drawn from one day of data would be a fabricated
            // trend, which is worse than none.
            if (kpis) {
                kpis.deltas = { since: null, values: {} };
                try {
                    const scope = await this._snapshotScope(filters);
                    if (scope) {
                        const KpiSnapshotService = require('./KpiSnapshotService');
                        // fingerprint WHO is measured now, so the delta can tell
                        // a real movement in the same cohort from a change of cohort
                        // (a net-zero head change can be a whole different set).
                        try {
                            kpis.measuredSignature =
                                await DashboardModel.getMeasuredSignature(filters);
                        } catch {
                            kpis.measuredSignature = null;
                        }
                        kpis.deltas = await KpiSnapshotService.deltas(
                            kpis,
                            scope.scopeType,
                            scope.scopeId,
                            28
                        );
                    }
                } catch (e) {
                    // A delta is a nicety; never let it take the dashboard down.
                    console.error('KPI delta lookup failed:', e.message);
                }
            }

            // Extend KPIs if needed (some values already come from getOverviewKPIs)
            // kpis has: totalEmployees, mappedEmployees, avgReadiness, assessmentCoverage, criticalCompliance
            // We need: roleReadyCount, criticalGapCount. These are also returned by getOverviewKPIs in my implementation.

            return {
                kpis,
                readinessBySite,
                readinessByService,
                distribution,
                staffing,
                trend,
            };
        } catch (error) {
            console.error('Error in getExecutiveData:', error);
            throw new Error('Failed to retrieve executive dashboard data');
        }
    }

    /**
     * Training & Investment Priorities
     * Calculates Impact Score for skill gaps.
     */
    async getTrainingPriorities(filters) {
        try {
            const [skillGaps, domainGaps, gapsByService] = await Promise.all([
                DashboardModel.getSkillGaps(filters, 20),
                DashboardModel.getDomainGaps(filters),
                DashboardModel.getGapsByService(filters, 10),
            ]);

            // Compute impactScore for skillGaps
            // Formula: (totalGapPoints × affectedEmployees) / 10
            const priorities = skillGaps
                .map((gap) => {
                    const impactScore =
                        Math.round(((gap.totalGapPoints * gap.affectedEmployees) / 10) * 10) / 10;
                    return {
                        ...gap,
                        impactScore,
                    };
                })
                .sort((a, b) => b.impactScore - a.impactScore);

            // getSkillGaps only counts people who HAVE an assessment (isAssessed = 1),
            // so "affected employees" silently omits everyone the skill was never
            // measured on — the impact of a skill nobody was ever assessed on reads
            // as zero. Attach the missing denominator per skill; the ranking numbers
            // themselves are untouched.
            const provenanceBySkill = await this.getSkillProvenance(
                priorities.map((p) => p.skillId),
                filters
            );
            priorities.forEach((p) => {
                const prov = provenanceBySkill.get(String(p.skillId));
                p.provenance = prov || null;
                p.neverAssessedEmployees = prov ? prov.neverAssessedEmployees : null;
                p.selfOnlyEmployees = prov ? prov.selfOnlyEmployees : null;
                p.expectedEmployees = prov ? prov.expectedEmployees : null;
            });

            return {
                priorities,
                domainGaps,
                gapsByService,
            };
        } catch (error) {
            console.error('Error in getTrainingPriorities:', error);
            throw new Error('Failed to retrieve training priorities');
        }
    }

    async getEmployeeList(filters, options) {
        return await DashboardModel.getEmployeeList(filters, options);
    }

    /**
     * Employee Profile
     * Groups skills by domain and extracts insights.
     */
    async getEmployeeProfile(employeeId, filters) {
        try {
            const profile = await DashboardModel.getEmployeeDetail(employeeId, filters);

            if (!profile) return null;

            // v_employee_skill_gaps coalesces a missing assessment to actualLevel 0,
            // so an untouched record renders as a wall of honest-looking zeros.
            // Stamp each required skill with where its level actually came from.
            const coverage = await this.getEmployeeCoverage(employeeId);
            const statusBySkill = coverage ? coverage.statusBySkill : null;
            if (statusBySkill) {
                profile.skills.forEach((s) => {
                    const prov = statusBySkill.get(String(s.skillId));
                    s.assessmentStatus = prov ? prov.assessmentStatus : 'never_assessed';
                    s.assessmentSource = prov ? prov.source : null;
                    s.assessedAt = prov ? prov.assessedAt : null;
                    // The un-coalesced level: null means nobody ever rated this.
                    s.assessedLevel = prov ? prov.assessedLevel : null;
                    // When a certificate has lapsed the effective level is 0 but a
                    // rating exists; carry the raw rating and the flag so the card
                    // shows "certificate lapsed", not "supervisor rated you 0".
                    s.certLapsed = prov ? prov.certLapsed === true : false;
                    s.ratedLevel = prov ? prov.ratedLevel : null;
                });
            }

            // Group skills by domain
            const domainMap = new Map();
            profile.skills.forEach((skill) => {
                if (!domainMap.has(skill.domainId)) {
                    domainMap.set(skill.domainId, {
                        domainId: skill.domainId,
                        domainName: skill.domainName,
                        skills: [],
                    });
                }
                domainMap.get(skill.domainId).skills.push(skill);
            });

            // Convert to array and sort by domain name
            const domainGroups = Array.from(domainMap.values()).sort((a, b) =>
                a.domainName.localeCompare(b.domainName)
            );

            // Extract Top 5 Gaps (gap > 0, desc)
            const topGaps = profile.skills
                .filter((s) => s.status === 'gap' && typeof s.gap === 'number' && s.gap > 0)
                .sort((a, b) => b.gap - a.gap) // largest gap first
                .slice(0, 5);

            // Extract Strengths (actual > required)
            const strengths = profile.skills
                .filter(
                    (s) =>
                        s.status === 'exceeded' ||
                        (s.status === 'met' && s.actualLevel > s.requiredLevel)
                )
                // User spec: "exceeded" means actual > required.
                // My model SQL sets status='exceeded' correctly.
                .sort(
                    (a, b) => b.actualLevel - b.requiredLevel - (a.actualLevel - a.requiredLevel)
                );

            return {
                info: profile.info,
                domainGroups,
                topGaps,
                strengths,
                coverage: coverage ? coverage.summary : null,
            };
        } catch (error) {
            console.error('Error in getEmployeeProfile:', error);
            throw error;
        }
    }

    async getCapabilityMapData(filters, groupBy) {
        try {
            // Validate groupBy here as well or rely on model validation
            // User spec says: validate groupBy against whitelist
            if (!['site', 'service'].includes(groupBy)) throw new Error('Invalid groupBy');

            const [heatmap, staffing] = await Promise.all([
                DashboardModel.getDomainHeatmap(groupBy, filters),
                DashboardModel.getRoleStaffing(filters),
            ]);

            return {
                heatmap,
                staffing,
            };
        } catch (error) {
            console.error('Error in getCapabilityMapData:', error);
            throw error;
        }
    }

    /**
     * One employee's requirement-level provenance + coverage summary.
     * { summary: {...}, statusBySkill: Map(skillId -> {...}) } or null.
     */
    async getEmployeeCoverage(employeeId) {
        try {
            // Serialised on purpose: inside a runTransaction the whole call
            // tree shares ONE pg client, and two concurrent queries on the same
            // client are a node-pg deprecation (and a future error).
            const summaryRow = await db.get(
                `SELECT expected_skills, assessed_skills, never_assessed_skills, self_only_skills,
                        validated_skills, coverage, readiness_assessed_only
                 FROM v_employee_assessment_coverage WHERE employee_id = ?`,
                [employeeId]
            );
            const rows = await db.all(
                `SELECT skill_id, assessment_status, assessed_level, rated_level, cert_lapsed, source, assessed_at
                 FROM v_requirement_provenance WHERE employee_id = ?`,
                [employeeId]
            );

            const statusBySkill = new Map();
            (rows || []).forEach((r) => {
                statusBySkill.set(String(r.skillId), {
                    assessmentStatus: r.assessmentStatus,
                    // assessed_level is the EFFECTIVE level (0 when a cert has lapsed);
                    // rated_level is what the supervisor/self actually recorded. Carry
                    // both plus the lapse flag so the profile can say "certificate
                    // lapsed" instead of misreading a degraded 0 as "rated 0".
                    assessedLevel:
                        r.assessedLevel === null || r.assessedLevel === undefined
                            ? null
                            : Number(r.assessedLevel),
                    ratedLevel:
                        r.ratedLevel === null || r.ratedLevel === undefined
                            ? null
                            : Number(r.ratedLevel),
                    certLapsed: r.certLapsed === true,
                    source: r.source || null,
                    assessedAt: r.assessedAt || null,
                });
            });

            const summary = summaryRow
                ? {
                      expectedSkills: Number(summaryRow.expectedSkills) || 0,
                      assessedSkills: Number(summaryRow.assessedSkills) || 0,
                      neverAssessedSkills: Number(summaryRow.neverAssessedSkills) || 0,
                      selfOnlySkills: Number(summaryRow.selfOnlySkills) || 0,
                      validatedSkills: Number(summaryRow.validatedSkills) || 0,
                      coverage:
                          summaryRow.coverage === null || summaryRow.coverage === undefined
                              ? null
                              : Number(summaryRow.coverage),
                      readinessAssessedOnly:
                          summaryRow.readinessAssessedOnly === null ||
                          summaryRow.readinessAssessedOnly === undefined
                              ? null
                              : Number(summaryRow.readinessAssessedOnly),
                  }
                : null;

            return { summary, statusBySkill };
        } catch (err) {
            console.error('Error computing employee coverage:', err.message);
            return null;
        }
    }

    async getGapDrilldown(skillId, filters) {
        const employees = await DashboardModel.getGapDrilldown(skillId, filters);

        // The drilldown lists only ASSESSED people (getGapDrilldown filters
        // isAssessed = 1) — but "assessed" still bundles a supervisor-validated
        // level together with an auto-approved self-rating. Say which is which.
        try {
            const params = [];
            const filterClause = DashboardModel._buildFilterClause(filters, params, 'p');
            params.push(skillId);
            const rows = await db.all(
                `SELECT p.employee_id, p.assessment_status, p.source
                 FROM v_requirement_provenance p
                 WHERE 1=1 ${filterClause} AND p.skill_id = ?`,
                params
            );
            const byEmployee = new Map((rows || []).map((r) => [String(r.employeeId), r]));
            employees.forEach((e) => {
                const r = byEmployee.get(String(e.employeeId));
                e.assessmentStatus = r ? r.assessmentStatus : 'never_assessed';
                e.assessmentSource = r ? r.source : null;
            });
        } catch (err) {
            console.error('Error annotating gap drilldown provenance:', err.message);
        }

        return { employees };
    }

    async getDomainRadarData(groupId, groupBy, filters) {
        return await DashboardModel.getDomainRadarData(groupId, groupBy, filters);
    }

    async getReadinessByGroup(groupBy, filters) {
        return await DashboardModel.getReadinessByGroup(groupBy, filters);
    }

    async getReadinessDistribution(filters) {
        return await DashboardModel.getReadinessDistribution(filters);
    }

    async getRoleStaffing(filters) {
        return await DashboardModel.getRoleStaffing(filters);
    }

    async getSkillGaps(filters) {
        // This is technically part of getTrainingPriorities logic but exposed as API if needed separately
        // The prompt says getSkillGaps -> service.getTrainingPriorities in controller?
        // Actually controller mappings:
        // getSkillGaps(req, res) -> service.getTrainingPriorities
        // So this method might not be called directly from controller for that endpoint.
        // But let's expose it just in case.
        return await DashboardModel.getSkillGaps(filters);
    }

    async getDomainGaps(filters) {
        return await DashboardModel.getDomainGaps(filters);
    }

    async getGapsByService(filters) {
        return await DashboardModel.getGapsByService(filters);
    }

    async getGapsByGroup(groupBy, filters) {
        return await DashboardModel.getGapsByGroup(groupBy, filters);
    }

    // -------------------------------------------------------------------------
    // New Components Logic
    // -------------------------------------------------------------------------

    /**
     * Executive readiness trend — REAL stored history, never a reconstruction.
     *
     * WHAT WAS HERE BEFORE (and why it is gone)
     *   The series was BACK-CAST: it took the current sum of
     *   readiness_assessed_only — a sum of PERCENTAGES — and walked backwards
     *   subtracting `SUM(newLevel - previousLevel)` from assessmentHistory, which
     *   is a sum of raw 0-4 SKILL LEVELS. Percentages minus levels is not a
     *   quantity; every historical point was arithmetically meaningless. It also
     *   held the employee count constant across all six months, so hiring and
     *   leaving silently moved the line. The chart then plotted the result on a
     *   {min:0, max:4} axis while feeding it values around 82, which pegged the
     *   line off the top of the plot area — the first chart on the executive
     *   dashboard rendered nothing at all.
     *
     *   None of that is fixable by rescaling: there is no valid conversion from
     *   level-deltas to percentage-points. The only honest trend is a trend that
     *   was actually recorded, so this now reads kpi_snapshots (migration 82),
     *   written daily by jobs/kpi-snapshot.js.
     *
     * SCOPE RESOLUTION
     *   Snapshots exist for two scopes: 'org' and one per site. The caller sees
     *   a series only when their view maps onto a recorded scope:
     *     - exactly one site in the filters/RBAC scope -> that site's series
     *     - an unrestricted caller with no site filter -> the org series
     *     - anything narrower (a department, a manager's sub-tree) -> NO series,
     *       with reason 'no_scoped_history'. Showing the org line to someone who
     *       can only see one department would be a different population than the
     *       KPI printed above it.
     *
     * HONESTY
     *   Points whose avg_readiness was NULL (nothing measured that day) are
     *   dropped rather than plotted as 0. A single stored point is returned as a
     *   single point; the caller renders no delta from it.
     *
     * @returns {Promise<{series: Array<{date, avg, coverage, measured}>, unit: 'percent', scopeType: string|null, scopeId: number|null, reason: string|null}>}
     */
    /**
     * Map a filter set onto a RECORDED snapshot scope, or null when the view is
     * narrower than anything kpi_snapshots holds ('org' + one row per site).
     *
     * Shared by the trend chart and the KPI-card deltas so the two can never
     * disagree about which population they are describing.
     * @returns {Promise<{scopeType:'org'|'site', scopeId:number}|null>}
     */
    async _snapshotScope(filters) {
        const f = filters || {};
        // A department/service/role/manager filter narrows below any recorded scope.
        const narrowed = Boolean(
            f.departmentName ||
            f.serviceName ||
            f.roleName ||
            (f.departmentIds && f.departmentIds.length) ||
            (f.serviceIds && f.serviceIds.length) ||
            (f.employeeIds && f.employeeIds.length)
        );
        if (narrowed) return null;

        if (f.siteIds && f.siteIds.length === 1) {
            return { scopeType: 'site', scopeId: Number(f.siteIds[0]) };
        }
        if (f.siteName) {
            const db = require('../config/database');
            const row = await db.get('SELECT id FROM sites WHERE name = ?', [f.siteName]);
            return row ? { scopeType: 'site', scopeId: Number(row.id) } : null;
        }
        // A multi-site but sub-org scope has no recorded equivalent.
        if (f.siteIds && f.siteIds.length > 1) return null;
        return { scopeType: 'org', scopeId: 0 };
    }

    async getReadinessTrend(filters) {
        const empty = (reason) => ({
            series: [],
            unit: 'percent',
            scopeType: null,
            scopeId: null,
            reason,
        });
        try {
            const KpiSnapshotService = require('./KpiSnapshotService');

            const scope = await this._snapshotScope(filters);
            if (!scope) return empty('no_scoped_history');
            const { scopeType, scopeId } = scope;

            const rows = await KpiSnapshotService.series(scopeType, scopeId, 400);
            const series = (rows || [])
                // NULL readiness = nothing measured that day. Dropped, never zeroed.
                .filter((r) => r.avgReadiness !== null && r.avgReadiness !== undefined)
                .map((r) => ({
                    date: r.date,
                    avg: Number(r.avgReadiness),
                    coverage: r.assessmentCoverage === null ? null : Number(r.assessmentCoverage),
                    measured: r.measuredEmployees === null ? null : Number(r.measuredEmployees),
                }));

            return {
                series,
                unit: 'percent',
                scopeType,
                scopeId,
                reason: series.length ? null : 'no_history_yet',
            };
        } catch (err) {
            console.error('Error reading readiness trend:', err);
            return empty('error');
        }
    }

    async getManagerActionBoard(filters) {
        try {
            const [stale, experts] = await Promise.all([
                DashboardModel.getStaleAssessments(filters),
                DashboardModel.getTeamExperts(filters),
            ]);

            return {
                staleAssessments: stale,
                teamExperts: experts,
            };
        } catch (err) {
            console.error('Error fetching manager action board:', err);
            return { staleAssessments: [], teamExperts: [] };
        }
    }

    async getOrgDomainRadar(filters) {
        return await DashboardModel.getOrgDomainRadar(filters);
    }

    async getOrgSubDomainRadar(filters) {
        return await DashboardModel.getOrgSubDomainRadar(filters);
    }

    async getComparatorRadars(filters, compOptions = {}) {
        return await DashboardModel.getComparatorRadars(filters, compOptions);
    }

    /**
     * Strategic Insights — Aggregates all executive-level insight data
     * into a single response for the strategic insights panel.
     */
    async getStrategicInsights(filters) {
        try {
            // the strategic overview is an ORG/role-level panel. Its risk
            // index, critical-role and org-health KPIs are computed over the
            // employee/coverage views (alias 'e'/'c'), which have no capability
            // domain axis, so a `domainName` filter could only ever reach ONE
            // sub-metric (getOrgHealthMetrics' top-impact gaps, alias 'g') and not
            // the others — putting a domain-scoped number beside org-wide ones on
            // the same panel. Drop the domain axis here so every figure on this
            // panel is consistently org-wide; the domain drill-down lives on the
            // dedicated capability/gap panels (sub-domain radar, gap analysis)
            // that honour it.
            const orgFilters = { ...filters };
            delete orgFilters.domainName;
            const [riskIndex, criticalRoles, orgHealth] = await Promise.all([
                DashboardModel.getWorkforceRiskIndex(orgFilters),
                DashboardModel.getCriticalRolesDetail(orgFilters),
                DashboardModel.getOrgHealthMetrics(orgFilters),
            ]);

            return {
                riskIndex,
                criticalRoles,
                orgHealth,
            };
        } catch (error) {
            console.error('Error in getStrategicInsights:', error);
            throw new Error('Failed to retrieve strategic insights');
        }
    }

    // -------------------------------------------------------------------------
    // Campaign completion — read from the ROSTER (migration 70), never from
    // self_assessments.
    //
    // THE DEFECT THIS REPLACES: completion used to be
    //     (rows - unsubmitted rows) / rows  FROM self_assessments
    // and a self_assessments row only exists once somebody has ACTED. With 5 of
    // 78 people submitted, the only rows in the table were the 5 submitted ones,
    // so the denominator was 5 and the strip read 100 % complete while 73 people
    // had not touched the campaign. Leadership stood down on a campaign that had
    // barely begun — the same wrong-denominator class of bug that made an entire
    // campaign invisible (see the header of 70_cycle_participants.sql).
    //
    // The roster is stamped at LAUNCH from the employee population, so the
    // non-starter is IN the denominator. `enrolled` counts the people actually
    // being asked (roster minus PERSON-level exclusions); it is never a skill
    // subset — expected_skills always carries the FULL department-designed
    // catalogue and nothing here samples, waves or tiers it.
    //
    // Empty case is explicit: no roster enrolled in the caller's scope means
    // `launched: false` and `completionPct: null` — "campagne non lancée",
    // NEVER 100 %.
    // -------------------------------------------------------------------------

    /**
     * Header row of the CURRENT campaign, or null when none is running. Open
     * first, else the most recent LOCKED one: the review phase is still the
     * campaign, and the dashboard card, the burndown and the manager digest must
     * keep following it while the backlog is what matters. One shared
     * resolver — CycleService.findCurrent — so every surface agrees.
     */
    async getOpenCampaignCycle() {
        return require('./CycleService').findCurrent();
    }

    /**
     * Roster-based funnel for the open campaign, scoped BEFORE aggregation.
     *
     * @param {number[]|null} employeeIds  null = unrestricted (superadmin),
     *                                     [] = nothing visible.
     * @param {object|undefined} cycle     pre-fetched open cycle (the digest
     *                                     resolves it once for all managers);
     *                                     omit to resolve it here.
     * @returns {Promise<object|null>} null when no campaign is open.
     */
    async getCampaignFunnel(employeeIds, cycle) {
        const cyc = cycle === undefined ? await this.getOpenCampaignCycle() : cycle;
        if (!cyc) return null;

        const base = {
            id: cyc.id,
            code: cyc.code,
            label: cyc.label,
            closesAt: cyc.closesAt,
            daysLeft: cyc.closesAt
                ? Math.ceil((new Date(cyc.closesAt) - Date.now()) / 86400000)
                : null,
            rosterAvailable: true,
            launched: false,
            enrolled: 0,
            excluded: 0,
            notStarted: 0,
            inProgress: 0,
            inReview: 0,
            approved: 0,
            submitted: 0,
            unsubmitted: 0,
            completionPct: null,
            approvedPct: null,
            startedPct: null,
        };

        let row;
        try {
            const { scopeClause } = require('../utils/rbacScope');
            const params = [];
            const scope = scopeClause(employeeIds, params, 'v.employee_id');
            row = await db.get(
                `SELECT COUNT(*)::int AS total,
                        COUNT(*) FILTER (WHERE v.participant_state = 'excluded')::int    AS excluded,
                        COUNT(*) FILTER (WHERE v.participant_state = 'not_started')::int AS "notStarted",
                        COUNT(*) FILTER (WHERE v.participant_state = 'in_progress')::int AS "inProgress",
                        COUNT(*) FILTER (WHERE v.participant_state = 'in_review')::int   AS "inReview",
                        COUNT(*) FILTER (WHERE v.participant_state = 'approved')::int    AS approved
                   FROM v_cycle_participant_status v
                  WHERE v.cycle_id = ?${scope}`,
                [cyc.id, ...params]
            );
        } catch (e) {
            // Roster view unavailable (older schema): say so, never invent a
            // percentage from the engagement-only table.
            return { ...base, rosterAvailable: false };
        }

        const n = (v) => Number(v || 0);
        const excluded = n(row && row.excluded);
        const enrolled = n(row && row.total) - excluded; // the people actually asked
        const notStarted = n(row && row.notStarted);
        const inProgress = n(row && row.inProgress);
        const inReview = n(row && row.inReview);
        const approved = n(row && row.approved);
        const submitted = inReview + approved;
        const pct = (num) => (enrolled > 0 ? Math.round((100 * num) / enrolled) : null);

        return {
            ...base,
            launched: enrolled > 0,
            enrolled,
            excluded,
            notStarted,
            inProgress,
            inReview,
            approved,
            submitted,
            unsubmitted: notStarted + inProgress,
            completionPct: pct(submitted),
            approvedPct: pct(approved),
            startedPct: pct(enrolled - notStarted),
        };
    }
}

module.exports = new DashboardService();
