'use strict';

/**
 *  ReportDataService — real data for the composite Report Builder.
 *
 *  Replaces the client-side mock generator. Given a section config
 *  (source view, dimension(s), metric, aggregation, sort, limit) it builds a
 *  parameterised aggregation query against the allow-listed PG views and
 *  returns data in exactly the shapes rb-renderers.js expects.
 *
 *  Safety: every table/column comes from the SOURCE_SCHEMA allow-list — never
 *  from raw user input. The user only chooses *keys* (e.g. dimension='site'),
 *  which map to known columns. Limit is integer-clamped; filter values are
 *  bound parameters.
 *
 *  CLEARANCE (v3.22.79): scope is resolved through the SAME path the screens
 *  use — `utils/rbacScope.scopedEmployeeIds` → RBACService.getFilteredEmployees
 *  for admins, EmployeeModel.findGovernedIds for managers/supervisors. The old
 *  implementation read `adminScopes WHERE adminId = user.id` with a MANAGER's
 *  EMPLOYEE id (two different id sequences), found no rows and emitted `1=0`,
 *  so every manager report returned an empty grid / empty chart / empty CSV
 *  with no error at all.
 *
 *  PROVENANCE (migration 71): "never assessed" is NOT an earned zero. Every
 *  source that could show a fabricated 0 now reads the provenance views
 *  (v_requirement_provenance / v_employee_assessment_coverage) so an
 *  unmeasured requirement yields NULL — excluded from AVG/SUM — and the
 *  coverage denominator (assessed / expected) travels with the payload.
 *  Numbers for genuinely assessed data are unchanged: for a fully assessed
 *  employee `readiness_assessed_only` is computed over the same requirement
 *  set as `readiness`, i.e. the identical figure.
 */

const db = require('../config/database');
const { scopedEmployeeIds } = require('../utils/rbacScope');

// ---------------------------------------------------------------------------
// Derived-table expressions. These are SERVER-OWNED SQL constants (never user
// input) used verbatim in the FROM clause. They deliberately contain no
// GROUP BY: the DB compat layer's expandGroupBy rewrites the FIRST GROUP BY
// it finds, so a grouped sub-select here would be rewritten instead of ours.
// ---------------------------------------------------------------------------

// Readiness + per-employee assessment coverage side by side.
const V_READINESS = `(
    SELECT v.employee_id, v.full_name,
           v.site_id, v.site_name, v.department_id, v.department_name,
           v.service_id, v.service_name, v.role_id, v.role_name,
           v.total_required, v.skills_met, v.total_gap_points, v.total_critical,
           v.critical_met, v.points_gained, v.points_required,
           v.readiness, v.is_role_ready,
           COALESCE(c.expected_skills, 0)       AS expected_skills,
           COALESCE(c.assessed_skills, 0)       AS assessed_skills,
           COALESCE(c.never_assessed_skills, 0) AS never_assessed_skills,
           COALESCE(c.self_only_skills, 0)      AS self_only_skills,
           COALESCE(c.validated_skills, 0)      AS validated_skills,
           c.coverage                           AS coverage,
           c.readiness_assessed_only            AS readiness_assessed_only,
           CASE WHEN COALESCE(c.assessed_skills, 0) = 0 THEN 'never_assessed'
                WHEN COALESCE(c.validated_skills, 0) = 0 THEN 'self_only'
                ELSE 'assessed' END             AS assessment_status
      FROM v_employee_readiness v
      LEFT JOIN v_employee_assessment_coverage c ON c.employee_id = v.employee_id
) AS r`;

// Requirement-level gaps rebuilt on the provenance view: a requirement nobody
// ever rated has actual_level / gap / is_met = NULL (not 0), so it can never be
// aggregated as a measured zero.
const V_GAPS = `(
    SELECT p.employee_id, ed.full_name,
           p.site_id, p.site_name, p.department_id, p.department_name,
           p.service_id, p.service_name, p.role_id, p.role_name,
           p.skill_id, p.skill_name, p.domain_id, p.domain_name,
           p.required_level, p.is_critical, p.assessment_status, p.is_assessed,
           p.assessed_level AS actual_level,
           -- a SHORTFALL, clamped at 0. The raw (required - assessed) is
           -- signed, negative when someone exceeds the requirement, and gap is an
           -- aggregatable Report Builder measure, so a SUM/AVG let one
           -- over-qualified person cancel another shortfall and understate the
           -- true deficit. Exceeding a requirement is a met requirement (is_met
           -- already says so), never a negative gap. Unmeasured stays NULL, not 0.
           -- The gapsOnly filter (gap > 0) and is_critical_gap are unaffected.
           CASE WHEN p.assessed_level IS NULL THEN NULL
                ELSE GREATEST(p.required_level - p.assessed_level, 0) END AS gap,
           CASE WHEN p.assessed_level IS NULL THEN NULL
                WHEN p.assessed_level >= p.required_level THEN 1 ELSE 0 END AS is_met,
           CASE WHEN p.assessed_level IS NOT NULL AND p.is_critical
                     AND p.assessed_level < p.required_level THEN 1 ELSE 0 END AS is_critical_gap,
           CASE WHEN p.assessment_status = 'never_assessed' THEN 1 ELSE 0 END AS is_never_assessed,
           CASE WHEN p.assessment_status = 'self_only' THEN 1 ELSE 0 END AS is_self_only,
           CASE WHEN p.cert_lapsed THEN 1 ELSE 0 END AS is_cert_lapsed
      FROM v_requirement_provenance p
      JOIN v_employee_details ed ON ed.employee_id = p.employee_id
) AS g`;

// Per-employee coverage (assessed / expected) with a display name.
const V_COVERAGE = `(
    SELECT c.employee_id, ed.full_name,
           c.site_id, c.site_name, c.department_id, c.department_name,
           c.service_id, c.service_name, c.role_id, c.role_name,
           c.expected_skills, c.assessed_skills, c.never_assessed_skills,
           c.self_only_skills, c.validated_skills,
           c.critical_assessed, c.critical_expected,
           c.coverage, c.readiness_assessed_only,
           CASE WHEN c.assessed_skills = 0 THEN 1 ELSE 0 END AS is_never_assessed,
           CASE WHEN c.assessed_skills = 0 THEN 'never_assessed'
                WHEN c.validated_skills = 0 THEN 'self_only'
                ELSE 'assessed' END AS assessment_status
      FROM v_employee_assessment_coverage c
      JOIN v_employee_details ed ON ed.employee_id = c.employee_id
) AS cov`;

// Requirement provenance, straight up — one row per (employee, required skill).
const V_PROVENANCE = `(
    SELECT p.employee_id, ed.full_name,
           p.site_id, p.site_name, p.department_id, p.department_name,
           p.service_id, p.service_name, p.role_id, p.role_name,
           p.skill_id, p.skill_name, p.domain_id, p.domain_name,
           p.required_level, p.is_critical, p.assessed_level, p.assessment_status,
           p.is_assessed,
           CASE WHEN p.assessment_status = 'never_assessed' THEN 1 ELSE 0 END AS is_never_assessed,
           CASE WHEN p.assessment_status = 'self_only' THEN 1 ELSE 0 END AS is_self_only,
           CASE WHEN p.assessment_status = 'assessed' THEN 1 ELSE 0 END AS is_validated,
           CASE WHEN p.cert_lapsed THEN 1 ELSE 0 END AS is_cert_lapsed
      FROM v_requirement_provenance p
      JOIN v_employee_details ed ON ed.employee_id = p.employee_id
) AS pv`;

// 9-box: the finalised placement of the latest cycle. `box` is stored as
// `${potential}-${performance}` (TalentService), so part 1 = potential.
const V_NINEBOX = `(
    SELECT tp.employee_id, ed.full_name,
           ed.site_id, ed.site_name, ed.department_id, ed.department_name,
           ed.service_id, ed.service_name, ed.role_id, ed.role_name,
           tp.box, tp.tier::text AS tier, tp.source::text AS placement_source, tp.placed_at,
           CASE split_part(tp.box, '-', 2)
                WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END AS performance_score,
           CASE split_part(tp.box, '-', 1)
                WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END AS potential_score
      FROM talent_placements tp
      JOIN v_employee_details ed ON ed.employee_id = tp.employee_id
     WHERE tp.cycle_id = (SELECT MAX(cycle_id) FROM talent_placements)
) AS nb`;

// Per-source allow-list: which dimensions/metrics are valid and their columns.
const SOURCE_SCHEMA = {
    v_employee_readiness: {
        view: V_READINESS,
        dims: {
            site: 'site_name',
            department: 'department_name',
            service: 'service_name',
            role: 'role_name',
            employee: 'full_name',
        },
        metrics: {
            // readiness_assessed_only is NULL when nothing was ever assessed and
            // identical to `readiness` for a fully assessed employee.
            readinessPct: { col: 'readiness_assessed_only' },
            pointsGained: { col: 'CASE WHEN assessed_skills > 0 THEN points_gained END' },
            pointsRequired: { col: 'points_required' },
            // total_gap_points counts ASSESSED requirements only since migration
            // 79 (an unrated requirement is an unknown, not a deficit). The
            // guard stays: for somebody never assessed the sum is a truthful 0
            // that would still READ as "no gaps", so it is NULL instead.
            gapCount: { col: 'CASE WHEN assessed_skills > 0 THEN total_gap_points END' },
            roleReady: { col: 'CASE WHEN assessed_skills > 0 THEN is_role_ready END' },
            skillsMet: { col: 'CASE WHEN assessed_skills > 0 THEN skills_met END' },
            totalRequired: { col: 'total_required' },
            coveragePct: { col: 'coverage' },
            assessedSkills: { col: 'assessed_skills' },
            expectedSkills: { col: 'expected_skills' },
            neverAssessedSkills: { col: 'never_assessed_skills' },
        },
        nameCols: { site: 'site_name', department: 'department_name', role: 'role_name' },
        statusCol: 'assessment_status',
        scatter: {
            x: 'points_gained',
            y: 'points_required',
            label: 'full_name',
            order: 'readiness_assessed_only DESC NULLS LAST',
        },
    },
    v_employee_skill_gaps: {
        view: V_GAPS,
        dims: {
            site: 'site_name',
            department: 'department_name',
            service: 'service_name',
            role: 'role_name',
            skill: 'skill_name',
            domain: 'domain_name',
            employee: 'full_name',
        },
        metrics: {
            requiredLevel: { col: 'required_level' },
            currentLevel: { col: 'actual_level' },
            gap: { col: 'gap' },
            isCritical: { col: 'is_critical', bool: true },
            isMet: { col: 'is_met' },
            criticalGapCount: { col: 'is_critical_gap' },
            neverAssessedCount: { col: 'is_never_assessed' },
            selfOnlyCount: { col: 'is_self_only' },
            lapsedCount: { col: 'is_cert_lapsed' },
        },
        nameCols: {
            site: 'site_name',
            department: 'department_name',
            role: 'role_name',
            domain: 'domain_name',
        },
        flags: { critical: 'is_critical', gap: 'gap' },
        statusCol: 'assessment_status',
    },
    v_domain_capability: {
        view: 'v_domain_capability',
        dims: {
            site: 'site_name',
            department: 'department_name',
            service: 'service_name',
            role: 'role_name',
            domain: 'domain_name',
            skill: 'skill_name',
        },
        metrics: {
            avgLevel: { col: 'level' },
            maxLevel: { col: 'level' },
            minLevel: { col: 'level' },
            assessmentCount: { col: 'level', count: true },
            resolvedLevel: { col: 'level' },
        },
        nameCols: {
            site: 'site_name',
            department: 'department_name',
            role: 'role_name',
            domain: 'domain_name',
        },
    },
    v_employee_details: {
        view: 'v_employee_details',
        dims: {
            site: 'site_name',
            department: 'department_name',
            service: 'service_name',
            role: 'role_name',
            employee: 'full_name',
        },
        metrics: { employeeCount: { col: 'employee_id', distinctCount: true } },
        nameCols: { site: 'site_name', department: 'department_name', role: 'role_name' },
    },
    v_resolved_assessments: {
        view: 'v_domain_capability', // has names + level
        dims: { employee: 'employee_id', skill: 'skill_name', domain: 'domain_name' },
        metrics: {
            resolvedLevel: { col: 'level' },
            assessmentCount: { col: 'level', count: true },
        },
        nameCols: { domain: 'domain_name' },
    },
    // ---- Provenance sources (migration 71) --------------------------------
    v_employee_assessment_coverage: {
        view: V_COVERAGE,
        dims: {
            site: 'site_name',
            department: 'department_name',
            service: 'service_name',
            role: 'role_name',
            employee: 'full_name',
        },
        metrics: {
            coveragePct: { col: 'coverage' },
            assessedSkills: { col: 'assessed_skills' },
            expectedSkills: { col: 'expected_skills' },
            neverAssessedSkills: { col: 'never_assessed_skills' },
            selfOnlySkills: { col: 'self_only_skills' },
            validatedSkills: { col: 'validated_skills' },
            readinessAssessedOnly: { col: 'readiness_assessed_only' },
            neverAssessedEmployees: { col: 'is_never_assessed' },
            employeeCount: { col: 'employee_id', distinctCount: true },
        },
        nameCols: { site: 'site_name', department: 'department_name', role: 'role_name' },
        statusCol: 'assessment_status',
    },
    v_requirement_provenance: {
        view: V_PROVENANCE,
        dims: {
            site: 'site_name',
            department: 'department_name',
            service: 'service_name',
            role: 'role_name',
            skill: 'skill_name',
            domain: 'domain_name',
            employee: 'full_name',
        },
        metrics: {
            requirementCount: { col: 'skill_id', count: true },
            assessedCount: { col: 'is_assessed' },
            neverAssessedCount: { col: 'is_never_assessed' },
            selfOnlyCount: { col: 'is_self_only' },
            validatedCount: { col: 'is_validated' },
            requiredLevel: { col: 'required_level' },
            assessedLevel: { col: 'assessed_level' },
            lapsedCount: { col: 'is_cert_lapsed' },
        },
        nameCols: {
            site: 'site_name',
            department: 'department_name',
            role: 'role_name',
            domain: 'domain_name',
        },
        statusCol: 'assessment_status',
    },
    // ---- Talent 9-box ------------------------------------------------------
    nineBoxAssessments: {
        view: V_NINEBOX,
        dims: {
            site: 'site_name',
            department: 'department_name',
            service: 'service_name',
            role: 'role_name',
            employee: 'full_name',
            box: 'box',
            tier: 'tier',
        },
        metrics: {
            performanceScore: { col: 'performance_score' },
            potentialScore: { col: 'potential_score' },
            employeeCount: { col: 'employee_id', distinctCount: true },
        },
        nameCols: { site: 'site_name', department: 'department_name', role: 'role_name' },
        scatter: {
            x: 'performance_score',
            y: 'potential_score',
            label: 'full_name',
            order: 'placed_at DESC',
        },
    },
};

const AGG_FN = { avg: 'AVG', sum: 'SUM', min: 'MIN', max: 'MAX' };

// Chart types whose renderer does arithmetic on the value and would print a
// NULL as "0 %". Those sections drop unmeasured groups instead of drawing a
// bar that nobody earned.
const DROP_NULL_CHARTS = new Set(['progress', 'gauge']);

function clampLimit(n) {
    const v = parseInt(n, 10);
    if (!Number.isFinite(v) || v <= 0) return 20;
    return Math.min(v, 200);
}

function aggExpr(agg, metric) {
    if (metric.distinctCount || agg === 'count_distinct') return `COUNT(DISTINCT ${metric.col})`;
    if (metric.count || agg === 'count') return `COUNT(*)`;
    const fn = AGG_FN[agg] || 'AVG';
    const col = metric.bool ? `(${metric.col})::int` : metric.col;
    return `${fn}(${col})`;
}

function n2(v) {
    const x = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(x) ? x : 0;
}

/** Round for display but keep NULL as null — never fabricate an earned zero. */
function num(v) {
    if (v === null || v === undefined) return null;
    const x = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(x) ? Math.round(x * 100) / 100 : null;
}

/** Localised label with an English fallback (t is req.t; may be absent). */
function L(t, key, fallback) {
    if (typeof t !== 'function') return fallback;
    try {
        const full = 'admin:' + key;
        const s = t(full);
        return s && s !== full && s !== key ? s : fallback;
    } catch (_) {
        return fallback;
    }
}

/** reports-namespace label with a fallback (the KPI strip). */
function LR(t, key, fallback, vars) {
    if (typeof t !== 'function') return fallback;
    try {
        const full = 'reports:' + key;
        const s = vars ? t(full, vars) : t(full);
        return s && s !== full && s !== key ? s : fallback;
    } catch (_) {
        return fallback;
    }
}

class ReportDataService {
    // Build the WHERE clause (RBAC + global filters) for a source.
    async _where(schema, filters, user) {
        const clauses = [];
        const params = [];

        // RBAC — resolved through the shared helper, so a MANAGER is scoped by
        // their governed employee sub-tree (employee id-space) and an admin by
        // their assigned scopes (admin id-space). Every allow-listed source
        // exposes employee_id, so one uniform predicate covers them all.
        const ids = await scopedEmployeeIds(user);
        if (ids === null) {
            // Unrestricted (super admin).
        } else if (!ids.length) {
            clauses.push('1 = 0');
        } else {
            clauses.push('employee_id = ANY(?)');
            params.push(ids);
        }

        // Global filters (arrays of names). Only apply where the column exists.
        const f = filters || {};
        const inFilter = (key, col) => {
            const vals = f[key];
            if (col && Array.isArray(vals) && vals.length) {
                clauses.push(`${col} IN (${vals.map(() => '?').join(', ')})`);
                params.push(...vals);
            }
        };
        inFilter('sites', schema.nameCols.site);
        inFilter('departments', schema.nameCols.department);
        inFilter('domains', schema.nameCols.domain);
        inFilter('roles', schema.nameCols.role);
        if (schema.flags) {
            if (f.criticalOnly && schema.flags.critical)
                clauses.push(`${schema.flags.critical} = 1`);
            // A gap you never measured is not a measured gap: NULL > 0 is NULL,
            // so unmeasured requirements drop out here by construction.
            if (f.gapsOnly && schema.flags.gap) clauses.push(`${schema.flags.gap} > 0`);
        }

        return { sql: clauses.length ? ' WHERE ' + clauses.join(' AND ') : '', params };
    }

    async getSectionData(config, user, t) {
        const schema = SOURCE_SCHEMA[config.source];
        if (!schema) return { error: `Unknown source: ${config.source}`, labels: [], data: [] };

        const chart = config.chartType || 'bar';
        if (chart === 'kpi') return this._kpi(schema, config, user, t);
        if (chart === 'scatter') return this._scatter(schema, config, user);

        const dimCol = schema.dims[config.dimension];
        const metric = schema.metrics[config.metric];
        if (!dimCol || !metric) {
            return { error: 'Invalid dimension or metric for this source', labels: [], data: [] };
        }
        const dim2Col = config.dimension2 ? schema.dims[config.dimension2] : null;
        const agg = aggExpr(config.aggregation, metric);
        const limit = clampLimit(config.limit);
        const where = await this._where(schema, config._filters, user);

        if (chart === 'gauge') {
            const rows = await db.all(
                `SELECT ${agg} AS value FROM ${schema.view}${where.sql}`,
                where.params
            );
            const v = num(rows[0] && rows[0].value);
            return {
                labels: [config.dimension || 'Value'],
                data: [v === null ? 0 : Math.round(v * 10) / 10],
                unmeasured: v === null,
            };
        }

        // Grouped query (optionally pivoted by dimension2).
        const orderBy = (() => {
            const dir = (config.sortOrder || 'desc').toLowerCase();
            if (dir === 'alpha' || dir === 'asc') return 'label ASC';
            if (dir === 'none') return 'label ASC';
            // NULLS LAST: an unmeasured group must never head a "worst first" list.
            return 'value DESC NULLS LAST';
        })();

        if (
            dim2Col &&
            (chart === 'heatmap' ||
                chart === 'stackedBar' ||
                chart === 'radar' ||
                chart === 'line' ||
                chart === 'area')
        ) {
            const rows = await db.all(
                `SELECT ${dimCol} AS label, ${dim2Col} AS grp, ${agg} AS value
                 FROM ${schema.view}${where.sql}
                 GROUP BY ${dimCol}, ${dim2Col}
                 ORDER BY ${dimCol} ASC`,
                where.params
            );
            return this._pivot(rows, chart, limit);
        }

        // Provenance columns travel with a table so the reader sees the
        // denominator (assessed / expected) next to every figure.
        const provSel = schema.statusCol
            ? `, SUM(CASE WHEN ${schema.statusCol} = 'never_assessed' THEN 1 ELSE 0 END)::int AS never_ct
               , COUNT(*)::int AS total_ct`
            : '';

        const rows = await db.all(
            `SELECT ${dimCol} AS label, ${agg} AS value${chart === 'table' ? provSel : ''}
             FROM ${schema.view}${where.sql}
             GROUP BY ${dimCol}
             ORDER BY ${orderBy}
             LIMIT ${limit}`,
            where.params
        );

        if (chart === 'table') {
            const dimName = config.dimension;
            const metName = config.metric;
            const columns = [dimName, metName];
            const covCol = L(t, 'rb_col_coverage', 'Coverage (assessed / expected)');
            if (schema.statusCol) columns.push(covCol);
            return {
                columns,
                rows: rows.map((r) => {
                    const total = n2(r.totalCt);
                    const never = n2(r.neverCt);
                    // Column names come from the request: build the row in a Map.
                    const out = new Map([
                        [dimName, r.label == null ? '—' : r.label],
                        [metName, num(r.value)],
                    ]);
                    if (schema.statusCol) {
                        out.set(
                            covCol,
                            total > 0 && never >= total
                                ? L(t, 'rb_status_never_assessed', 'Never assessed')
                                : `${total - never} / ${total}`
                        );
                    }
                    return Object.fromEntries(out);
                }),
            };
        }

        const keep = DROP_NULL_CHARTS.has(chart) ? rows.filter((r) => num(r.value) !== null) : rows;
        const labels = keep.map((r) => (r.label == null ? '—' : String(r.label)));
        const data = keep.map((r) => num(r.value));
        const omitted = rows.length - keep.length;
        // There ARE rows, but not one of them was ever assessed: say "jamais
        // évalué" instead of drawing a chart of zeros/empty bars that reads as
        // a measured result.
        if (rows.length > 0 && data.every((v) => v === null)) {
            return { labels, data, unmeasured: true, unmeasuredGroups: rows.length };
        }
        return omitted > 0 ? { labels, data, unmeasuredGroups: omitted } : { labels, data };
    }

    _pivot(rows, chart, limit) {
        const labels = [
            ...new Set(rows.map((r) => (r.label == null ? '—' : String(r.label)))),
        ].slice(0, limit);
        const groups = [...new Set(rows.map((r) => (r.grp == null ? '—' : String(r.grp))))];
        const lookup = {};
        // Normalize NULL label/grp to '—' in the KEY too — the labels/groups arrays above
        // do, so a raw-null key ("null||…") never matched and NULL-dimension rows (e.g. an
        // employee with no department) silently rendered as 0.
        rows.forEach((r) => {
            const l = r.label == null ? '—' : String(r.label);
            const g = r.grp == null ? '—' : String(r.grp);
            lookup[`${l}||${g}`] = num(r.value);
        });

        // `??` (not `||`): a real measured 0 must stay 0, and a cell with NO row
        // at all is unmeasured → null, which the heatmap prints as '—' and
        // Chart.js draws as a gap rather than an earned zero.
        const cell = (l, g) => {
            const v = lookup[`${l}||${g}`];
            return v === undefined ? null : v;
        };

        if (chart === 'heatmap') {
            const cols = groups.slice(0, 12);
            const cells = labels.map((l) => cols.map((c) => cell(l, c)));
            return { rows: labels, cols, cells };
        }
        const datasets = groups.slice(0, 8).map((g) => ({
            label: g,
            data: labels.map((l) => cell(l, g)),
        }));
        return { labels, datasets };
    }

    /**
     * The builder KPI strip. Every figure is a KpiService indicator on the SAME
     * population as the reports, the API and the Power BI feed
     * (c326-DR-reconciliation-db.test.js: K1 here = K1 on /reports/readiness
     * = Power BI v2 = KpiService):
     *   K1 Role-ready rate "of N with a verdict · coverage Y %",
     *   K2 Average readiness, K3 Assessment coverage, K4 Critical-skill
     *   compliance, then the ACTIVE headcount and the "Partially assessed" /
     *   "Not assessed" counts (never folded into a failure).
     * Site / department / role filters narrow the population (never widen it);
     * a domain filter is NOT applied to K1–K4: trimming a role's requirement
     * set is not allowed. An absence of measurement prints "Not measured",
     * a small group prints counts ("2 of 3"), never 0 %.
     */
    async _kpi(schema, config, user, t) {
        const KpiService = require('./KpiService');
        const kf = require('../utils/kpiFormat').forLang(config && config._lang);
        const scope = await this._kpiScope(config._filters, user);
        const pop = await KpiService.resolvePopulation(scope);
        const s = { ...scope, __population: pop };
        const k1 = await KpiService.k1RoleReady(s);
        const k2 = await KpiService.k2AvgReadiness(s);
        const k3 = await KpiService.k3Coverage(s);
        const k4 = await KpiService.k4CriticalCompliance(s);
        const b1 = k1.breakdown || {};
        const b3 = k3.breakdown || {};
        const unmeasured = LR(t, 'dr_unmeasured', 'Not measured');
        const pctItem = (key, label, r, sub) => {
            let display;
            if (r.value != null) display = kf.pct(r.value, 1);
            else if (r.status === 'small_n' && r.numerator != null && r.denominator)
                display = LR(t, 'dr_count_of', `${r.numerator} of ${r.denominator}`, {
                    num: r.numerator,
                    den: r.denominator,
                });
            else if (r.status === 'not_configured')
                display = LR(t, 'dr_not_configured', 'Not configured');
            else display = unmeasured;
            return {
                key,
                label: sub ? `${label} (${sub})` : label,
                value: r.value == null ? null : r.value,
                status: r.status || null,
                display,
                unmeasured: r.value == null,
            };
        };
        const countItem = (key, label, v) => ({
            key,
            label,
            value: v,
            status: null,
            display: kf.num(v, 0),
            unmeasured: false,
        });
        const coverageText = k1.coverage == null ? unmeasured : kf.pct(k1.coverage, 1);
        const k1Sub =
            k1.denominator > 0
                ? LR(
                      t,
                      'dr_k1_sub',
                      `of ${k1.denominator} with a verdict · coverage ${coverageText}`,
                      { n: k1.denominator, coverage: coverageText }
                  )
                : null;
        const assessed = b3.assessedRequirements == null ? 0 : b3.assessedRequirements;
        const expected = b3.expectedRequirements == null ? 0 : b3.expectedRequirements;
        return {
            items: [
                pctItem('K1', LR(t, 'dr_kpi_k1', 'Role-ready rate'), k1, k1Sub),
                pctItem('K2', LR(t, 'dr_kpi_k2', 'Average readiness'), k2),
                pctItem('K3', LR(t, 'dr_kpi_k3', 'Assessment coverage'), k3),
                pctItem('K4', LR(t, 'dr_kpi_k4', 'Critical-skill compliance'), k4),
                countItem(
                    'population',
                    LR(t, 'dr_kpi_population', 'Headcount (active)'),
                    pop.ids.length
                ),
                countItem(
                    'partial',
                    LR(t, 'dr_kpi_partial', 'Partially assessed'),
                    b1.partial || 0
                ),
                countItem(
                    'notAssessed',
                    LR(t, 'dr_kpi_unassessed', 'Not assessed'),
                    b1.notAssessed || 0
                ),
            ],
            k1: {
                value: k1.value,
                rawValue: k1.rawValue,
                numerator: k1.numerator,
                denominator: k1.denominator,
                status: k1.status,
                breakdown: b1,
            },
            coverage: {
                assessed,
                expected,
                pct: k3.rawValue == null ? null : k3.rawValue,
                neverAssessedEmployees: b1.notAssessed || 0,
                employees: pop.ids.length,
            },
        };
    }

    /**
     * KpiService scope of a builder section: the reader plus, when site /
     * department / role name filters are set, the ids of the people matching
     * them. resolvePopulation intersects those ids with the reader's clearance
     * and the active population, so a filter can only narrow. The filter
     * VALUES travel as parameters; only the three fixed column names below
     * reach the SQL text.
     */
    async _kpiScope(filters, user) {
        const f = filters || {};
        const cond = [];
        const params = [];
        const add = (vals, col) => {
            if (Array.isArray(vals) && vals.length) {
                cond.push(`${col} = ANY(?)`);
                params.push(vals.map(String));
            }
        };
        add(f.sites, 'st.name');
        add(f.departments, 'd.name');
        add(f.roles, 'r.name');
        if (!cond.length) return { viewer: user };
        const rows = await db.all(
            `SELECT e.id AS "id" FROM employees e
               LEFT JOIN sites st ON st.id = e.site_id
               LEFT JOIN departments d ON d.id = e.department_id
               LEFT JOIN roles r ON r.id = e.role_id
              WHERE ${cond.join(' AND ')}`,
            params
        );
        return { viewer: user, employeeIds: (rows || []).map((r) => Number(r.id)) };
    }

    async _scatter(schema, config, user) {
        const limit = clampLimit(config.limit);
        // Every scatter-capable source declares its own x/y/label columns, so the
        // 9-box grid is a first-class data source instead of a permanent error
        // box — and it goes through _where, i.e. it is clearance-scoped like
        // everything else (the previous hard-coded 9-box query had NO scoping).
        const spec = schema.scatter || SOURCE_SCHEMA.v_employee_readiness.scatter;
        const src = schema.scatter ? schema : SOURCE_SCHEMA.v_employee_readiness;
        const where = await this._where(src, config._filters, user);
        const rows = await db.all(
            `SELECT ${spec.label} AS label, ${spec.x} AS x, ${spec.y} AS y
             FROM ${src.view}${where.sql}
             ORDER BY ${spec.order} LIMIT ${limit}`,
            where.params
        );
        return { points: rows.map((p) => ({ label: p.label, x: n2(p.x), y: n2(p.y) })) };
    }

    listSources() {
        return Object.fromEntries(
            Object.entries(SOURCE_SCHEMA).map(([k, v]) => [
                k,
                { dims: Object.keys(v.dims), metrics: Object.keys(v.metrics) },
            ])
        );
    }
}

module.exports = new ReportDataService();
