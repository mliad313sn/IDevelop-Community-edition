'use strict';

const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const { translatePlaceholders, quoteCamelAliases } = require('./sql-compat');

let Pool;
let pgTypes;
try {
    const pg = require('pg');
    Pool = pg.Pool;
    pgTypes = pg.types;
} catch (e) {
    Pool = null;
}

// V1 (SQLite) returned NUMERIC / AVG / ROUND results as JS numbers, and the
// app's controllers, views and client charts assume that (e.g. value.toFixed).
// node-pg returns NUMERIC (OID 1700) as a string by default, which breaks those
// call sites. Parse NUMERIC back to a JS number to preserve V1 semantics.
// (FLOAT8/701 is already numeric in node-pg; integers stay integers.)
if (pgTypes && typeof pgTypes.setTypeParser === 'function') {
    pgTypes.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val)));
}

/**
 *   PostgresDatabase — drop-in replacement for the V1 SQLite Database class.
 *   - Same public surface (connect/run/get/all/runTransaction/migrate/seed/close).
 *   - Translates `?` placeholders to $1..$N.
 *   - Auto-appends `RETURNING id` to bare INSERTs so `lastID` works.
 *   - Translates camelCase table & column identifiers to snake_case in
 *     raw SQL strings (whole-word match, respects quoted strings).
 *   - Translates result row keys from snake_case back to camelCase so
 *     existing V1 callers see the same shape.
 */

// Identifier map: every camelCase token the V1 code uses → its PG snake_case.
// Order matters for longest-first matching. Build at module load.
const TABLE_MAP = {
    roleSkillRequirements: 'role_skill_requirements',
    skillAssessments: 'skill_assessments',
    assessmentHistory: 'assessment_history',
    selfAssessments: 'self_assessments',
    supervisorReviews: 'supervisor_reviews',
    trainingPlanItems: 'training_plan_items',
    trainingPlans: 'training_plans',
    reportTemplates: 'report_templates',
    adminScopes: 'admin_scopes',
    adminPermissions: 'admin_permissions',
    appSettings: 'app_settings',
    systemLogs: 'system_logs',
    sessions: 'session',
    subDomains: 'sub_domains',
    roleFamilies: 'role_families',
    skillRoleFamilies: 'skill_role_families',
};

const COLUMN_MAP = {
    siteId: 'site_id',
    departmentId: 'department_id',
    serviceId: 'service_id',
    countryId: 'country_id',
    regionId: 'region_id',
    roleId: 'role_id',
    skillId: 'skill_id',
    domainId: 'domain_id',
    employeeId: 'employee_id',
    adminId: 'admin_id',
    reviewerId: 'reviewer_id',
    reviewedBy: 'reviewed_by',
    reviewedAt: 'reviewed_at',
    createdBy: 'created_by',
    createdAt: 'created_at',
    updatedBy: 'updated_by',
    updatedAt: 'updated_at',
    approvedBy: 'approved_by',
    approvedAt: 'approved_at',
    completedAt: 'completed_at',
    submittedAt: 'submitted_at',
    workflowState: 'workflow_state',
    selfAssessmentId: 'self_assessment_id',
    employeeNumber: 'employee_number',
    firstName: 'first_name',
    lastName: 'last_name',
    supervisorId: 'supervisor_id',
    managerId: 'manager_id',
    managerType: 'manager_type',
    isOrgRoot: 'is_org_root',
    passwordHash: 'password_hash',
    passwordChangedAt: 'password_changed_at',
    forcePasswordChange: 'force_password_change',
    lockedUntil: 'locked_until',
    isActive: 'is_active',
    isAccountActive: 'is_account_active',
    isCritical: 'is_critical',
    isPublic: 'is_public',
    lastLoginAt: 'last_login_at',
    requiredLevel: 'required_level',
    currentLevel: 'current_level',
    previousLevel: 'previous_level',
    newLevel: 'new_level',
    targetLevel: 'target_level',
    selfRatedLevel: 'self_rated_level',
    supervisorRatedLevel: 'supervisor_rated_level',
    gapReason: 'gap_reason',
    supervisorNotes: 'supervisor_notes',
    completionNotes: 'completion_notes',
    estimatedHours: 'estimated_hours',
    resourceUrl: 'resource_url',
    trainingType: 'training_type',
    trainingMethod: 'training_method',
    startDate: 'start_date',
    endDate: 'end_date',
    scopeType: 'scope_type',
    entityType: 'entity_type',
    entityId: 'entity_id',
    ipAddress: 'ip_address',
    userAgent: 'user_agent',
    settingKey: 'setting_key',
    settingValue: 'setting_value',
    settingType: 'setting_type',
    reportType: 'report_type',
    // report_templates.creator_type — added with the ownership fix (a template is
    // owned by the PAIR (creator_type, created_by), since admin 7 and employee 7
    // are different people). `created_by` was mapped, its partner was not, so every
    // query naming it reached PostgreSQL as `creatortype` and raised 42703. That
    // took out the whole templates + schedules surface.
    creatorType: 'creator_type',
    dataSource: 'data_source',
    selectedFields: 'selected_fields',
    groupBy: 'group_by',
    snapshotData: 'snapshot_data',
    attemptedAt: 'attempted_at',
    assessedBy: 'assessed_by',
    assessedAt: 'assessed_at',
    changedAt: 'changed_at',
    // dashboard view columns (07_dashboard_views.sql)
    siteName: 'site_name',
    departmentName: 'department_name',
    serviceName: 'service_name',
    roleName: 'role_name',
    skillName: 'skill_name',
    domainName: 'domain_name',
    subDomainId: 'sub_domain_id',
    subDomainName: 'sub_domain_name',
    roleFamilyId: 'role_family_id',
    strategicLink: 'strategic_link',
    fullName: 'full_name',
    totalRequired: 'total_required',
    totalGapPoints: 'total_gap_points',
    totalCritical: 'total_critical',
    criticalMet: 'critical_met',
    pointsGained: 'points_gained',
    pointsRequired: 'points_required',
    isRoleReady: 'is_role_ready',
    isAssessed: 'is_assessed',
    isMet: 'is_met',
    actualLevel: 'actual_level',
    skillsMet: 'skills_met',
    avgReadiness: 'avg_readiness',
    employeeCount: 'employee_count',
    readyCount: 'ready_count',
    criticalCount: 'critical_count',
    avgRequired: 'avg_required',
    avgCurrent: 'avg_current',
    avgGap: 'avg_gap',
    affectedEmployees: 'affected_employees',
    gapSkillCount: 'gap_skill_count',
    criticalGapCount: 'critical_gap_count',
};

// Boolean columns: V1 SQL compares with 0/1, PG needs true/false.
const BOOLEAN_COLS = [
    'is_active',
    'is_critical',
    'is_account_active',
    'force_password_change',
    'is_public',
    'successful',
    // Newer boolean columns — keep in sync with BaseModel.BOOLEAN_COLUMNS.
    'is_org_root',
    'password_disabled',
    'is_primary',
    'mfa_enabled',
    'manual_override',
    'open_to_mobility',
];
function rewriteBooleanCompares(sql) {
    let out = sql;
    for (const c of BOOLEAN_COLS) {
        out = out.replace(new RegExp(`\\b${c}\\s*=\\s*1\\b`, 'g'), `${c} = true`);
        out = out.replace(new RegExp(`\\b${c}\\s*=\\s*0\\b`, 'g'), `${c} = false`);
        out = out.replace(new RegExp(`\\b${c}\\s*<>\\s*1\\b`, 'g'), `${c} <> true`);
        out = out.replace(new RegExp(`\\b${c}\\s*<>\\s*0\\b`, 'g'), `${c} <> false`);
        out = out.replace(new RegExp(`\\b${c}\\s*!=\\s*1\\b`, 'g'), `${c} <> true`);
        out = out.replace(new RegExp(`\\b${c}\\s*!=\\s*0\\b`, 'g'), `${c} <> false`);
    }
    return out;
}

// JSONB columns: coerce non-JSON parameter values to JSON-stringified form.
const JSONB_COLS = new Set([
    'details',
    'payload',
    'snapshot_data',
    'selected_fields',
    'filters',
    'sorting',
    'group_by',
]);
// Split a parenthesised, comma-separated SQL fragment into top-level items,
// respecting nested parens and single/double-quoted strings.
function splitTopLevel(s) {
    const out = [];
    let buf = '';
    let depth = 0;
    let inS = false;
    let inD = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (inS) {
            buf += ch;
            if (ch === "'") inS = false;
            continue;
        }
        if (inD) {
            buf += ch;
            if (ch === '"') inD = false;
            continue;
        }
        if (ch === "'") {
            inS = true;
            buf += ch;
            continue;
        }
        if (ch === '"') {
            inD = true;
            buf += ch;
            continue;
        }
        if (ch === '(') {
            depth++;
            buf += ch;
            continue;
        }
        if (ch === ')') {
            depth--;
            buf += ch;
            continue;
        }
        if (ch === ',' && depth === 0) {
            out.push(buf.trim());
            buf = '';
            continue;
        }
        buf += ch;
    }
    if (buf.trim() !== '') out.push(buf.trim());
    return out;
}

function coerceJsonbParams(translatedSql, params) {
    if (!params || params.length === 0) return params;
    // Match the column list AND the opening of the first VALUES tuple.
    const m = translatedSql.match(/INSERT\s+INTO\s+[\w."]+\s*\(([^)]+)\)\s*VALUES\s*\(/i);
    if (!m) return params;
    const cols = m[1].split(',').map((c) => c.trim().toLowerCase().replace(/"/g, ''));

    // Extract the first VALUES (...) tuple, respecting nesting/strings — so that
    // literals or function calls inside VALUES (e.g. now, 1, 'x') don't throw
    // off the param→column alignment.
    const start = m.index + m[0].length - 1; // index of the '(' after VALUES
    let depth = 0,
        inS = false,
        inD = false,
        end = -1;
    for (let i = start; i < translatedSql.length; i++) {
        const ch = translatedSql[i];
        if (inS) {
            if (ch === "'") inS = false;
            continue;
        }
        if (inD) {
            if (ch === '"') inD = false;
            continue;
        }
        if (ch === "'") {
            inS = true;
            continue;
        }
        if (ch === '"') {
            inD = true;
            continue;
        }
        if (ch === '(') depth++;
        else if (ch === ')') {
            depth--;
            if (depth === 0) {
                end = i;
                break;
            }
        }
    }
    if (end < 0) return params;
    const items = splitTopLevel(translatedSql.slice(start + 1, end));

    // Map each placeholder (in param order) to the column at its tuple position.
    const placeholderCol = [];
    for (let i = 0; i < items.length && i < cols.length; i++) {
        if (items[i] === '?' || /^\$\d+$/.test(items[i])) placeholderCol.push(cols[i]);
    }
    return params.map((v, i) => {
        const c = placeholderCol[i];
        if (!c || !JSONB_COLS.has(c)) return v;
        if (v === null || v === undefined) return v;
        if (typeof v === 'string') {
            try {
                JSON.parse(v);
                return v;
            } catch {
                /* not json */
            }
            // eslint-disable-next-line no-control-regex -- intentional: strip NUL bytes PG JSONB rejects
            return JSON.stringify(v.replace(/\x00/g, '').replace(/\\u0000/g, ''));
        }
        return JSON.stringify(v);
    });
}

// Build merged identifier rewrite list (longest-first).
const IDENT_PAIRS = [];
for (const [k, v] of Object.entries(TABLE_MAP)) IDENT_PAIRS.push([k, v]);
for (const [k, v] of Object.entries(COLUMN_MAP)) IDENT_PAIRS.push([k, v]);
IDENT_PAIRS.sort((a, b) => b[0].length - a[0].length);

// Rewrite SQLite-only functions to PG equivalents.
function rewriteSqliteFunctions(sql) {
    let out = sql;
    // strftime('%Y-%m', col) → to_char(col, 'YYYY-MM')
    out = out.replace(/strftime\s*\(\s*'%Y-%m'\s*,\s*([^)]+)\s*\)/gi, "to_char($1, 'YYYY-MM')");
    out = out.replace(
        /strftime\s*\(\s*'%Y-%m-%d'\s*,\s*([^)]+)\s*\)/gi,
        "to_char($1, 'YYYY-MM-DD')"
    );
    out = out.replace(/strftime\s*\(\s*'%Y'\s*,\s*([^)]+)\s*\)/gi, "to_char($1, 'YYYY')");
    // datetime('now', '-7 days') → now - interval '7 days'
    out = out.replace(
        /datetime\s*\(\s*'now'\s*,\s*'-(\d+)\s+(day|days|month|months|year|years)'\s*\)/gi,
        (_, n, unit) => `(now() - interval '${n} ${unit}')`
    );
    out = out.replace(/datetime\s*\(\s*'now'\s*\)/gi, 'now()');
    // group_concat(col) → string_agg(col::text, ',')
    out = out.replace(
        /group_concat\s*\(\s*([^,)]+?)\s*,\s*'([^']*)'\s*\)/gi,
        "string_agg($1::text, '$2')"
    );
    out = out.replace(
        /group_concat\s*\(\s*DISTINCT\s+([^,)]+?)\s*\)/gi,
        "string_agg(DISTINCT $1::text, ',')"
    );
    out = out.replace(/group_concat\s*\(\s*([^,)]+?)\s*\)/gi, "string_agg($1::text, ',')");
    // ifnull(a, b) → COALESCE(a, b) (ifnull is SQLite-only)
    out = out.replace(/\bifnull\s*\(/gi, 'COALESCE(');
    // SQLite's MIN(a,b) and MAX(a,b) as scalar pair → LEAST/GREATEST
    // (only matches the 2-arg form to avoid breaking aggregate MIN/MAX)
    out = out.replace(/\bMIN\s*\(\s*([^,()]+?)\s*,\s*([^,()]+?)\s*\)/gi, 'LEAST($1, $2)');
    out = out.replace(/\bMAX\s*\(\s*([^,()]+?)\s*,\s*([^,()]+?)\s*\)/gi, 'GREATEST($1, $2)');
    // date('now', '-N day') → (now - interval 'N day')::date
    out = out.replace(
        /date\s*\(\s*'now'\s*,\s*'-(\d+)\s+(day|days|month|months|year|years)'\s*\)/gi,
        (_, n, unit) => `(now() - interval '${n} ${unit}')::date`
    );
    out = out.replace(/date\s*\(\s*'now'\s*\)/gi, '(now())::date');
    // julianday('now') - julianday(col) → days difference
    out = out.replace(
        /julianday\s*\(\s*'now'\s*\)\s*-\s*julianday\s*\(\s*([^)]+?)\s*\)/gi,
        'EXTRACT(epoch FROM (now() - $1::timestamp)) / 86400'
    );
    out = out.replace(
        /julianday\s*\(\s*([^)]+?)\s*\)\s*-\s*julianday\s*\(\s*([^)]+?)\s*\)/gi,
        'EXTRACT(epoch FROM ($1::timestamp - $2::timestamp)) / 86400'
    );
    out = out.replace(/julianday\s*\(\s*'now'\s*\)/gi, 'EXTRACT(epoch FROM now()) / 86400');
    out = out.replace(
        /julianday\s*\(\s*([^)]+?)\s*\)/gi,
        'EXTRACT(epoch FROM ($1)::timestamp) / 86400'
    );
    // MAX(bool_col) / MIN(bool_col) / SUM(bool_col) → cast to int
    // PG won't run these aggregates on booleans, but they're common in V1 SQL.
    for (const col of BOOLEAN_COLS) {
        out = out.replace(
            new RegExp(`(MAX|MIN|SUM|AVG)\\s*\\(\\s*${col}\\s*\\)`, 'gi'),
            (_, fn) => `${fn}(${col}::int)`
        );
        out = out.replace(
            new RegExp(`(MAX|MIN|SUM|AVG)\\s*\\(\\s*(\\w+\\.)${col}\\s*\\)`, 'gi'),
            (_, fn, prefix) => `${fn}(${prefix}${col}::int)`
        );
    }
    return out;
}

// HAVING <alias> in PG is illegal — wrap the SELECT in a subquery and
// move the HAVING to an outer WHERE.  Only handles simple single-alias
// patterns:  HAVING <ident> <op> <literal>  (followed by optional
// ORDER BY / LIMIT).
// PG strict-mode GROUP BY: every non-aggregated SELECT column must be listed.
// V1 SQLite is permissive. Extend `GROUP BY x` to include all non-aggregate
// columns of the SELECT list. Restricted to simple SELECTs without
// CTEs/UNIONs to keep the transformer safe.
function expandGroupBy(sql) {
    if (!/\bGROUP\s+BY\b/i.test(sql)) return sql;
    if (/\bUNION\b/i.test(sql) || /\bWITH\b/i.test(sql)) return sql;
    // Find SELECT ... FROM
    const selFromRe = /SELECT\s+([\s\S]+?)\s+FROM\b/i;
    const sm = sql.match(selFromRe);
    if (!sm) return sql;
    const selectList = sm[1];
    // Find GROUP BY <list> up to next clause keyword
    const gbRe = /\bGROUP\s+BY\s+([\s\S]+?)(\s+(?:HAVING|ORDER|LIMIT|OFFSET)\b|$)/i;
    const gm = sql.match(gbRe);
    if (!gm) return sql;
    const existingGroup = gm[1].split(',').map((s) => s.trim());

    // Split SELECT items by commas at top-level paren depth 0.
    const items = [];
    let depth = 0,
        cur = '';
    for (const ch of selectList) {
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        if (ch === ',' && depth === 0) {
            items.push(cur);
            cur = '';
        } else cur += ch;
    }
    if (cur) items.push(cur);

    const aggRe = /\b(COUNT|SUM|AVG|MIN|MAX|STRING_AGG|ARRAY_AGG|BOOL_OR|BOOL_AND)\s*\(/i;
    const toAdd = [];
    for (const it of items) {
        const trimmed = it.trim();
        if (!trimmed || trimmed === '*') continue;
        if (aggRe.test(trimmed)) continue;
        // Extract the bare expression (strip "AS alias")
        const expr = trimmed
            .replace(/\s+AS\s+\w+\s*$/i, '')
            .replace(/\s+\w+\s*$/, (m) =>
                // Heuristic: only strip trailing word if the expression is just "ident.ident"
                /[A-Za-z0-9_.]+/.test(trimmed.split(/\s+/)[0]) ? '' : m
            )
            .trim();
        // Use the part before any AS/alias — safer
        const bareExpr = trimmed.split(/\s+AS\s+/i)[0].trim();
        if (existingGroup.includes(bareExpr)) continue;
        if (
            existingGroup.some((g) => g === bareExpr || g.endsWith('.' + bareExpr.split('.').pop()))
        )
            continue;
        toAdd.push(bareExpr);
    }
    if (toAdd.length === 0) return sql;
    const newGroup = existingGroup.concat(toAdd).join(', ');
    return sql.replace(gbRe, (full, _, rest) => ` GROUP BY ${newGroup}${rest}`);
}

function rewriteHavingAliases(sql) {
    // Find SELECT ... GROUP BY ... HAVING <ident> <op> <expr> [ORDER BY ...] [LIMIT ...]
    // and wrap the inner part. We restrict to whole statements that fit the
    // shape, to avoid breaking nested/complex SQL.
    const re =
        /^(\s*SELECT\s+[\s\S]+?GROUP\s+BY\s+[^()]+?)\s+HAVING\s+([A-Za-z_][A-Za-z_0-9]*)\s*(>=|<=|<>|!=|=|>|<)\s*(\d+(?:\.\d+)?)(\s+ORDER\s+BY[\s\S]+?)?(\s+LIMIT\s+\d+\s*(?:OFFSET\s+\d+)?\s*)?\s*$/i;
    const m = sql.match(re);
    if (!m) return sql;
    const [, body, alias, op, val, orderBy, limit] = m;
    // PG unquoted identifiers are case-folded to lowercase, so the alias in the
    // outer WHERE must match that folded form — not the snake_case form.
    const outerAlias = alias.toLowerCase();
    return `SELECT * FROM (${body}) _sub WHERE _sub.${outerAlias} ${op} ${val}${orderBy || ''}${limit || ''}`;
}

function rewriteIdentifiers(sql) {
    let out = '';
    let inSingle = false;
    let inDouble = false;
    let inLineComment = false; // -- ...
    let inBlockComment = false; // /* ... */
    let i = 0;
    while (i < sql.length) {
        const c = sql[i];
        // Exit line comment on newline
        if (inLineComment) {
            out += c;
            if (c === '\n' || c === '\r') inLineComment = false;
            i++;
            continue;
        }
        // Exit block comment on */
        if (inBlockComment) {
            out += c;
            if (c === '*' && sql[i + 1] === '/') {
                out += '/';
                inBlockComment = false;
                i += 2;
                continue;
            }
            i++;
            continue;
        }
        // Enter line comment
        if (!inSingle && !inDouble && c === '-' && sql[i + 1] === '-') {
            out += '--';
            inLineComment = true;
            i += 2;
            continue;
        }
        // Enter block comment
        if (!inSingle && !inDouble && c === '/' && sql[i + 1] === '*') {
            out += '/*';
            inBlockComment = true;
            i += 2;
            continue;
        }
        if (c === "'" && !inDouble) {
            inSingle = !inSingle || sql[i - 1] === '\\';
            out += c;
            i++;
            continue;
        }
        if (c === '"' && !inSingle) {
            inDouble = !inDouble;
            out += c;
            i++;
            continue;
        }
        if (inSingle || inDouble) {
            out += c;
            i++;
            continue;
        }
        let matched = false;
        for (const [from, to] of IDENT_PAIRS) {
            if (sql.startsWith(from, i)) {
                const before = i === 0 ? '' : sql[i - 1];
                const after = sql[i + from.length] || '';
                const isWord = (ch) => /[A-Za-z0-9_]/.test(ch);
                if (!isWord(before) && !isWord(after)) {
                    out += to;
                    i += from.length;
                    matched = true;
                    break;
                }
            }
        }
        if (!matched) {
            out += c;
            i++;
        }
    }
    return out;
}

// Inverse map for result-key rewriting.
const REVERSE = {};
for (const [k, v] of Object.entries(COLUMN_MAP)) REVERSE[v] = k;

function rewriteRowKeys(row) {
    if (!row || typeof row !== 'object') return row;
    const out = {};
    for (const k of Object.keys(row)) {
        // Prefer explicit reverse mapping; fall back to snakeToCamel for anything
        // we didn't list (e.g. new V2-only columns).
        let target = REVERSE[k];
        if (!target) {
            // Do NOT fold a LEADING underscore: aliases like `_total` must survive
            // intact (folding `_total`→`Total` is the v3.18.4 pager-NaN root cause).
            target = k.replace(/(?<!^)_([a-z0-9])/g, (_, c) => c.toUpperCase());
        }
        out[target] = row[k];
    }
    return out;
}

// Memoized SQL translations (raw SQL string -> Postgres-ready string). Module-
// scoped so it is shared across the singleton DB instance for the process life.
const _translateCache = new Map();

class PostgresDatabase {
    constructor(connectionString) {
        if (!Pool) {
            throw new Error("PostgresDatabase requires the 'pg' module. Run `npm install pg`.");
        }
        this.connectionString = connectionString || process.env.DATABASE_URL;
        if (!this.connectionString) {
            throw new Error('DATABASE_URL is required for PostgresDatabase.');
        }
        this.pool = null;
        // Per-async-context transaction client. Using AsyncLocalStorage (instead
        // of a single shared field) makes transactions concurrency-safe: two
        // simultaneous requests never clobber each other's tx client.
        this._txStore = new AsyncLocalStorage();
        // Per-request correlation context (request id), so DB-layer perf/error events
        // can be stitched to the HTTP request that triggered them without threading
        // an id through every model call. Set by the requestId middleware.
        this._reqStore = new AsyncLocalStorage();
    }

    // Run `fn` (typically the rest of the request) within a correlation context.
    runWithRequest(ctx, fn) {
        return this._reqStore.run(ctx || {}, fn);
    }
    _reqId() {
        const c = this._reqStore.getStore();
        return c && c.requestId ? c.requestId : null;
    }

    // Best-effort DB-layer telemetry: log slow queries and error codes to perf_events.
    // Fully guarded — never throws, never awaited on the hot path, and never records
    // events for the telemetry tables themselves (would recurse).
    _observe(sql, startedAt, err) {
        try {
            const ms = Date.now() - startedAt;
            const slow = ms >= Number(process.env.SLOW_QUERY_MS || 400);
            const code = err && err.code;
            const interesting =
                code && ['40P01', '40001', '23503', '23505', '57014'].includes(code);
            if (!slow && !interesting) return;
            const s = String(sql || '');
            if (/perf_events|system_logs/i.test(s)) return; // avoid recursion / noise
            const kind = err ? 'db_error' : 'slow_query';
            const PerfEventService = require('../services/PerfEventService');
            PerfEventService.record({
                requestId: this._reqId(),
                kind,
                latencyMs: ms,
                pgCode: code || null,
                sqlSnippet: s.replace(/\s+/g, ' ').trim().slice(0, 240),
            });
        } catch (_) {
            /* telemetry must never affect the query path */
        }
    }

    async connect() {
        this.pool = new Pool({
            connectionString: this.connectionString,
            // Sized for the dashboard's per-request query fan-out under concurrency.
            // Capacity-plan against PostgreSQL max_connections ÷ app-instance count
            // (consider PgBouncer in transaction mode when scaling out instances —
            // see docs/Scaling-to-4000-Users.md).
            max: Number(process.env.PG_POOL_MAX || 25),
            // Keep a warm floor of connections so a burst after idle doesn't pay full
            // connect latency for the first N requests.
            min: Number(process.env.PG_POOL_MIN || 2),
            idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30_000),
            // Recycle a connection after N uses so a long-lived backend can't accrue
            // planner/memory bloat over a multi-week uptime.
            maxUses: Number(process.env.PG_MAX_USES || 7500),
            // TCP keep-alive so a dropped connection (NAT/firewall idle-reap) is
            // detected instead of handed to a query that then hangs.
            keepAlive: true,
            // Don't let a slow/hung query pin a connection indefinitely.
            connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 10_000),
            statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS || 30_000),
            query_timeout: Number(process.env.PG_QUERY_TIMEOUT_MS || 30_000),
        });
        this.pool.on('error', (e) => console.error('[pg pool] idle client error:', e && e.message));
        const client = await this.pool.connect();
        try {
            await client.query('SELECT 1');
        } finally {
            client.release();
        }
    }

    _client() {
        return this._txStore.getStore() || this.pool;
    }

    /**
     * True when the caller already runs inside runTransaction. Nested
     * runTransaction calls reuse the client WITHOUT a savepoint, so a batch
     * loop that means to skip one bad record and carry on has to know whether it
     * must guard that record with a SAVEPOINT (nested) or whether a failed
     * statement rolls back on its own (top level).
     */
    inTransaction() {
        return Boolean(this._txStore.getStore());
    }

    _translate(sql) {
        // The translation is a pure, deterministic function of the SQL string,
        // and the model layer issues a small, fixed set of query templates that
        // run thousands of times — so memoize the result. This eliminates the
        // 7-pass character-by-character rewrite on every run/get/all call (the
        // dominant per-query CPU cost on this small-data deployment).
        const cached = _translateCache.get(sql);
        if (cached !== undefined) return cached;

        // 1) rewrite identifiers → snake_case
        // 2) rewrite SQLite-only functions to PG equivalents
        // 3) rewrite HAVING <alias> to subquery+WHERE
        // 4) expand GROUP BY for PG strict mode
        // 5) rewrite boolean-column compares (= 0/1 → true/false)
        // 6) wrap camelCase aliases in double quotes so PG preserves case
        // 7) ? → $N
        let s = rewriteIdentifiers(sql);
        s = rewriteSqliteFunctions(s);
        s = rewriteHavingAliases(s);
        s = expandGroupBy(s);
        s = rewriteBooleanCompares(s);
        s = quoteCamelAliases(s);
        const out = translatePlaceholders(s);

        // Bound the cache: dynamic IN-lists produce distinct strings, so cap it
        // and drop everything if it grows large (templates re-warm instantly).
        if (_translateCache.size >= 5000) _translateCache.clear();
        _translateCache.set(sql, out);
        return out;
    }

    _isInsertWithoutReturning(sql) {
        const t = sql.trim().toUpperCase();
        return t.startsWith('INSERT ') && !/\bRETURNING\b/i.test(sql);
    }

    async run(sql, params = []) {
        let q = this._translate(sql);
        // RETURNING * works on every table — junction tables (no id) don't
        // break, lastID falls through to undefined when there is no id col.
        if (this._isInsertWithoutReturning(q)) q += ' RETURNING *';
        const finalParams = coerceJsonbParams(q, params);
        const startedAt = Date.now();
        try {
            const res = await this._client().query(q, finalParams);
            this._observe(q, startedAt, null);
            const lastID =
                res.rows && res.rows.length && res.rows[0].id !== undefined
                    ? Number(res.rows[0].id)
                    : undefined;
            return { lastID, changes: res.rowCount };
        } catch (e) {
            this._observe(q, startedAt, e);
            throw e;
        }
    }

    async get(sql, params = []) {
        const q = this._translate(sql);
        if (process.env.SQL_DEBUG === '1') console.log('[SQL get]', q.slice(0, 800));
        const startedAt = Date.now();
        try {
            const res = await this._client().query(q, params);
            this._observe(q, startedAt, null);
            return rewriteRowKeys(res.rows[0]);
        } catch (e) {
            this._observe(q, startedAt, e);
            if (process.env.SQL_DEBUG === '1') console.log('[SQL get FAIL]', q);
            throw e;
        }
    }

    async all(sql, params = []) {
        const q = this._translate(sql);
        const startedAt = Date.now();
        try {
            const res = await this._client().query(q, params);
            this._observe(q, startedAt, null);
            return res.rows.map(rewriteRowKeys);
        } catch (e) {
            this._observe(q, startedAt, e);
            throw e;
        }
    }

    /**
     * Run `fn` inside a SAVEPOINT, so a failure it raises cannot poison the
     * surrounding transaction.
     *
     * PostgreSQL aborts the WHOLE transaction on any statement error: every later
     * statement returns "current transaction is aborted", and the eventual COMMIT
     * silently performs a ROLLBACK — without raising. So a `try { … } catch {}`
     * around a best-effort side-effect inside a transaction does not contain the
     * damage; it hides it. Verified by execution: a swallowed bad statement inside
     * `runTransaction` returned normally and committed NOTHING, so an approval
     * answered 200 "approved" while the status change, the audit event, the PIP,
     * the coaching plan and the placement mirror were all discarded.
     *
     * Wrap any deliberately-swallowed block in this. Outside a transaction it is a
     * pass-through, so callers do not need to know which they are in.
     *
     * The savepoint name is generated here and never interpolated from input.
     */
    async runInSavepoint(fn) {
        const client = this._txStore.getStore();
        if (!client) return fn(); // no open transaction — nothing to protect
        this._savepointSeq = (this._savepointSeq || 0) + 1;
        const sp = `sp_${this._savepointSeq}`;
        await client.query(`SAVEPOINT ${sp}`);
        try {
            const result = await fn();
            await client.query(`RELEASE SAVEPOINT ${sp}`);
            return result;
        } catch (err) {
            // Restore the transaction to a usable state, then let the caller decide
            // whether to swallow. Without this the caller's catch is meaningless.
            try {
                await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
                await client.query(`RELEASE SAVEPOINT ${sp}`);
            } catch {
                /* the transaction is already unusable; the outer catch reports */
            }
            throw err;
        }
    }

    async runTransaction(fn, opts = {}) {
        // Nested call within an existing transaction → reuse the same client.
        if (this._txStore.getStore()) return fn();
        const client = await this.pool.connect();
        try {
            return await this._txStore.run(client, async () => {
                await client.query('BEGIN');
                try {
                    // Transaction-LOCAL actor tag, read by the employee-movement
                    // trigger. Local (third arg true) is essential: the pooled
                    // connection is reused, and a session-wide setting would
                    // mis-attribute a later request's movements to this actor.
                    if (opts.actorRef) {
                        await client.query("SELECT set_config('app.actor_ref', $1, true)", [
                            String(opts.actorRef),
                        ]);
                    }
                    const result = await fn();
                    await client.query('COMMIT');
                    return result;
                } catch (err) {
                    try {
                        await client.query('ROLLBACK');
                    } catch {
                        /* ignore */
                    }
                    throw err;
                }
            });
        } finally {
            client.release();
        }
    }

    /**
     * Run `fn` in a transaction tagged with who is responsible, so anything the
     * employee-movement trigger records during it carries a real actor instead
     * of falling back to "system".
     *   await db.withActor(req,  => EmployeeModel.update(id, patch));
     * `who` may be a request (req.user is read) or a ready-made 'type:id' string.
     */
    async withActor(who, fn) {
        let ref = null;
        if (typeof who === 'string') ref = who;
        else if (who && who.user) ref = `${who.user.userType || 'admin'}:${who.user.id}`;
        else if (who && who.id) ref = `${who.userType || 'admin'}:${who.id}`;
        return this.runTransaction(fn, { actorRef: ref });
    }

    /**
     * Apply the schema + pending migrations, SERIALISED across processes
     * (3.23.17, CQ-14): a PostgreSQL session advisory lock is taken on a
     * DEDICATED connection for the whole run, so two processes booting at once
     * (service restart racing a manual `npm run db:migrate:all`, the installer's
     * pre-flight and the service) never apply the same file concurrently. The
     * second one waits, then re-reads schema_meta and finds nothing pending.
     * Released in `finally`; if the unlock itself fails the connection is
     * destroyed, which releases a session lock server-side.
     * A lock that cannot be TAKEN (e.g. a pool of size 1, where holding it would
     * starve the migration connection) degrades to the historic unlocked run
     * with a warning — it guards a race, it must not block a boot.
     */
    async migrate(opts = {}) {
        // Fixed arbitrary bigint key — NEVER change it: every process of every
        // version must contend on the same lock.
        const MIGRATION_LOCK_KEY = '4777080773718782';
        const max = this.pool && this.pool.options && Number(this.pool.options.max);
        if (max && max < 2) {
            console.warn(
                '⚠️  migrate(): PG pool max < 2 — running WITHOUT the migration advisory lock.'
            );
            return this._migrateUnlocked(opts);
        }
        const lockClient = await this.pool.connect();
        let locked = false;
        let destroy = false;
        try {
            try {
                await lockClient.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
                locked = true;
            } catch (e) {
                console.warn(
                    `⚠️  migrate(): advisory lock not taken (${e.message}) — running unlocked.`
                );
            }
            return await this._migrateUnlocked(opts);
        } finally {
            if (locked) {
                try {
                    await lockClient.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
                } catch {
                    destroy = true;
                }
            }
            lockClient.release(destroy || undefined);
        }
    }

    async _migrateUnlocked({ dir: dirOverride } = {}) {
        const dir = dirOverride || path.resolve(__dirname, '..', '..', 'db', 'postgres');
        const schemaPath = path.join(dir, '01_schema.sql');
        if (!fs.existsSync(schemaPath)) {
            throw new Error(`Postgres schema file not found: ${schemaPath}`);
        }
        // 1) Base schema (if not yet applied).
        let hasVersion = false;
        try {
            const r = await this.get(`SELECT value FROM schema_meta WHERE key='schema_version'`);
            hasVersion = Boolean(r && r.value);
        } catch {
            /* first install — schema_meta doesn't exist yet */
        }
        if (!hasVersion) {
            await this._client().query(fs.readFileSync(schemaPath, 'utf8'));
            console.log('✓ Postgres base schema applied (01_schema.sql)');
        } else {
            console.log('✓ Postgres base schema already present');
        }

        // 2) Apply every pending NN_*.sql in order (idempotent, tracked in
        //    schema_meta). Tolerates already-present objects so it is safe on
        //    both fresh and existing databases. Raw query — no SQL-compat
        //    translation (these files are native PG DDL).
        // "Object already exists" codes → safe to treat a migration as pre-existing.
        // NOTE: 23505 (unique_violation) is deliberately EXCLUDED — that's a DATA error
        // (e.g. CREATE UNIQUE INDEX on rows that already violate it), not an idempotent
        // object-exists case. Swallowing it would silently skip a uniqueness guard that
        // never lands; let it fail loudly so the operator cleans the data first.
        const DUP_CODES = new Set(['42P07', '42710', '42P06', '42701', '42723', '42P16']);
        const applied = new Set(
            (await this._client().query('SELECT key FROM schema_meta')).rows.map((r) => r.key)
        );
        const files = fs
            .readdirSync(dir)
            .filter(
                (f) => /^\d+.*\.sql$/.test(f) && !/_down\.sql$/i.test(f) && f !== '01_schema.sql'
            )
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

        let count = 0;
        for (const file of files) {
            const key = file.replace(/\.sql$/i, '');
            if (applied.has(key)) continue;
            // Run each migration on ONE dedicated connection so BEGIN/COMMIT/ROLLBACK
            // actually wrap the file. this._client returns the pool outside an ALS
            // tx, where each query may land on a different pooled connection — which
            // makes the explicit BEGIN/ROLLBACK wrap nothing (a half-applied, erroring
            // migration would not roll back and would silently re-run next boot).
            const client = await this.pool.connect();
            try {
                await client.query('BEGIN');
                await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
                await client.query(
                    "INSERT INTO schema_meta(key, value, applied_at) VALUES ($1, 'applied', now()) ON CONFLICT (key) DO NOTHING",
                    [key]
                );
                await client.query('COMMIT');
                count++;
                console.log(`  ✓ migration ${file}`);
            } catch (e) {
                await client.query('ROLLBACK').catch(() => {});
                if (
                    this._migrationVerdict(e, fs.readFileSync(path.join(dir, file), 'utf8')) ===
                    'pre-existing'
                ) {
                    await client
                        .query(
                            "INSERT INTO schema_meta(key, value, applied_at) VALUES ($1, 'pre-existing', now()) ON CONFLICT (key) DO NOTHING",
                            [key]
                        )
                        .catch(() => {});
                    console.log(`  • migration ${file} already present (${e.code})`);
                } else {
                    if (DUP_CODES.has(e.code)) {
                        e.message =
                            `migration ${file}: statement raised ${e.code} (${e.message}) but the file holds ` +
                            'several statements — the whole file was rolled back and is NOT recorded. ' +
                            'A multi-statement file cannot be "already present"; fix the file (IF NOT EXISTS) or the base, then retry.';
                    }
                    throw e;
                }
            } finally {
                client.release();
            }
        }
        if (count) console.log(`✓ Applied ${count} pending migration(s)`);
        // Post-verification: never serve over a half-applied migration.
        await this.verifyMigrations(dir, files);
    }

    /**
     * Is a rolled-back migration honestly "already present"? Only when the file
     * is ONE statement and that statement hit an object-exists code. A file of
     * several statements that dies on its first is HALF-APPLIED: the rest never
     * ran, and stamping it 'pre-existing' would hide that forever. Measured by
     * replaying the runner's catch on a two-statement file whose first statement
     * raised 42701: verdict 'pre-existing', second statement absent — the shape
     * of the appliance failure of 2026-09-09.
     * @returns {'pre-existing'|'rethrow'}
     */
    _migrationVerdict(err, sql) {
        const DUP_CODES = new Set(['42P07', '42710', '42P06', '42701', '42723', '42P16']);
        if (!err || !DUP_CODES.has(err.code)) return 'rethrow';
        const { statementCount } = require('../../scripts/migrate-preflight');
        return statementCount(sql) === 1 ? 'pre-existing' : 'rethrow';
    }

    /**
     * Post-flight, run at the end of every migrate — so the server boot path
     * gets the same check the installer runs: a shipped file recorded as
     * 'pre-existing' while holding several statements is half-applied, and the
     * process refuses to serve on top of it. The plan is asked with the values
     * AND the file contents, so the answer is a measurement, never a zero.
     */
    async verifyMigrations(dir, files) {
        const { plan, ROLLED_BACK_VALUE } = require('../../scripts/migrate-preflight');
        const metaRows = (await this._client().query('SELECT key, value FROM schema_meta')).rows;
        const p = plan(files, metaRows, (f) => fs.readFileSync(path.join(dir, f), 'utf8'));
        if (!p.measured.values || !p.measured.contents) {
            throw new Error(
                'Migration post-check NOT made: schema_meta values or migration files unreadable.'
            );
        }
        if (p.halfApplied.length) {
            throw new Error(
                `Refusing to start: migration(s) recorded '${ROLLED_BACK_VALUE}' but only partly applied — ` +
                    p.halfApplied.join(', ') +
                    `. Fix the cause, delete the '${ROLLED_BACK_VALUE}' row(s) from schema_meta and run npm run db:migrate:all.`
            );
        }
        return p;
    }

    async seed() {
        const bcrypt = require('bcrypt');
        const { seedAdminPassword } = require('../utils/bootstrapAdmin');
        const existing = await this.get('SELECT id FROM admins WHERE username = ?', ['admin']);
        if (!existing) {
            // SECURITY — the bootstrap password is generated per install, never a
            // constant. It used to be the literal 'admin123', which meant every
            // deployment of this product shipped the SAME guessable superadmin
            // credential. force_password_change stops that default PERSISTING, but
            // it cannot stop an attacker being the one who performs the change:
            // anyone who reached the port before the operator's first login owned
            // superadmin. The installer already overwrote it on fresh installs
            // (scripts/set-admin-password.js), but a manual deploy did not, and
            // neither did the window before that step ran.
            //
            // BOOTSTRAP_ADMIN_PASSWORD lets automation pin it; otherwise it is
            // random and printed ONCE below for the operator to copy from the
            // install log. Either way the account still must rotate at first login.
            const { password, generated } = seedAdminPassword();
            const hash = await bcrypt.hash(password, 12);
            await this.run(
                `INSERT INTO admins (username, email, password_hash, role, is_active, force_password_change)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                ['admin', 'admin@localhost', hash, 'superadmin', true, true]
            );
            if (generated) {
                console.log('');
                console.log('  ============================================================');
                console.log('   FIRST-RUN SUPERADMIN — copy this now, it is shown ONCE');
                console.log('     username : admin');
                console.log(`     password : ${password}`);
                console.log('   A password change is required at first sign-in.');
                console.log('  ============================================================');
                console.log('');
            } else {
                console.log(
                    '✓ Default SuperAdmin created from BOOTSTRAP_ADMIN_PASSWORD (change required at first login)'
                );
            }
        } else {
            console.log('✓ Default SuperAdmin already exists');
        }
    }

    async close() {
        if (this.pool) {
            await this.pool.end();
            this.pool = null;
        }
    }
}

module.exports = PostgresDatabase;
module.exports.rewriteIdentifiers = rewriteIdentifiers;
module.exports.rewriteRowKeys = rewriteRowKeys;
