const db = require('../config/database');

// Band an org/role health composite (0..100). Banded on the UNROUNDED value:
// rounding first pushed 79.5 to 80 ("healthy") and 59.5 to 60 ("moderate"),
// flipping the band at its own boundary. Exported for direct boundary testing.
function bandHealthStatus(value) {
    if (value >= 80) return 'healthy';
    if (value >= 60) return 'moderate';
    if (value >= 40) return 'at-risk';
    return 'critical';
}

// ---------------------------------------------------------------------------
// SCOPE PUSHDOWN (see also db/postgres/81_readiness_scope_pushdown.sql)
//
// Every dashboard read filters on the readiness view (`e`) — site, department,
// service, role, or an explicit employee-id list. The coverage view (`c`) is
// LEFT JOINed to it by employee_id ONLY, and an outer-join equivalence class
// built from employee_id carries a *site* predicate exactly nowhere: PostgreSQL
// therefore aggregated v_employee_assessment_coverage over the WHOLE
// ORGANISATION on every scoped query.
//
// Measured on the dev dataset seeded to 4 000 employees, scope = one 2 164-person site
// (scripts/loadtest-readiness.js, all rolled back):
//     getReadinessByGroup(site)   org-wide 4 758 ms → site 4 479 ms → 76-person site 4 081 ms
// i.e. a manager of 76 people paid 86 % of the superadmin's bill, while
// getAssessmentProvenance — which filters ON `c` — went 2 390 → 1 288 → 59 ms.
//
// Both views expose the same org columns for the same employee (they are both
// derived from v_employee_details), so repeating those equalities in the join is
// a tautology on the data and the one thing the planner needs to push the scope
// down. All eight columns are NOT NULL in the schema (employees.site_id etc. are
// NOT NULL with RESTRICT FKs; sites.name etc. are NOT NULL), so no row can be
// lost to a NULL <> NULL comparison on the nullable side of the LEFT JOIN.
// ---------------------------------------------------------------------------
const SCOPE_JOIN_COLS = [
    'siteId',
    'departmentId',
    'serviceId',
    'roleId',
    'siteName',
    'departmentName',
    'serviceName',
    'roleName',
];

/**
 * DashboardModel
 * Pure data access layer for the dashboard.
 * Refactored to use SQL Views for consistency and simplicity.
 */
/**
 * SPAN OF CONTROL AND LAYERS OVER THE REPORTING LINE — 3.23.18. Pure.
 *
 * `rows` = [{ id, parentId }] for the people of a perimeter, parentId being
 * their reporting line (live supervisor, else live employee manager; NULL when
 * none). Returns:
 *   managers  distinct line heads of these people (a head may sit outside the
 *             perimeter — a manager reading their own team is the head of it);
 *   span      people with a line / managers, 1 decimal; null when nobody has a
 *             line (no span was measured, it is not 0);
 *   layers    the deepest chain inside the perimeter. A person whose line is
 *             unset or points outside the perimeter starts a chain at 1.
 *   empty     managers 0, span and layers null on an empty perimeter.
 *
 * CYCLE-SAFE, and nobody is dropped: the SQL this replaces started a recursive
 * CTE from "no manager" roots only, so an A→B→A loop was reachable from no root
 * and its members silently vanished from the count (and a manager's own
 * perimeter, whose top people all HAVE a manager — the reader — had no root at
 * all). Here each walk carries its path; on a loop the chain is cut at the
 * first repeated person, who is counted as a chain top.
 */
function reportingLineStats(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const parent = new Map();
    for (const r of list) {
        const id = Number(r.id);
        if (!Number.isInteger(id)) continue;
        const p = r.parentId == null ? null : Number(r.parentId);
        parent.set(id, Number.isInteger(p) && p > 0 && p !== id ? p : null);
    }
    // An empty perimeter: a COUNT of heads is a true 0 (as the people count is);
    // a ratio and a depth were not measured.
    if (!parent.size) return { managers: 0, span: null, layers: null };

    const heads = new Set();
    let withLine = 0;
    for (const p of parent.values()) {
        if (p != null) {
            heads.add(p);
            withLine++;
        }
    }
    const managers = heads.size;
    const span = managers ? Math.round((withLine / managers) * 10) / 10 : null;

    const depth = new Map();
    for (const start of parent.keys()) {
        if (depth.has(start)) continue;
        const path = [];
        const onPath = new Set();
        let cur = start;
        while (cur != null && parent.has(cur) && !depth.has(cur) && !onPath.has(cur)) {
            path.push(cur);
            onPath.add(cur);
            cur = parent.get(cur);
        }
        if (cur != null && onPath.has(cur)) {
            // A loop: cut it at `cur`, which becomes a chain top (depth 1).
            // parent(path[i]) === path[i + 1], and parent(last) === cur.
            const k = path.indexOf(cur);
            depth.set(cur, 1);
            let d = 1;
            for (let i = path.length - 1; i > k; i--) depth.set(path[i], ++d);
            d = 1;
            for (let i = k - 1; i >= 0; i--) depth.set(path[i], ++d);
            continue;
        }
        // Top of the path is a chain top (no line / line outside the
        // perimeter), or it joins a branch already measured.
        let d = cur != null && depth.has(cur) ? depth.get(cur) : 0;
        for (let i = path.length - 1; i >= 0; i--) depth.set(path[i], ++d);
    }
    let layers = 0;
    for (const v of depth.values()) if (v > layers) layers = v;
    return { managers, span, layers };
}

class DashboardModel {
    /**
     * Managers / span / layers of a perimeter over the REPORTING LINE (see
     * reportingLineStats). `empIds`: null = whole organisation, [] = nobody.
     */
    async reportingLineMeasures(empIds) {
        if (Array.isArray(empIds) && !empIds.length) return reportingLineStats([]);
        const { reportingLineCandidatesSql } = require('../services/GovernanceService');
        const scoped = Array.isArray(empIds);
        const rows = await db.all(
            `SELECT pe.id, ln.id AS "parentId"
               FROM employees pe
               LEFT JOIN LATERAL (
                   SELECT c.id FROM (${reportingLineCandidatesSql('pe')}) c
                    WHERE c.kind = 'employee'
                    ORDER BY c.prio LIMIT 1
               ) ln ON true
              WHERE pe.is_active${scoped ? ' AND pe.id = ANY(?)' : ''}`,
            scoped ? [empIds.map(Number)] : []
        );
        return reportingLineStats(rows);
    }

    // =========================================================================
    // THE ONE READINESS NUMBER  (Wave 2)
    //
    // Migrations 71 / 79 already settled the honest semantics; this model used
    // to ignore them and publish a second, softer answer next to them:
    //
    //   * assessmentCoverage was 100 * COUNT(readiness IS NOT NULL) / COUNT(*).
    //     v_employee_readiness.readiness is NULL only when an employee's role
    //     has NO positive requirement at all, so on any real roster the ratio
    //     is pinned at ~100 % — the exec dashboard printed "Assessment
    //     Coverage 100 %" directly beside the honest "Requirements assessed
    //     74 %". It was never a coverage figure; it was a has-a-benchmark
    //     figure.
    //   * avgReadiness / roleReadyCount / criticalGapCount / the distribution
    //     all read v_employee_readiness.readiness, which COALESCEs a
    //     never-rated requirement to level 0. Someone assessed on 10 of 47
    //     skills therefore scored as if they had FAILED the other 37, and
    //     "employees below 50 %" counted the unmeasured as the weakest people
    //     in the company.
    //
    // CANONICAL from here on:
    //   readiness  = v_employee_assessment_coverage.readiness_assessed_only
    //                (NULL — never 0 — when nothing was ever assessed)
    //   coverage   = SUM(assessed_skills) / SUM(expected_skills), where
    //                expected_skills is the FULL department-designed
    //                requirement count. Nothing is subset, sampled or hidden.
    //
    // The all-requirements figure is NOT deleted — it stays available under a
    // distinct `*AllRequirements` name so the swap is auditable and nobody can
    // read the new number thinking it is the old one.
    // =========================================================================

    /**
     * The canonical readiness source: per-employee readiness (alias `e`) joined
     * to its coverage row (alias `c`). LEFT JOIN so an employee whose role has
     * no requirements still appears in headcounts — with a NULL readiness.
     *
     * The unmapped coverage columns are written in snake_case on purpose: the
     * PostgresDatabase identifier map only rewrites the camelCase tokens it
     * knows, so `c.readiness_assessed_only` passes through verbatim while
     * `e.employeeId`/`e.totalRequired` are still translated as usual.
     */
    _readinessFrom(eAlias = 'e', cAlias = 'c') {
        const scopeQuals = SCOPE_JOIN_COLS.map(
            (col) => `AND ${cAlias}.${col} = ${eAlias}.${col}`
        ).join('\n                   ');
        return `FROM v_employee_readiness ${eAlias}
            LEFT JOIN v_employee_assessment_coverage ${cAlias}
                    ON ${cAlias}.employeeId = ${eAlias}.employeeId
                   ${scopeQuals}`;
    }

    // -------------------------------------------------------------------------
    // Filter & Scope Logic
    // -------------------------------------------------------------------------

    _buildFilterClause(filters, params, tableAlias = 'e') {
        let clause = '';

        // Direct filters (Name-based) - Views have these columns
        if (filters.siteName) {
            clause += ` AND ${tableAlias}.siteName = ?`;
            params.push(filters.siteName);
        }
        if (filters.departmentName) {
            clause += ` AND ${tableAlias}.departmentName = ?`;
            params.push(filters.departmentName);
        }
        if (filters.serviceName) {
            clause += ` AND ${tableAlias}.serviceName = ?`;
            params.push(filters.serviceName);
        }
        if (filters.roleName) {
            clause += ` AND ${tableAlias}.roleName = ?`;
            params.push(filters.roleName);
        }
        // domainName is a CAPABILITY-side dimension. It exists on the skill-gaps view
        // (alias 'g') and the capability views (v_domain_capability / v_subdomain_capability,
        // filtered via _buildDomainFilterClause). The employee views (v_employee_details /
        // v_employee_readiness, alias 'e') have NO domain_name column, so emitting it there
        // makes the query 500. Only apply it for the gaps alias here.
        if (filters.domainName && tableAlias === 'g') {
            clause += ` AND ${tableAlias}.domainName = ?`;
            params.push(filters.domainName);
        }

        // RBAC Scope (IDs)
        if (filters.siteIds && filters.siteIds.length) {
            clause += ` AND ${tableAlias}.siteId IN (${filters.siteIds.map(() => '?').join(',')})`;
            params.push(...filters.siteIds);
        }
        if (filters.departmentIds && filters.departmentIds.length) {
            clause += ` AND ${tableAlias}.departmentId IN (${filters.departmentIds.map(() => '?').join(',')})`;
            params.push(...filters.departmentIds);
        }
        if (filters.serviceIds && filters.serviceIds.length) {
            clause += ` AND ${tableAlias}.serviceId IN (${filters.serviceIds.map(() => '?').join(',')})`;
            params.push(...filters.serviceIds);
        }
        // Manager/supervisor scope: only the people they govern (their reports).
        if (filters.employeeIds && filters.employeeIds.length) {
            clause += ` AND ${tableAlias}.employeeId IN (${filters.employeeIds.map(() => '?').join(',')})`;
            params.push(...filters.employeeIds);
        }

        return clause;
    }

    /**
     * Domain-level filter clause for queries joining capability/domain tables.
     */
    _buildDomainFilterClause(filters, params, domainAlias = 'c', columnName = 'domainName') {
        let clause = '';
        if (filters.domainName) {
            clause += ` AND ${domainAlias}.${columnName} = ?`;
            params.push(filters.domainName);
        }
        return clause;
    }

    // -------------------------------------------------------------------------
    // Methods
    // -------------------------------------------------------------------------

    async getFilterOptions(filters) {
        // Reuse existing logic but query from v_employee_details?
        // Actually, existing logic queries distinct from master tables which is faster/cleaner than scanning a view of all employees.
        // We will keep the existing implementation for getFilterOptions as it is efficient.
        // But we need to ensure it matches the view's data logic. It does (master tables).

        // ... (Keep existing implementation for getFilterOptions, it was optimized) ...
        // Re-implementing here to ensure it uses the Helper correctly if needed,
        // but for now I'll use the existing one if I can "patch" only the other methods.
        // Since I'm overwriting the file, I must include it.

        const result = { sites: [], departments: [], services: [], roles: [], domains: [] };

        try {
            // Sites
            let siteQuery = 'SELECT DISTINCT id, name FROM sites WHERE isActive = 1';
            let siteParams = [];
            if (filters.siteIds && filters.siteIds.length) {
                siteQuery += ` AND id IN (${filters.siteIds.map(() => '?').join(',')})`;
                siteParams.push(...filters.siteIds);
            }
            result.sites = await db.all(siteQuery + ' ORDER BY name', siteParams);

            // Departments
            let deptQuery = `
                SELECT DISTINCT d.id, d.name, d.siteId 
                FROM departments d 
                JOIN sites s ON s.id = d.siteId 
                WHERE d.isActive = 1
            `;
            let deptParams = [];
            if (filters.departmentIds && filters.departmentIds.length) {
                deptQuery += ` AND d.id IN (${filters.departmentIds.map(() => '?').join(',')})`;
                deptParams.push(...filters.departmentIds);
            }
            if (filters.siteName) {
                deptQuery += ` AND s.name = ?`;
                deptParams.push(filters.siteName);
            }
            result.departments = await db.all(deptQuery + ' ORDER BY d.name', deptParams);

            // Services
            let svcQuery = `
                SELECT DISTINCT sv.id, sv.name, sv.departmentId 
                FROM services sv 
                JOIN departments d ON d.id = sv.departmentId
                JOIN sites s ON s.id = d.siteId
                WHERE sv.isActive = 1
            `;
            let svcParams = [];
            if (filters.serviceIds && filters.serviceIds.length) {
                svcQuery += ` AND sv.id IN (${filters.serviceIds.map(() => '?').join(',')})`;
                svcParams.push(...filters.serviceIds);
            }
            if (filters.departmentName) {
                svcQuery += ` AND d.name = ?`;
                svcParams.push(filters.departmentName);
            }
            if (filters.siteName) {
                svcQuery += ` AND s.name = ?`;
                svcParams.push(filters.siteName);
            }
            result.services = await db.all(svcQuery + ' ORDER BY sv.name', svcParams);

            result.roles = await db.all(
                'SELECT DISTINCT id, name FROM roles WHERE isActive = 1 ORDER BY name'
            );
            result.domains = await db.all(
                'SELECT DISTINCT id, name FROM domains WHERE isActive = 1 ORDER BY name'
            );

            return result;
        } catch (error) {
            console.error('Error fetching filter options:', error);
            throw error;
        }
    }

    async getOverviewKPIs(filters) {
        const params = [];
        const filterClause = this._buildFilterClause(filters, params, 'e'); // v_employee_readiness alias

        // ONE PASS OVER THE READINESS JOIN, not two.
        //
        // This used to scan `v_employee_readiness LEFT JOIN
        // v_employee_assessment_coverage` twice inside a single statement: once
        // for the KPI strip and again, identically, inside the `rolesAtRisk`
        // scalar subquery. Measured on the dev dataset at 4 000 employees the cost was
        // exactly double — 11 660 ms / 3 961 058 buffers against 5 828 ms /
        // 1 980 529 for the same shape scanned once.
        //
        // A CTE names the scan once and both consumers read it. Same rows, same
        // arithmetic — the only thing that changes is how many times PostgreSQL
        // builds the input.
        //
        // roleReadyCount and rolesAtRisk both key off `is_role_ready`
        // (v_employee_readiness): readiness over ALL requirements AND every
        // critical skill met. They previously counted `readiness_assessed_only
        // >= 80`, which is the score over whatever happened to be measured —
        // ReadinessService warns against exactly that. Live consequence:
        // somebody rated on 2 of 13 skills, both met, scored 100 % and was
        // counted role-ready at 15.4 % coverage (real readiness 11.8 %).
        // Org-wide 51 were counted ready against 48 genuinely ready, so the
        // dashboard and /reports/readiness disagreed about the same people.
        // "Roles at risk" was wrong the same way: a barely-measured role looked
        // staffed.
        //
        // The CTE deliberately aliases in snake_case: the SQLite-compat
        // translator quotes `AS camelCase` to preserve case, which would then
        // require every outer reference to be quoted too. Snake_case names pass
        // through untouched; the OUTER select still emits the camelCase aliases
        // the controllers and the dashboard JS expect.
        const sql = `
            WITH base AS (
                SELECT
                    e.employeeId                       AS employee_id,
                    e.roleName                         AS role_name,
                    e.totalRequired                    AS total_required,
                    e.readiness                        AS readiness_all,
                    e.criticalMet                      AS critical_met,
                    e.totalCritical                    AS total_critical,
                    c.readiness_assessed_only          AS readiness_assessed_only,
                    e.isRoleReady                      AS is_role_ready,
                    COALESCE(c.assessed_skills, 0)     AS assessed_skills,
                    COALESCE(c.expected_skills, 0)     AS expected_skills,
                    COALESCE(c.never_assessed_skills, 0) AS never_assessed_skills,
                    -- How many CRITICAL requirements have actually been measured.
                    -- Needed to tell "0 % compliant" apart from "never checked".
                    COALESCE(c.critical_assessed, 0)   AS critical_assessed,
                    -- …and how many there ARE. Without the denominator the KPI
                    -- can only render a bare em dash, which tells the reader
                    -- that something is missing but not what or how much.
                    COALESCE(c.critical_expected, 0)   AS critical_expected
                ${this._readinessFrom('e', 'c')}
                WHERE 1=1 ${filterClause}
            ),
            roles_at_risk AS (
                -- Roles at Risk: roles with <= 1 genuinely role-ready employee
                -- AMONG THE ROLES THAT WERE MEASURED. "Qualified" has to mean
                -- qualified for the whole role, not "scored well on whichever
                -- skills happened to be assessed" — otherwise a barely-measured
                -- role looks staffed. And a role where NO occupant was ever
                -- assessed is not at risk either: is_role_ready coalesces the
                -- unmeasured to 0, so the whole Internal Audit department (three
                -- roles, zero assessments) was published as "at risk". Those roles
                -- are counted separately as roles_unmeasured — the same split
                -- criticalCompliance makes a few lines below.
                SELECT role_name
                FROM base
                GROUP BY role_name
                HAVING SUM(CASE WHEN is_role_ready = 1 THEN 1 ELSE 0 END) <= 1
                   AND COUNT(readiness_assessed_only) > 0
            ),
            roles_unmeasured AS (
                SELECT role_name
                FROM base
                GROUP BY role_name
                HAVING COUNT(readiness_assessed_only) = 0
            )
            SELECT
                COUNT(*) as totalEmployees,
                COUNT(CASE WHEN total_required > 0 THEN 1 END) as mappedEmployees,
                -- People with at least one assessed requirement: the honest
                -- denominator for every "x are role-ready" statement.
                COUNT(CASE WHEN readiness_assessed_only IS NOT NULL THEN 1 END) as measuredEmployees,
                ROUND(AVG(readiness_assessed_only), 1) as avgReadiness,
                -- Kept, explicitly labelled, never silently substituted.
                ROUND(AVG(readiness_all), 1) as avgReadinessAllRequirements,
                -- REAL coverage: assessed requirements / expected requirements.
                ROUND(100.0 * SUM(assessed_skills)
                      / NULLIF(SUM(expected_skills), 0), 1) as assessmentCoverage,
                SUM(assessed_skills) as assessedRequirements,
                SUM(expected_skills) as expectedRequirements,
                SUM(never_assessed_skills) as neverAssessedRequirements,
                -- Critical compliance is NULL when no critical requirement has been
                -- ASSESSED, never 0. critical_met comes from v_employee_readiness,
                -- where an unmeasured requirement sits at level 0 and therefore reads
                -- as "not met" — so met/total returned a confident 0 % for an
                -- organisation that had simply never measured its critical skills
                -- (live: 0 met of 303 expected, every one of them never assessed).
                -- That is the never-assessed-as-earned-zero fabrication migrations
                -- 71/79 exist to prevent, and since the KPI snapshot job now
                -- PERSISTS this figure it would have written a false 0 % into the
                -- trend history permanently. Unmeasured must surface as "not
                -- measured", exactly like readiness_assessed_only.
                -- MEASURED over MEASURED. critical_met counts critical
                -- requirements that were assessed AND met; total_critical
                -- counts ALL critical requirements, assessed or not. Dividing
                -- one by the other mixes populations: with 303 critical
                -- requirements, the day the FIRST one is assessed and met the
                -- KPI would read 1/303 = 0.3 % instead of 100 %, and the
                -- snapshot job would persist that into the trend for good.
                -- Same rule as readiness_assessed_only.
                CASE WHEN SUM(critical_assessed) > 0
                     THEN ROUND(100.0 * SUM(critical_met) / NULLIF(SUM(critical_assessed), 0), 1)
                END as criticalCompliance,
                SUM(critical_assessed) as criticalAssessedRequirements,
                SUM(critical_expected) as criticalExpectedRequirements,
                COUNT(CASE WHEN is_role_ready = 1 THEN 1 END) as roleReadyCount,
                -- The honest denominator for "N are role-ready": people we can
                -- actually JUDGE for readiness — those whose every requirement has
                -- been assessed (coverage 100%). is_role_ready needs ALL
                -- requirements met, so a partially-assessed person can never be
                -- role-ready; counting them in the denominator (measuredEmployees,
                -- >= 1 assessed) reported them as "not ready" when they are only
                -- not-yet-fully-assessed. roleReadyCount is a subset of this count.
                COUNT(CASE WHEN expected_skills > 0 AND never_assessed_skills = 0 THEN 1 END) as fullyMeasuredEmployees,
                -- "Below 50 %" now means MEASURED below 50 %. Never-assessed
                -- people are NULL here and are reported as coverage, not as
                -- under-performance.
                COUNT(CASE WHEN readiness_assessed_only < 50 THEN 1 END) as criticalGapCount,
                COUNT(CASE WHEN readiness_all < 50 THEN 1 END) as criticalGapCountAllRequirements,
                (SELECT COUNT(*) FROM roles_at_risk) as rolesAtRisk,
                (SELECT COUNT(*) FROM roles_unmeasured) as rolesUnmeasured
            FROM base
        `;

        return await db.get(sql, params);
    }

    async getReadinessByGroup(groupBy, filters) {
        const validGroups = ['site', 'department', 'service', 'role'];
        if (!validGroups.includes(groupBy)) throw new Error('Invalid groupBy parameter');

        // Map groupBy to view column
        const columnMap = {
            site: { col: 'siteName', id: 'siteId' },
            department: { col: 'departmentName', id: 'departmentId' },
            service: { col: 'serviceName', id: 'serviceId' },
            role: { col: 'roleName', id: 'roleId' },
        };
        return this._readinessGroupSql(columnMap, groupBy, filters);
    }

    /**
     * A fingerprint (md5) of the MEASURED employee-id set for a scope — the same
     * population `measuredEmployees` counts (readiness_assessed_only IS NOT NULL).
     * Stored on the KPI snapshot so a later delta can tell a real movement in
     * the same cohort from a change of WHO is measured, even when the count is
     * unchanged. Null when nobody is measured.
     */
    async getMeasuredSignature(filters) {
        const params = [];
        const fc = this._buildFilterClause(filters, params, 'e');
        const row = await db.get(
            `SELECT md5(COALESCE(string_agg(e.employeeId::text, ',' ORDER BY e.employeeId), '')) AS sig,
                    COUNT(c.readiness_assessed_only) AS n
             ${this._readinessFrom('e', 'c')}
             WHERE c.readiness_assessed_only IS NOT NULL ${fc}`,
            params
        );
        // No measured employees → no fingerprint (unknown), never the md5 of ''.
        return row && Number(row.n) > 0 ? row.sig : null;
    }

    async _readinessGroupSql(columnMap, groupBy, filters) {
        const params = [];
        const filterClause = this._buildFilterClause(filters, params, 'e');
        const groupCol = columnMap[groupBy].col;
        // no representative id is projected. These groups are aggregated by
        // NAME (a department/service name legitimately spans several ids across
        // sites — "IT" is 9 department_ids), so a single MAX(id) was an arbitrary
        // stand-in that would scope a drill-through to one of them if ever used.
        // The consumers key off the name (label); dropping the id keeps it that way.

        // Same canonical readiness as the KPI strip, with the coverage that
        // makes it readable travelling in the same row.
        //
        // readyCount uses e.isRoleReady — ready for the ROLE (all requirements
        // met AND every critical skill met) — not "scored >= 80 on whatever
        // happened to be assessed". Same correction as roleReadyCount in the KPI
        // strip; the two must agree or the dashboard contradicts
        // /reports/readiness about the same people.
        //
        // NOTE: keep this OUT of the SELECT list. `expandGroupBy` in the compat
        // layer re-emits SELECT items into GROUP BY, and a `--` comment sitting
        // there is carried along and comments out the HAVING that follows
        // ("syntax error at or near HAVING"). Annotate above the literal.
        const sql = `
            SELECT
                e.${groupCol} as label,
                ROUND(AVG(c.readiness_assessed_only), 1) as avgReadiness,
                ROUND(AVG(e.readiness), 1) as avgReadinessAllRequirements,
                COUNT(e.employeeId) as employeeCount,
                COUNT(c.readiness_assessed_only) as measuredCount,
                ROUND(100.0 * SUM(COALESCE(c.assessed_skills, 0))
                      / NULLIF(SUM(COALESCE(c.expected_skills, 0)), 0), 1) as coverage,
                COUNT(CASE WHEN e.isRoleReady = 1 THEN 1 END) as readyCount,
                COUNT(CASE WHEN c.readiness_assessed_only < 50 THEN 1 END) as criticalCount
            ${this._readinessFrom('e', 'c')}
            WHERE 1=1 ${filterClause}
            GROUP BY e.${groupCol}
            HAVING COUNT(e.employeeId) > 0
            ORDER BY AVG(c.readiness_assessed_only) DESC NULLS LAST
        `;

        return await db.all(sql, params);
    }

    async getReadinessDistribution(filters) {
        const params = [];
        const filterClause = this._buildFilterClause(filters, params, 'e');

        // Buckets over the canonical (assessed-only) readiness. The people
        // nobody has measured get their own bucket instead of being dropped
        // from the chart or piled into 0-20 % as if they had been tested and
        // failed. The old BETWEEN ladder also mis-bucketed fractional scores
        // (20.5 fell through every branch into '80-100%'); `<=` fixes that.
        const sql = `
            SELECT
                CASE
                    WHEN c.readiness_assessed_only IS NULL THEN 'never-assessed'
                    WHEN c.readiness_assessed_only <= 20 THEN '0-20%'
                    WHEN c.readiness_assessed_only <= 40 THEN '21-40%'
                    WHEN c.readiness_assessed_only <= 60 THEN '41-60%'
                    WHEN c.readiness_assessed_only <  80 THEN '61-79%'
                    ELSE '80-100%'
                END as bucket,
                COUNT(*) as count
            ${this._readinessFrom('e', 'c')}
            WHERE 1=1 ${filterClause}
            GROUP BY bucket
            ORDER BY bucket
        `;

        return await db.all(sql, params);
    }

    async getRoleStaffing(filters) {
        const params = [];
        const filterClause = this._buildFilterClause(filters, params, 'e');

        const sql = `
            SELECT
                e.roleId,
                e.roleName,
                COUNT(e.employeeId) as totalEmployees,
                COUNT(c.readiness_assessed_only) as measuredCount,
                GROUP_CONCAT(DISTINCT e.siteName) as siteNames,
                ROUND(AVG(c.readiness_assessed_only), 1) as avgReadiness,
                ROUND(AVG(e.readiness), 1) as avgReadinessAllRequirements,
                ROUND(100.0 * SUM(COALESCE(c.assessed_skills, 0))
                      / NULLIF(SUM(COALESCE(c.expected_skills, 0)), 0), 1) as coverage,
                -- A role nobody measured is UNMEASURED, not at risk: with zero
                -- assessed occupants the "<= 1 ready" test is vacuously true and
                -- every never-assessed role was flagged (and counted on the KPI
                -- card). isUnmeasured carries that state on its own.
                CASE WHEN COUNT(c.readiness_assessed_only) = 0 THEN 0
                     WHEN SUM(CASE WHEN c.readiness_assessed_only >= 80 THEN 1 ELSE 0 END) <= 1 THEN 1 ELSE 0 END as isRisk,
                CASE WHEN COUNT(c.readiness_assessed_only) = 0 THEN 1 ELSE 0 END as isUnmeasured
            ${this._readinessFrom('e', 'c')}
            WHERE 1=1 ${filterClause}
            GROUP BY e.roleId, e.roleName
            ORDER BY totalEmployees ASC, e.roleName ASC
        `;

        return await db.all(sql, params);
    }

    async getSkillGaps(filters, limit = 20) {
        const params = [];
        // v_employee_skill_gaps alias 'g'
        const filterClause = this._buildFilterClause(filters, params, 'g');

        // Top 10 Skill Gaps (Weighted Impact)
        const sql = `
            SELECT
                g.skillId,
                g.skillName,
                g.domainName,
                ROUND(AVG(g.requiredLevel), 1) as avgRequired,
                ROUND(AVG(g.actualLevel), 1) as avgCurrent,
                ROUND(AVG(g.gap), 1) as avgGap,
                COUNT(DISTINCT g.employeeId) as affectedEmployees,
                SUM(g.gap) as totalGapPoints,
                MAX(g.isCritical) as isCritical
            FROM v_employee_skill_gaps g
            WHERE g.gap > 0 AND g.isAssessed = 1 ${filterClause}
            GROUP BY g.skillId
            ORDER BY (SUM(g.gap) * COUNT(DISTINCT g.employeeId)) DESC
            LIMIT ?
        `;

        return await db.all(sql, [...params, limit]);
    }

    async getDomainGaps(filters) {
        const params = [];
        const filterClause = this._buildFilterClause(filters, params, 'g');

        const sql = `
            SELECT
                g.domainId,
                g.domainName,
                SUM(g.gap) as totalGapPoints,
                ROUND(AVG(g.gap), 1) as avgGap,
                COUNT(DISTINCT g.skillId) as gapSkillCount,
                COUNT(DISTINCT CASE WHEN g.isCritical = 1 THEN g.skillId END) as criticalGapCount
            FROM v_employee_skill_gaps g
            WHERE g.gap > 0 AND g.isAssessed = 1 ${filterClause}
            GROUP BY g.domainId
            ORDER BY totalGapPoints DESC
        `;

        return await db.all(sql, params);
    }

    async getGapsByService(filters, topN = 10) {
        return this.getGapsByGroup('service', filters, topN);
    }

    async getGapsByGroup(groupBy, filters, topN = 10) {
        const params = [];
        const filterClause = this._buildFilterClause(filters, params, 'g');

        let groupCol = 'serviceName';
        let groupId = 'serviceId';
        if (groupBy === 'department') {
            groupCol = 'departmentName';
            groupId = 'departmentId';
        } else if (groupBy === 'site') {
            groupCol = 'siteName';
            groupId = 'siteId';
        }

        const sql = `
            SELECT 
                g.skillName,
                g.${groupCol} as groupLabel,
                SUM(g.gap) as totalGapPoints,
                COUNT(DISTINCT g.employeeId) as affectedCount
            FROM v_employee_skill_gaps g
            WHERE g.gap > 0 AND g.isAssessed = 1 ${filterClause}
            GROUP BY g.skillId, g.${groupId}
            ORDER BY totalGapPoints DESC
            LIMIT ?
        `;

        return await db.all(sql, [...params, topN]);
    }

    async getGapDrilldown(skillId, filters) {
        const params = [];
        const filterClause = this._buildFilterClause(filters, params, 'g');
        params.push(skillId);

        const sql = `
            SELECT
                g.employeeId,
                e.firstName || ' ' || e.lastName as employeeName, -- join details? g has no name? 
                -- Wait, v_employee_skill_gaps does not have names.
                e.employeeNumber,
                g.siteName,
                g.serviceName,
                g.roleName,
                g.actualLevel,
                g.requiredLevel,
                g.gap
            FROM v_employee_skill_gaps g
            JOIN v_employee_details e ON e.employeeId = g.employeeId
            WHERE g.gap > 0 AND g.isAssessed = 1
            ${filterClause}
            AND g.skillId = ?
            ORDER BY g.gap DESC, employeeName ASC
        `;

        return await db.all(sql, params);
    }

    async getEmployeeList(
        filters,
        { search, page, pageSize, sortBy, sortDir, supervisorId, roleId }
    ) {
        const params = [];
        const filterClause = this._buildFilterClause(filters, params, 'e');

        let searchClause = '';
        if (search) {
            const { ilike } = require('../utils/searchSql');
            // employeeNumber lives on v_employee_details (`d`), NOT on
            // v_employee_readiness — `e.employeeNumber` made every search on
            // this list 500 with `column e.employee_number does not exist`.
            searchClause = ` AND (${ilike('e.fullName')} OR d.employeeNumber ILIKE ?)`;
            params.push(`%${search}%`, `%${search}%`);
        }
        if (supervisorId) {
            // "My direct reports" (3.23.18, R1): the people I govern DIRECTLY by
            // either line — supervisor_id = me, or manager_id = me with
            // manager_type = 'employee' (the discriminator is not optional: the
            // employee and admin id spaces overlap). It read supervisor_id only,
            // so a manager ticking the box lost every report managed through
            // manager_id. Only the employee-side toggle sends this, and the RBAC
            // perimeter is still AND-ed by _buildFilterClause, so this can only
            // narrow. v_employee_details carries no manager columns → subquery.
            searchClause +=
                " AND (d.supervisorId = ? OR d.employeeId IN (SELECT dr.id FROM employees dr WHERE dr.manager_id = ? AND dr.manager_type = 'employee'))";
            params.push(supervisorId, supervisorId);
        }
        if (roleId) {
            searchClause += ' AND e.roleId = ?';
            params.push(roleId);
        }

        // v_employee_readiness carries fullName but NOT employeeNumber, so the
        // page needs v_employee_details (`d`) joined in.
        const baseSql = `
            ${this._readinessFrom('e', 'c')}
            JOIN v_employee_details d ON d.employeeId = e.employeeId
            WHERE 1=1 ${filterClause} ${searchClause}
        `;

        // COUNT does not read a single column of the coverage view, and the
        // coverage view is a GROUP BY over 173 691 requirement rows at 4 000
        // employees — joining it just to count employees made a 50-row page
        // pay for a whole-organisation aggregate twice (once here, once for the
        // page itself). The LEFT JOIN can add no rows (v_employee_assessment_
        // coverage is keyed one-row-per-employee) and can remove none, so
        // dropping it from the COUNT is exact, not an approximation.
        const countSql = `
            SELECT COUNT(*) as total
            FROM v_employee_readiness e
            JOIN v_employee_details d ON d.employeeId = e.employeeId
            WHERE 1=1 ${filterClause} ${searchClause}
        `;
        const countResult = await db.get(countSql, [...params]);

        // Sorting
        const validSorts = ['name', 'readiness', 'avgProficiency', 'gapCount', 'totalGapPoints'];
        const sortCol = validSorts.includes(sortBy) ? sortBy : 'readiness';
        const direction = sortDir === 'asc' ? 'ASC' : 'DESC';

        const orderByMap = {
            name: 'd.fullName',
            readiness: 'c.readiness_assessed_only',
            // avgProficiency is not in the view; readiness is the closest
            // available proxy and stays on the canonical column.
            avgProficiency: 'c.readiness_assessed_only',
            gapCount: '(COALESCE(c.assessed_skills, 0) - e.skillsMet)',
            totalGapPoints: 'e.totalGapPoints',
        };
        // NULLS LAST so the never-assessed sink to the bottom of a DESC list
        // instead of masquerading as the top or the bottom performers.
        const nullsOrder = orderByMap[sortCol] === 'c.readiness_assessed_only' ? ' NULLS LAST' : '';

        const sql = `
            SELECT
                e.employeeId as id,
                d.employeeNumber,
                d.fullName as name,
                e.siteName,
                e.departmentName,
                e.serviceName,
                e.roleName,
                CASE WHEN e.totalRequired > 0 THEN 1 ELSE 0 END as roleMapped,
                -1 as skillsAssessed, -- not in view, optional
                -1 as avgProficiency, -- not in view, optional
                -- Canonical readiness; NULL (not 0) when nobody was ever rated.
                c.readiness_assessed_only as readiness,
                e.readiness as readinessAllRequirements,
                COALESCE(c.assessed_skills, 0) as assessedSkills,
                COALESCE(c.expected_skills, 0) as expectedSkills,
                COALESCE(c.never_assessed_skills, 0) as neverAssessedSkills,
                c.coverage,
                -- MEASURED shortfall (assessed − met), not "everything nobody
                -- ever rated". totalRequired stays the full designed count.
                (COALESCE(c.assessed_skills, 0) - e.skillsMet) as gapCount,
                e.totalRequired,
                e.totalGapPoints,
                -- Top Gap Skill? Hard query. Placeholder null.
                NULL as topGapSkill
            ${baseSql}
            -- employeeId is the tie-break, and it is not cosmetic: the sort keys
            -- here are all heavily tied (dozens of people sit on exactly 100 %,
            -- or on 0 gaps), and with no second key PostgreSQL was free to order
            -- a tie group differently between two executions of the SAME query.
            -- Paging is LIMIT/OFFSET over that order, so a tied employee could
            -- appear on both page 1 and page 2, or on neither.
            ORDER BY ${orderByMap[sortCol]} ${direction}${nullsOrder}, e.employeeId ASC
            LIMIT ? OFFSET ?
        `;

        params.push(pageSize, (page - 1) * pageSize);
        const rows = await db.all(sql, params);

        return {
            rows,
            total: countResult ? countResult.total : 0,
            page,
            pageSize,
        };
    }

    async getEmployeeDetail(employeeId, filters) {
        // ... (Similar refactor using views) ...
        // Keeping it brief for now as requested by user focus on Dashboard/Radar.
        // But need to ensure it works.
        // Can call v_employee_readiness directly.

        const params = [];
        // Scope check
        const filterClause = this._buildFilterClause(filters, params, 'e');
        params.push(employeeId);

        // `e.*` keeps every legacy column (including the all-requirements
        // `readiness`); the canonical figure and its denominators are appended
        // so a caller can never read the score without the coverage.
        const infoSql = `
            SELECT e.*,
                   c.readiness_assessed_only as readinessAssessedOnly,
                   COALESCE(c.assessed_skills, 0) as assessedSkills,
                   COALESCE(c.expected_skills, 0) as expectedSkills,
                   COALESCE(c.never_assessed_skills, 0) as neverAssessedSkills,
                   c.coverage
            ${this._readinessFrom('e', 'c')}
            WHERE 1=1 ${filterClause} AND e.employeeId = ?
        `;
        const info = await db.get(infoSql, params);
        if (!info) return null;

        // Skills
        const skillsSql = `
            SELECT 
                skillId, skillName, domainId, domainName, actualLevel, requiredLevel, gap, 
                CASE 
                    WHEN isMet = 1 AND actualLevel > requiredLevel THEN 'exceeded'
                    WHEN isMet = 1 THEN 'met'
                    ELSE 'gap' 
                END as status
            FROM v_employee_skill_gaps e
            WHERE e.employeeId = ?
        `;
        const skills = await db.all(skillsSql, [employeeId]);

        return { info, skills };
    }

    async getDomainHeatmap(groupBy, filters) {
        const validGroups = ['site', 'department', 'service'];
        if (!validGroups.includes(groupBy)) throw new Error('Invalid groupBy');

        const params = [];
        const filterClause = this._buildFilterClause(filters, params, 'e');

        // Usage: v_domain_capability joined with v_employee_details
        const sql = `
            SELECT
                c.domainId,
                c.domainName,
                ${groupBy === 'site' ? 'e.siteName' : groupBy === 'department' ? 'e.departmentName' : 'e.serviceName'} as groupLabel,
                ROUND(AVG(c.level), 1) as avgLevel,
                COUNT(DISTINCT c.employeeId) as assessedCount,
                MIN(c.level) as minLevel,
                MAX(c.level) as maxLevel
            FROM v_domain_capability c
            JOIN v_employee_details e ON e.employeeId = c.employeeId
            WHERE e.isActive = 1 ${filterClause}
            GROUP BY c.domainId, groupLabel
        `;

        return await db.all(sql, params);
    }

    async getDomainRadarData(groupValue, groupBy, filters) {
        const params = [];
        const filterClause = this._buildFilterClause(filters, params, 'e');

        let extraWhere = '';
        if (groupBy === 'site') {
            extraWhere = ' AND e.siteName = ?';
            params.push(groupValue);
        } else if (groupBy === 'department') {
            extraWhere = ' AND e.departmentName = ?';
            params.push(groupValue);
        } else {
            extraWhere = ' AND e.serviceName = ?';
            params.push(groupValue);
        }

        // Domain filter
        if (filters.domainName) {
            extraWhere += ' AND c.domainName = ?';
            params.push(filters.domainName);
        }

        // Required Only filter: only include skills required for the employee's role
        let joinRequired = '';
        if (filters.requiredOnly === 'true' || filters.requiredOnly === true) {
            joinRequired = `JOIN roleSkillRequirements rsr 
                            ON rsr.roleId = e.roleId 
                            AND rsr.skillId = c.skillId 
                            AND rsr.requiredLevel > 0`;
        }

        const sql = `
            SELECT
                c.domainName,
                ROUND(AVG(c.level), 2) as avgLevel
            FROM v_domain_capability c
            JOIN v_employee_details e ON e.employeeId = c.employeeId
            ${joinRequired}
            WHERE e.isActive = 1 ${filterClause} ${extraWhere}
            GROUP BY c.domainId
            ORDER BY c.domainName
        `;

        return await db.all(sql, params);
    }

    // getReadinessTrend was REMOVED here. It returned a sum of readiness
    // PERCENTAGES alongside a sum of raw 0-4 skill-level deltas, and
    // DashboardService back-cast a trend by subtracting one from the other — a
    // unit mismatch that made every historical point meaningless. Real KPI
    // history now lives in kpi_snapshots (migration 82), written daily by
    // jobs/kpi-snapshot.js and read by DashboardService.getReadinessTrend.

    async getStaleAssessments(filters, months = 6) {
        try {
            const params = [];
            const filterClause = this._buildFilterClause(filters, params, 'e');

            // Cutoff computed in JS → driver-agnostic (no date('now')/julianday).
            const cutoff = new Date();
            cutoff.setMonth(cutoff.getMonth() - months);
            const cutoffIso = cutoff.toISOString();
            params.push(cutoffIso);

            // Repeat the aggregate in HAVING (PG forbids alias-in-HAVING) and
            // list grouped columns explicitly (PG strict GROUP BY).
            const sql = `
                SELECT
                    e.employeeId,
                    d.fullName as employeeName,
                    d.employeeNumber,
                    e.roleName,
                    e.siteName,
                    e.serviceName,
                    MAX(ra.assessedAt) as lastAssessedAt
                FROM v_employee_readiness e
                JOIN v_employee_details d ON d.employeeId = e.employeeId
                LEFT JOIN v_resolved_assessments ra ON ra.employeeId = e.employeeId
                WHERE 1=1 ${filterClause}
                GROUP BY e.employeeId, d.fullName, d.employeeNumber, e.roleName, e.siteName, e.serviceName
                HAVING MAX(ra.assessedAt) IS NULL OR MAX(ra.assessedAt) < ?
                ORDER BY MAX(ra.assessedAt) ASC NULLS FIRST
                LIMIT 20
            `;

            const rows = await db.all(sql, params);
            const nowMs = Date.now();
            return rows.map((r) => ({
                ...r,
                daysSinceAssessment: r.lastAssessedAt
                    ? Math.floor((nowMs - new Date(r.lastAssessedAt).getTime()) / 86400000)
                    : null,
            }));
        } catch (error) {
            // Never `return []` here: an empty list reads as "nothing is stale",
            // which is a measurement this query did not make.
            console.error('Error fetching stale assessments:', error);
            throw error;
        }
    }

    async getTeamExperts(filters) {
        try {
            const params = [];
            const filterClause = this._buildFilterClause(filters, params, 'e');

            const sql = `
                SELECT 
                    c.employeeId,
                    d.fullName as employeeName,
                    d.employeeNumber,
                    e.roleName,
                    e.siteName,
                    COUNT(DISTINCT c.skillName) as skillCount,
                    GROUP_CONCAT(DISTINCT c.skillName) as skills
                FROM v_domain_capability c
                JOIN v_employee_details d ON d.employeeId = c.employeeId
                JOIN v_employee_readiness e ON e.employeeId = c.employeeId
                WHERE c.level >= 4 ${filterClause}
                GROUP BY c.employeeId
                ORDER BY skillCount DESC
                LIMIT 20
            `;

            return await db.all(sql, params);
        } catch (error) {
            // An error is not "no expert" — let it surface.
            console.error('Error fetching team experts:', error);
            throw error;
        }
    }

    /**
     * Organization-wide Domain Radar — actual vs required, over the SAME rows.
     *
     * The two layers used to come from two different populations. `actual`
     * averaged v_domain_capability, i.e. every assessment a person holds —
     * including skills their role does not require. `required` averaged the
     * role requirements fanned out by headcount — including requirements
     * nobody has been assessed on. Averaging one against the other is not a
     * gap, it is two unrelated means subtracted, and it overstated every
     * domain:
     *
     *   domain                        shown    paired
     *   4. Compliance & Certification  1.21      0.36
     *   6. People Management           0.91      0.44
     *   2. Functional Technical        0.54      0.13
     *
     * Both layers now come from v_employee_skill_gaps, which pairs a required
     * level with the level that person was actually assessed at, restricted to
     * requirements that were MEASURED — so the difference is a gap somebody
     * observed. Unmeasured requirements are reported as coverage
     * (measuredPairs / totalPairs) rather than folded into the average, and a
     * domain with nothing measured yields NULL on both axes, never 0.
     */
    async getOrgDomainRadar(filters) {
        const params = [];
        const filterClause = this._buildFilterClause(filters, params, 'g');

        const rows = await db.all(
            `SELECT
                 g.domainId,
                 g.domainName,
                 ROUND(AVG(CASE WHEN g.isAssessed = 1 THEN g.actualLevel END), 2)   as avgActual,
                 ROUND(AVG(CASE WHEN g.isAssessed = 1 THEN g.requiredLevel END), 2) as avgRequired,
                 COUNT(DISTINCT CASE WHEN g.isAssessed = 1 THEN g.employeeId END)::int as assessedCount,
                 COUNT(DISTINCT g.skillId)::int                                     as requiredSkillCount,
                 SUM(CASE WHEN g.isAssessed = 1 THEN 1 ELSE 0 END)::int             as measuredPairs,
                 COUNT(*)::int                                                      as totalPairs
             FROM v_employee_skill_gaps g
             WHERE g.requiredLevel > 0 ${filterClause}
             GROUP BY g.domainId, g.domainName
             ORDER BY g.domainName`,
            params
        );

        return rows.map((r) => ({
            domainId: r.domainId,
            domainName: r.domainName,
            // NULL, never 0, when nothing in the domain was measured — the same
            // rule the sub-domain radar follows.
            avgActual: r.avgActual == null ? null : Number(r.avgActual),
            avgRequired: r.avgRequired == null ? null : Number(r.avgRequired),
            assessedCount: Number(r.assessedCount) || 0,
            requiredSkillCount: Number(r.requiredSkillCount) || 0,
            measuredPairs: Number(r.measuredPairs) || 0,
            totalPairs: Number(r.totalPairs) || 0,
        }));
    }

    /**
     * V3 Sub-Domain Radar — actual vs required avg proficiency per SUB-DOMAIN
     * (the "competency element" axis). Mirrors getOrgDomainRadar but the
     * spokes are sub-domains. When filters.domainName is set, scopes to that
     * pillar's sub-domains (drill-down); otherwise returns all 49.
     */
    async getOrgSubDomainRadar(filters) {
        // domainName scopes the SUB-DOMAIN axis to one pillar — it must be applied
        // to the capability/domain side, NOT to v_employee_details (no such column).
        const empFilters = { ...filters };
        delete empFilters.domainName;

        const params1 = [];
        const filterClause1 = this._buildFilterClause(empFilters, params1, 'e');
        const domainClause1 = this._buildDomainFilterClause(filters, params1, 'c', 'domainName');

        // Layer 1: actual avg proficiency per sub-domain (from assessments)
        const actualSql = `
            SELECT
                c.subDomainId,
                c.subDomainName,
                c.domainName,
                ROUND(AVG(c.level), 2) as avgActual,
                COUNT(DISTINCT c.employeeId) as assessedCount
            FROM v_subdomain_capability c
            JOIN v_employee_details e ON e.employeeId = c.employeeId
            WHERE e.isActive = 1 ${filterClause1} ${domainClause1}
            GROUP BY c.subDomainId, c.subDomainName, c.domainName
            ORDER BY c.domainName, c.subDomainName
        `;

        const params2 = [];
        const filterClause2 = this._buildFilterClause(empFilters, params2, 'e');
        const domainClause2 = this._buildDomainFilterClause(filters, params2, 'd', 'name');

        // Layer 2: required avg proficiency per sub-domain (from role requirements)
        const requiredSql = `
            SELECT
                sd.id as subDomainId,
                sd.name as subDomainName,
                d.name as domainName,
                ROUND(AVG(rsr.requiredLevel), 2) as avgRequired,
                COUNT(DISTINCT rsr.skillId) as requiredSkillCount
            FROM roleSkillRequirements rsr
            JOIN skills s ON s.id = rsr.skillId
            JOIN subDomains sd ON sd.id = s.subDomainId
            JOIN domains d ON d.id = sd.domainId
            JOIN v_employee_details e ON e.roleId = rsr.roleId
            WHERE rsr.requiredLevel > 0
              AND e.isActive = 1 ${filterClause2} ${domainClause2}
            GROUP BY sd.id, sd.name, d.name
            ORDER BY d.name, sd.name
        `;

        const [actual, required] = await Promise.all([
            db.all(actualSql, params1),
            db.all(requiredSql, params2),
        ]);

        // NULL, never 0, on both axes. A sub-domain nobody has been assessed on
        // has no actual proficiency — it is not a proficiency of zero — and one
        // no role requires has no requirement, not a requirement of zero.
        // Filling either with 0 manufactures the largest possible gap out of an
        // absence of data, and the consumer ranks by exactly that gap: seven
        // never-assessed sub-domains took the top seven "training priority"
        // slots here, pushing the worst genuinely measured gap (1.36) to 8th.
        const map = new Map();
        actual.forEach((row) => {
            map.set(row.subDomainName, {
                subDomainId: row.subDomainId,
                subDomainName: row.subDomainName,
                domainName: row.domainName,
                avgActual: row.avgActual,
                assessedCount: row.assessedCount,
                avgRequired: null,
                requiredSkillCount: 0,
            });
        });
        required.forEach((row) => {
            const existing = map.get(row.subDomainName);
            if (existing) {
                existing.avgRequired = row.avgRequired;
                existing.requiredSkillCount = row.requiredSkillCount;
            } else {
                map.set(row.subDomainName, {
                    subDomainId: row.subDomainId,
                    subDomainName: row.subDomainName,
                    domainName: row.domainName,
                    avgActual: null,
                    assessedCount: 0,
                    avgRequired: row.avgRequired,
                    requiredSkillCount: row.requiredSkillCount,
                });
            }
        });

        return Array.from(map.values()).sort((a, b) =>
            (a.domainName + a.subDomainName).localeCompare(b.domainName + b.subDomainName)
        );
    }

    /**
     * Comparator Radars — All 4 predefined panels in one call.
     * Panel 1: Actual vs Required (dual-layer org-wide)
     * Panels 2-4: Benchmark mode when a group is selected (selected vs best vs worst vs avg),
     *             otherwise top 5 by employee count.
     * @param {Object} filters - RBAC + domain filters
     * @param {Object} compOptions - { compSite, compDepartment, compService }
     */
    async getComparatorRadars(filters, compOptions = {}) {
        // Panel 1: Category-based actual vs required (Use original filters to show selected entity's data?
        // Or should this also be a benchmark? Usually the top-left radar is "Current Selection vs Required".
        // Let's keep it as "Selected Context" vs "Required".)
        const catActualVsRequired = await this._getCategoryRadar(filters);

        /**
         * Fetch grouped proficiency per skill category.
         * If selectedName (from compOptions) is provided → benchmark mode (selected + best + worst + avg).
         * Otherwise → top 5 groups by employee count.
         */
        const fetchGroupedOrBenchmark = async (groupColumn, selectedName, filterKeyToRemove) => {
            // CLONE filters to avoid modifying the original object used by other queries
            const rankingFilters = { ...filters };

            // REMOVE the specific filter for this group dimension.
            // e.g. If we are ranking Sites, we must NOT filter by 'Site A', otherwise we only get Site A and can't find Best/Worst.
            if (filterKeyToRemove) {
                delete rankingFilters[filterKeyToRemove];
                // Also remove ID-based filters if they exist
                if (filterKeyToRemove === 'siteName') delete rankingFilters['siteIds'];
                if (filterKeyToRemove === 'departmentName') delete rankingFilters['departmentIds'];
                if (filterKeyToRemove === 'serviceName') delete rankingFilters['serviceIds'];
            }

            // Fetch ALL groups' per-category proficiency in one query using the BROADER filters
            const params = [];
            const filterClause = this._buildFilterClause(rankingFilters, params, 'e');
            const domainClause = this._buildDomainFilterClause(
                rankingFilters,
                params,
                'c',
                'domainName'
            );

            const sql = `
                SELECT ${groupColumn} as groupName, c.category as domainName,
                       ROUND(AVG(c.level), 2) as avgLevel,
                       COUNT(*)::int as sampleCount
                FROM v_domain_capability c
                JOIN v_employee_details e ON e.employeeId = c.employeeId
                WHERE e.isActive = 1 AND ${groupColumn} IS NOT NULL
                  ${filterClause} ${domainClause}
                GROUP BY ${groupColumn}, c.category
                ORDER BY ${groupColumn}, c.category
            `;
            const rows = await db.all(sql, params);

            // Pivot into { groupName: [{domainName (=category), avgLevel}] }
            const grouped = {};
            rows.forEach((r) => {
                if (!grouped[r.groupName]) grouped[r.groupName] = [];
                grouped[r.groupName].push({
                    domainName: r.domainName,
                    avgLevel: r.avgLevel,
                    sampleCount: Number(r.sampleCount) || 0,
                });
            });

            const groupNames = Object.keys(grouped);
            if (groupNames.length === 0) return [];

            // Rank groups by overall average proficiency, WEIGHTED by how many
            // assessments stand behind each domain average.
            //
            // An unweighted mean of per-domain means gives every domain an
            // equal vote regardless of size. In testing, Stonebridge's domain samples
            // ran from 7 to 238 assessments, so its 7 compliance ratings
            // counted as much as its 238 operational ones — and it was
            // labelled "Worst" while ranking 6th of 9 on the weighted figure.
            // Five of the nine sites changed rank. A director reading "worst
            // site" was sent to the wrong place.
            const ranked = groupNames
                .map((name) => {
                    const ds = grouped[name];
                    const n = ds.reduce((t, d) => t + (Number(d.sampleCount) || 0), 0);
                    return {
                        name,
                        data: ds,
                        measuredCount: n,
                        overallAvg: n
                            ? ds.reduce(
                                  (t, d) => t + Number(d.avgLevel) * (Number(d.sampleCount) || 0),
                                  0
                              ) / n
                            : null,
                    };
                })
                .sort((a, b) => (b.overallAvg ?? -1) - (a.overallAvg ?? -1));

            // ── No selection → return top 5 ──
            if (!selectedName) {
                return ranked.slice(0, 5).map((g) => ({ label: g.name, data: g.data }));
            }

            // ── Benchmark mode ──
            const result = [];
            const best = ranked[0];
            const worst = ranked[ranked.length - 1];

            // Selected entity
            const sel = ranked.find((g) => g.name === selectedName);
            // If the selected entity isn't found in the ranked list (e.g. no data), we can't show it.
            if (sel) {
                result.push({ label: `📌 ${sel.name}`, data: sel.data });
            } else {
                // Fallback: if we filtered out the selection? No, we removed the filter.
                // Maybe it has no data?
                result.push({ label: `📌 ${selectedName} (No Data)`, data: [] });
            }

            // Best performer (skip if it IS the selected)
            if (best && best.name !== selectedName) {
                result.push({ label: `🏆 ${best.name} (Best)`, data: best.data });
            } else if (ranked.length > 1 && ranked[1].name !== selectedName) {
                result.push({ label: `🏆 ${ranked[1].name} (Best)`, data: ranked[1].data });
            }

            // Worst performer
            if (worst && worst.name !== selectedName && worst.name !== (best ? best.name : null)) {
                result.push({ label: `⚠️ ${worst.name} (Worst)`, data: worst.data });
            }

            // Org-wide average per domain (using the RANKING filters, i.e., global
            // context). WEIGHTED by the assessments behind each group's domain
            // average, exactly like the ranking above — an unweighted mean of
            // group means gives a 7-assessment site the same vote as a
            // 238-assessment one, so the "Org Average" reference line disagreed
            // with the weighted ranking drawn right beside it. avgLevel is null
            // (never 0/NaN) for a domain with no assessments behind it.
            const allDomains = new Set();
            ranked.forEach((g) => g.data.forEach((d) => allDomains.add(d.domainName)));
            const avgData = Array.from(allDomains)
                .sort()
                .map((domainName) => {
                    let weightedSum = 0,
                        weight = 0;
                    ranked.forEach((g) => {
                        const d = g.data.find((x) => x.domainName === domainName);
                        if (d) {
                            const w = Number(d.sampleCount) || 0;
                            weightedSum += Number(d.avgLevel) * w;
                            weight += w;
                        }
                    });
                    return {
                        domainName,
                        avgLevel: weight ? Math.round((weightedSum / weight) * 100) / 100 : null,
                    };
                });
            result.push({ label: '📊 Org Average', data: avgData });

            return result;
        };

        const [bySite, byDepartment, byService, byDomain, bySkill] = await Promise.all([
            // Pass the filter key to REMOVE for each dimension
            fetchGroupedOrBenchmark('e.siteName', compOptions.compSite, 'siteName'),
            fetchGroupedOrBenchmark(
                'e.departmentName',
                compOptions.compDepartment,
                'departmentName'
            ),
            fetchGroupedOrBenchmark('e.serviceName', compOptions.compService, 'serviceName'),
            // These use the ORIGINAL filters (preserving context)
            this._getDomainRadar(filters),
            this._getSkillRadar(filters, 12),
        ]);

        // sub-domain (competency-element) actual-vs-required — respects the
        // domainName drill-down (one pillar's sub-domains) or returns all sub-domains.
        const bySubDomain = await this.getOrgSubDomainRadar(filters);

        return {
            actualVsRequired: catActualVsRequired,
            byDomain,
            bySubDomain,
            bySkill,
            bySite,
            byDepartment,
            byService,
        };
    }

    /**
     * Category-based radar — used by Comparator tab only.
     * Groups proficiency by capability type (Technical, Behavioral, Safety, Compliance).
     */
    async _getCategoryRadar(filters) {
        // PAIRED over the SAME rows, exactly like getOrgDomainRadar. This used
        // to average v_domain_capability (every assessment a person holds) on
        // the actual side and roleSkillRequirements fanned by headcount on the
        // required side — two different populations subtracted, which overstated
        // every category and rendered a never-measured category as actual 0
        // against a full requirement. Both sides now come from
        // v_employee_skill_gaps, restricted to MEASURED requirements, and an
        // unmeasured category is NULL on both axes, never 0.
        const params = [];
        const filterClause = this._buildFilterClause(filters, params, 'g');
        const rows = await db.all(
            `SELECT COALESCE(sk.category, 'Technical') AS domainName,
                    ROUND(AVG(CASE WHEN g.isAssessed = 1 THEN g.actualLevel END), 2)   AS avgActual,
                    ROUND(AVG(CASE WHEN g.isAssessed = 1 THEN g.requiredLevel END), 2) AS avgRequired,
                    COUNT(DISTINCT CASE WHEN g.isAssessed = 1 THEN g.employeeId END)::int AS assessedCount,
                    COUNT(DISTINCT g.skillId)::int                                        AS requiredSkillCount,
                    SUM(CASE WHEN g.isAssessed = 1 THEN 1 ELSE 0 END)::int                AS measuredPairs,
                    COUNT(*)::int                                                         AS totalPairs
             FROM v_employee_skill_gaps g
             JOIN skills sk ON sk.id = g.skillId
             WHERE g.requiredLevel > 0 ${filterClause}
             GROUP BY COALESCE(sk.category, 'Technical')
             ORDER BY COALESCE(sk.category, 'Technical')`,
            params
        );
        return rows.map((r) => ({
            domainName: r.domainName,
            avgActual: r.avgActual == null ? null : Number(r.avgActual),
            avgRequired: r.avgRequired == null ? null : Number(r.avgRequired),
            assessedCount: Number(r.assessedCount) || 0,
            requiredSkillCount: Number(r.requiredSkillCount) || 0,
            measuredPairs: Number(r.measuredPairs) || 0,
            totalPairs: Number(r.totalPairs) || 0,
        }));
    }

    /**
     * Domain-based radar — Actual vs Required proficiency grouped by domain.
     *
     * This is the SAME question getOrgDomainRadar answers, so it must give the
     * same answer: it used to run its own two-population query (actual over
     * v_domain_capability, required over roleSkillRequirements) and disagreed
     * with the fixed function on every domain — 1.21 vs 0.36 on Compliance —
     * while rendering a never-measured domain at actual 0. Delegate, so the
     * Comparator tab and the Executive radar can never diverge again.
     */
    async _getDomainRadar(filters) {
        return this.getOrgDomainRadar(filters);
    }

    /**
     * Skill-based radar — Actual vs Required proficiency for top skills by gap.
     */
    async _getSkillRadar(filters, limit = 12) {
        const params = [];
        const filterClause = this._buildFilterClause(filters, params, 'g');

        const sql = `
            SELECT
                g.skillName,
                ROUND(AVG(g.requiredLevel), 2) as avgRequired,
                ROUND(AVG(g.actualLevel), 2) as avgActual,
                ROUND(AVG(g.gap), 2) as avgGap,
                COUNT(DISTINCT g.employeeId) as affectedEmployees
            FROM v_employee_skill_gaps g
            -- isAssessed = 1: a requirement nobody ever rated is an unknown,
            -- not a measured shortfall. Same predicate as getSkillGaps /
            -- getDomainGaps, so the radar and the gap tables rank identically.
            WHERE g.gap > 0 AND g.isAssessed = 1 ${filterClause}
            GROUP BY g.skillId
            ORDER BY AVG(g.gap) * COUNT(DISTINCT g.employeeId) DESC
            LIMIT ?
        `;
        params.push(limit);

        return await db.all(sql, params);
    }

    // =========================================================================
    // Strategic Insights — Executive-Level Methods
    // =========================================================================

    /**
     * Workforce Risk Index — Composite 0-100 score.
     * Combines: avgReadiness (30%), assessmentCoverage (20%),
     *           criticalCompliance (30%), staffingHealth (20%).
     * Higher = healthier. Lower = more risk.
     */
    async getWorkforceRiskIndex(filters) {
        // No try/catch here on purpose. This used to swallow ANY database error
        // and answer { score: 0, status: 'unknown' } — measured with a 57014
        // statement timeout: the gauge painted a confident 0 over a query that
        // never ran. An unmeasured index is an error, never a number.
        {
            const params1 = [];
            const fc1 = this._buildFilterClause(filters, params1, 'e');

            // Core KPIs — canonical readiness + REAL requirement coverage.
            // `assessedCount` used to be COUNT(readiness IS NOT NULL), i.e. the
            // has-a-benchmark count, so the coverage sub-score was ~100 on any
            // roster and the composite index flattered itself by 15 points.
            //
            // criticalCompliance follows the getOverviewKPIs rule exactly: NULL
            // until at least one critical requirement has been ASSESSED. Before
            // this guard the ratio read 0 met / 303 expected on a roster where
            // nothing had been measured, and the composite then turned that 0
            // into a 100 % axis (`|| 100`) — "healthy" on zero measurement.
            const kpiSql = `
                SELECT
                    ROUND(AVG(c.readiness_assessed_only), 2) as avgReadiness,
                    COUNT(CASE WHEN c.readiness_assessed_only IS NOT NULL THEN 1 END) as assessedCount,
                    COUNT(*) as totalEmployees,
                    SUM(COALESCE(c.assessed_skills, 0)) as assessedRequirements,
                    SUM(COALESCE(c.expected_skills, 0)) as expectedRequirements,
                    SUM(COALESCE(c.critical_assessed, 0)) as criticalAssessed,
                    -- See getOverviewKPIs: the denominator must be the
                    -- critical requirements that were ASSESSED, not every
                    -- critical requirement, or the ratio mixes populations.
                    CASE WHEN SUM(COALESCE(c.critical_assessed, 0)) > 0
                         THEN ROUND(100.0 * SUM(e.criticalMet)
                                    / NULLIF(SUM(COALESCE(c.critical_assessed, 0)), 0), 2)
                    END as criticalCompliance,
                    COUNT(CASE WHEN c.readiness_assessed_only >= 80 THEN 1 END) as readyEmployees
                ${this._readinessFrom('e', 'c')}
                WHERE 1=1 ${fc1}
            `;
            const kpis = await db.get(kpiSql, params1);

            // Staffing health: % of roles that have >1 qualified employee
            const params2 = [];
            const fc2 = this._buildFilterClause(filters, params2, 'e');
            // Only MEASURED roles count toward staffing health, and "qualified"
            // is is_role_ready (the one definition). A role nobody has assessed
            // has no staffing signal — counting it as unhealthy fabricated a low
            // score out of absence (Internal Audit: 3 never-measured roles drove
            // staffing to 0). totalRoles now counts only roles with >=1 measured
            // occupant, so a fully-unmeasured scope yields totalRoles 0 → the
            // axis is null (unmeasured), not 0.
            const staffingSql = `
                SELECT
                    SUM(CASE WHEN mc > 0 THEN 1 ELSE 0 END) as totalRoles,
                    SUM(CASE WHEN mc > 0 AND qc > 1 THEN 1 ELSE 0 END) as healthyRoles
                FROM (
                    SELECT e.roleName,
                           SUM(CASE WHEN e.is_role_ready = 1 THEN 1 ELSE 0 END) as qc,
                           COUNT(c.readiness_assessed_only) as mc
                    ${this._readinessFrom('e', 'c')}
                    WHERE 1=1 ${fc2}
                    GROUP BY e.roleName
                ) AS r
            `;
            const staffing = await db.get(staffingSql, params2);

            // Assessment freshness: % of employees with assessment in last 6 months
            const params3 = [];
            const fc3 = this._buildFilterClause(filters, params3, 'e');
            const sixMonthsAgo = new Date();
            sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
            const cutoffIso = sixMonthsAgo.toISOString();
            // Freshness is defined only over people who have EVER been assessed:
            // "of those measured, how many recently". total counts ever-assessed
            // (last_assessed IS NOT NULL), so a population nobody has assessed
            // yields total 0 → the axis is null (unmeasured), not a fabricated
            // 0 % that reads as a staleness crisis.
            const freshSql = `
                SELECT
                    SUM(CASE WHEN last_assessed IS NOT NULL THEN 1 ELSE 0 END) as total,
                    SUM(CASE WHEN last_assessed >= '${cutoffIso}' THEN 1 ELSE 0 END) as fresh
                FROM (
                    SELECT e.employeeId, MAX(ra.assessedAt) as last_assessed
                    FROM v_employee_readiness e
                    LEFT JOIN v_resolved_assessments ra ON ra.employeeId = e.employeeId
                    WHERE 1=1 ${fc3}
                    GROUP BY e.employeeId
                ) AS s
            `;
            const freshness = await db.get(freshSql, params3);

            // Sub-scores (each 0-100) — or NULL when the axis has no measurement.
            // House rule: an absence of measurement is never a number. Each axis
            // says whether it was measured, and the composite is the weighted
            // mean of the MEASURED axes only (weights renormalised), naming the
            // axes it left out. Before: no assessed critical requirement → 100,
            // no role → staffing 100, nobody assessed → readiness/freshness 0.
            const readinessScore =
                Number(kpis.assessedCount) > 0 && kpis.avgReadiness != null
                    ? Number(kpis.avgReadiness)
                    : null;
            // Coverage = assessed requirements / expected requirements — the
            // same fraction the KPI strip prints, not the has-a-benchmark ratio.
            const coverageScore =
                Number(kpis.expectedRequirements) > 0
                    ? Math.round(
                          (100.0 * Number(kpis.assessedRequirements)) /
                              Number(kpis.expectedRequirements)
                      )
                    : null;
            const complianceScore =
                Number(kpis.criticalAssessed) > 0 && kpis.criticalCompliance != null
                    ? Number(kpis.criticalCompliance)
                    : null;
            const staffingScore =
                Number(staffing.totalRoles) > 0
                    ? (Number(staffing.healthyRoles) / Number(staffing.totalRoles)) * 100
                    : null;
            const freshnessScore =
                Number(freshness.total) > 0
                    ? (Number(freshness.fresh) / Number(freshness.total)) * 100
                    : null;

            const axes = {
                readiness: { score: readinessScore, weight: 25 },
                coverage: { score: coverageScore, weight: 15 },
                compliance: { score: complianceScore, weight: 25 },
                staffing: { score: staffingScore, weight: 15 },
                freshness: { score: freshnessScore, weight: 20 },
            };
            const breakdown = {};
            const unmeasured = [];
            let weighted = 0;
            let weightSum = 0;
            for (const [name, axis] of Object.entries(axes)) {
                const measured = axis.score != null && Number.isFinite(Number(axis.score));
                breakdown[name] = {
                    score: measured ? Math.round(Number(axis.score)) : null,
                    weight: axis.weight,
                    measured,
                };
                if (measured) {
                    weighted += Number(axis.score) * axis.weight;
                    weightSum += axis.weight;
                } else {
                    unmeasured.push(name);
                }
            }

            if (weightSum === 0) {
                return { score: null, status: 'unknown', measured: false, unmeasured, breakdown };
            }
            const compositeExact = weighted / weightSum;
            const composite = Math.round(compositeExact);

            // Status label — banded on the UNROUNDED composite (see
            // bandHealthStatus). The displayed `score` stays rounded; the STATUS
            // is the honest judgement of where the true value sits.
            const status = bandHealthStatus(compositeExact);

            return {
                score: Math.min(100, Math.max(0, composite)),
                status,
                measured: true,
                // Non-empty when the composite covers only part of the axes —
                // the caller must say so next to the number.
                unmeasured,
                breakdown,
            };
        }
    }

    /**
     * Critical Roles at Risk — Roles with ≤1 qualified employee (readiness >=80%).
     * Returns enriched data for executive attention.
     */
    async getCriticalRolesDetail(filters) {
        try {
            const params = [];
            const fc = this._buildFilterClause(filters, params, 'e');

            // ONE DEFINITION OF "AT RISK", shared with the KPI strip.
            //
            // This table and the `rolesAtRisk` KPI answered the same question
            // two different ways and printed 23 against 20 on the same screen:
            //
            //   KPI   (roles_at_risk CTE)  is_role_ready = 1, and only over
            //                              roles somebody has MEASURED
            //   table (here)               readiness_assessed_only >= 80, with
            //                              no measured guard at all
            //
            // The CTE's own comment explains why is_role_ready is the right
            // one: readiness_assessed_only is the score over whatever happened
            // to be measured, so somebody rated on 2 of 13 skills, both met,
            // scored 100 % and was counted role-ready at 15 % coverage. And
            // with no measured guard a role nobody has ever assessed is
            // reported as at-risk — "nobody capable" where the truth is
            // "nobody measured". Both are corrected here to match the KPI.
            //
            // Coverage still travels along so the reader can tell the two
            // apart on the row itself.
            const sql = `
                SELECT
                    e.roleId,
                    e.roleName,
                    -- ::int, not bigint. COUNT/SUM return bigint, which the pg
                    -- driver hands back as a STRING to preserve precision, and
                    -- the client classifier compares with === against numbers:
                    -- "0" === 0 is false, so every branch missed and all 23
                    -- rows rendered as a generic "RISK" badge instead of
                    -- VACANT / NO CAPABILITY / 1 ONLY / LOW DEPTH.
                    COUNT(e.employeeId)::int as headcount,
                    COUNT(c.readiness_assessed_only)::int as measuredCount,
                    SUM(CASE WHEN e.is_role_ready = 1 THEN 1 ELSE 0 END)::int as qualifiedCount,
                    ROUND(AVG(c.readiness_assessed_only), 1) as avgReadiness,
                    ROUND(100.0 * SUM(COALESCE(c.assessed_skills, 0))
                          / NULLIF(SUM(COALESCE(c.expected_skills, 0)), 0), 1) as coverage,
                    ROUND(AVG(e.totalGapPoints), 1) as avgGapPoints,
                    GROUP_CONCAT(
                        CASE WHEN e.is_role_ready = 1
                        THEN e.fullName END
                    ) as qualifiedNames,
                    GROUP_CONCAT(DISTINCT e.siteName) as sites
                ${this._readinessFrom('e', 'c')}
                WHERE 1=1 ${fc}
                GROUP BY e.roleId, e.roleName
                HAVING SUM(CASE WHEN e.is_role_ready = 1 THEN 1 ELSE 0 END) <= 1
                   AND COUNT(c.readiness_assessed_only) > 0
                ORDER BY SUM(CASE WHEN e.is_role_ready = 1 THEN 1 ELSE 0 END) ASC, COUNT(e.employeeId) DESC
            `;

            return await db.all(sql, params);
        } catch (error) {
            // An error is not "no role at risk" — let it surface.
            console.error('Error fetching critical roles detail:', error);
            throw error;
        }
    }

    /**
     * Organizational Health Metrics — multi-dimensional health snapshot.
     */
    async getOrgHealthMetrics(filters) {
        try {
            const params1 = [];
            const fc1 = this._buildFilterClause(filters, params1, 'e');

            // Bench depth: avg number of ROLE-READY employees per MEASURED role.
            // Was AVG over every role with qualified = readiness_assessed_only
            // >= 80; a never-measured role contributed qc 0 and dragged the mean
            // down (1.56 shipped vs 1.72 correct), and it used a different
            // "qualified" definition than the KPI. Now is_role_ready, and the
            // HAVING excludes roles nobody has measured so bench depth is not
            // depressed by absence.
            const benchSql = `
                SELECT ROUND(AVG(qc), 1) as avgBenchDepth
                FROM (
                    SELECT e.roleName, SUM(CASE WHEN e.is_role_ready = 1 THEN 1 ELSE 0 END) as qc
                    ${this._readinessFrom('e', 'c')}
                    WHERE 1=1 ${fc1}
                    GROUP BY e.roleName
                    HAVING COUNT(c.readiness_assessed_only) > 0
                ) AS r
            `;
            const bench = await db.get(benchSql, params1);

            // Assessment freshness: % assessed within 6 months
            const params2 = [];
            const fc2 = this._buildFilterClause(filters, params2, 'e');
            const sixMonthsAgo = new Date();
            sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
            const cutoffIso = sixMonthsAgo.toISOString();
            // Freshness reads v_resolved_assessments, not skillAssessments:
            // an APPROVED self-assessment is a real, dated rating, and ignoring
            // it reported people as "never assessed" who had been.
            const freshSql = `
                SELECT
                    COUNT(*) as total,
                    SUM(CASE WHEN last_assessed >= '${cutoffIso}' THEN 1 ELSE 0 END) as freshCount,
                    SUM(CASE WHEN last_assessed IS NULL THEN 1 ELSE 0 END) as neverAssessed
                FROM (
                    SELECT e.employeeId, MAX(ra.assessedAt) as last_assessed
                    FROM v_employee_readiness e
                    LEFT JOIN v_resolved_assessments ra ON ra.employeeId = e.employeeId
                    WHERE 1=1 ${fc2}
                    GROUP BY e.employeeId
                ) AS s
            `;
            const fresh = await db.get(freshSql, params2);

            // Skill coverage: assessed / expected REQUIREMENTS, straight off the
            // canonical coverage view. The old query re-derived it from
            // skillAssessments alone (ignoring approved self-assessments) and
            // so disagreed with the KPI strip on the same scope.
            const params3 = [];
            const fc3 = this._buildFilterClause(filters, params3, 'c');
            const coverageSql = `
                SELECT
                    SUM(COALESCE(c.expected_skills, 0)) as totalRequired,
                    SUM(COALESCE(c.assessed_skills, 0)) as assessed
                FROM v_employee_assessment_coverage c
                WHERE 1=1 ${fc3}
            `;
            const coverage = await db.get(coverageSql, params3);

            // Department ranking by avg readiness.
            //
            // readyCount counts is_role_ready, NOT readiness_assessed_only >= 80.
            // The KPI strip counts is_role_ready (roleReadyCount) and so does
            // getReadinessByGroup; this line counted the assessed-only score, so
            // the department-ranking tooltip printed "Ready: 50" for IT while
            // the KPI six inches away said 48. (Comment lives in JS, not in the
            // SQL: a -- line comment inside this template literal breaks the
            // SQLite-compat translator.)
            const params4 = [];
            const fc4 = this._buildFilterClause(filters, params4, 'e');
            const deptSql = `
                SELECT
                    e.departmentName as label,
                    ROUND(AVG(c.readiness_assessed_only), 1) as avgReadiness,
                    COUNT(e.employeeId) as headcount,
                    COUNT(c.readiness_assessed_only) as measuredCount,
                    ROUND(100.0 * SUM(COALESCE(c.assessed_skills, 0))
                          / NULLIF(SUM(COALESCE(c.expected_skills, 0)), 0), 1) as coverage,
                    COUNT(CASE WHEN e.isRoleReady = 1 THEN 1 END) as readyCount,
                    COUNT(CASE WHEN c.readiness_assessed_only < 50 THEN 1 END) as criticalCount
                ${this._readinessFrom('e', 'c')}
                WHERE 1=1 ${fc4}
                GROUP BY e.departmentName
                HAVING COUNT(e.employeeId) > 0
                ORDER BY AVG(c.readiness_assessed_only) DESC NULLS LAST
            `;
            const deptRanking = await db.all(deptSql, params4);

            // Top 5 highest-impact skill gaps
            const params5 = [];
            const fc5 = this._buildFilterClause(filters, params5, 'g');
            // Order by the number the chart actually PRINTS. SUM(g.gap)
            // already adds up across every affected employee, so multiplying
            // by the headcount again weighted headcount twice, and the bars
            // came out visibly unsorted: 42, 33, 33, 36, 28.
            //
            // NOTE: this comment lives in JS, not inside the SQL. Any comment
            // inside THIS statement — line or block — makes the compat layer
            // snake-case g.skillName in the SELECT while leaving the GROUP BY
            // alone, and PG then rejects the query outright. Verified both
            // ways against the live statement.
            const impactSql = `
                SELECT
                    g.skillName,
                    g.domainName,
                    ROUND(AVG(g.gap), 1) as avgGap,
                    COUNT(DISTINCT g.employeeId) as affected,
                    SUM(g.gap) as totalImpact,
                    MAX(g.isCritical) as isCritical
                FROM v_employee_skill_gaps g
                WHERE g.gap > 0 AND g.isAssessed = 1 ${fc5}
                GROUP BY g.skillId
                ORDER BY SUM(g.gap) DESC, COUNT(DISTINCT g.employeeId) DESC, MIN(g.skillName)
                LIMIT 5
            `;
            const topImpactGaps = await db.all(impactSql, params5);

            // Unmeasured is NULL, never 0: no role → no bench depth, nobody on
            // the roster → no freshness, no requirement → no coverage. A card
            // must print "—" for these, not "0 %".
            return {
                benchDepth: bench.avgBenchDepth != null ? Number(bench.avgBenchDepth) : null,
                assessmentFreshness:
                    Number(fresh.total) > 0
                        ? Math.round((Number(fresh.freshCount) / Number(fresh.total)) * 100)
                        : null,
                neverAssessedCount: Number(fresh.neverAssessed) || 0,
                skillCoverage:
                    Number(coverage.totalRequired) > 0
                        ? Math.round(
                              (Number(coverage.assessed) / Number(coverage.totalRequired)) * 100
                          )
                        : null,
                assessedRequirements: Number(coverage.assessed) || 0,
                expectedRequirements: Number(coverage.totalRequired) || 0,
                deptRanking,
                topImpactGaps,
            };
        } catch (error) {
            // This used to answer zeros and empty lists on ANY database error —
            // measured with a 57014 statement timeout: bench depth 0, freshness
            // 0 %, coverage 0 %, no department, no gap. Rendered as a real "0 %"
            // by the cards. An error is an error.
            console.error('Error fetching org health metrics:', error);
            throw error;
        }
    }
}

module.exports = new DashboardModel();
module.exports.bandHealthStatus = bandHealthStatus;
module.exports.reportingLineStats = reportingLineStats;
