const BaseModel = require('./BaseModel');
const db = require('../config/database');

class SystemLogModel extends BaseModel {
    constructor() {
        super('systemLogs');
    }

    async findRecent(limit = 100, offset = 0) {
        return await db.all(
            `
            SELECT sl.*, a.username
            FROM systemLogs sl
            LEFT JOIN admins a ON sl.adminId = a.id
            ORDER BY sl.createdAt DESC
            LIMIT ? OFFSET ?
        `,
            [limit, offset]
        );
    }

    async countAll() {
        const result = await db.get('SELECT COUNT(*) as count FROM systemLogs');
        return result ? result.count : 0;
    }

    /**
     * Canonical entity_type → every spelling found in the table.
     * entity_type sits inside the tamper-evidence hash, so the legacy spellings
     * were NOT rewritten by migration 112; a filter on the canonical name has
     * to match them. LogService writes the canonical form for new rows.
     */
    get ENTITY_SYNONYMS() {
        return {
            employee: ['employee', 'employees'],
            self_assessment: [
                'self_assessment',
                'selfAssessment',
                'self_assessments',
                'assessments',
            ],
            skill_assessment: ['skill_assessment', 'skillAssessment', 'skillAssessments'],
            nine_box: ['nine_box', 'nineBox', 'nine_box_evaluations'],
            admin: ['admin', 'admins', 'localAdmins'],
            cycle: ['cycle', 'assessment_cycles', 'assessmentCycle', 'cycles'],
            idp: ['idp', 'idp_plans', 'idpPlan'],
            pip: ['pip', 'pips'],
            coaching_plan: ['coaching_plan', 'coachingPlan', 'coaching_plans', 'coaching'],
            app_setting: ['app_setting', 'appSetting', 'appSettings', 'setting'],
            supervisor_review: ['supervisor_review', 'supervisorReview', 'supervisor_reviews'],
            api_key: ['api_key', 'apiKey', 'api_keys'],
            role: ['role', 'roles'],
            site: ['site', 'sites'],
            department: ['department', 'departments'],
            service: ['service', 'services'],
            skill: ['skill', 'skills'],
            domain: ['domain', 'domains'],
        };
    }

    /** Every spelling that means `type` (the canonical one included). */
    entityTypeVariants(type) {
        const t = String(type || '').trim();
        if (!t) return [];
        const syn = this.ENTITY_SYNONYMS;
        if (syn[t]) return syn[t];
        for (const list of Object.values(syn)) if (list.includes(t)) return list;
        return [t];
    }

    /**
     * The `status` filter accepts a code (403), a class (4xx / 5xx) or a range
     * (400-499). Returns null for anything else — the controller turns that into
     * an inline message, never a 500 or a bounce.
     */
    parseStatus(raw) {
        const s = String(raw == null ? '' : raw)
            .trim()
            .toLowerCase();
        if (!s) return null;
        let m = /^([1-5])xx$/.exec(s);
        if (m) return { min: Number(m[1]) * 100, max: Number(m[1]) * 100 + 99 };
        m = /^(\d{3})\s*-\s*(\d{3})$/.exec(s);
        if (m && Number(m[1]) >= 100 && Number(m[2]) <= 599 && Number(m[1]) <= Number(m[2]))
            return { min: Number(m[1]), max: Number(m[2]) };
        m = /^(\d{3})$/.exec(s);
        if (m && Number(m[1]) >= 100 && Number(m[1]) <= 599)
            return { min: Number(m[1]), max: Number(m[1]) };
        return null;
    }

    // Build a WHERE clause + params from optional filters. Native snake_case; `?`→$n.
    // Every value has been validated by the controller (SystemLogController.parseFilters)
    // before it gets here, so a bad input can never reach the database as a cast error.
    _filterClause(f = {}) {
        const where = [];
        const params = [];
        if (f.status) {
            const st = typeof f.status === 'object' ? f.status : this.parseStatus(f.status);
            if (st) {
                where.push('sl.status_code BETWEEN ? AND ?');
                params.push(st.min, st.max);
            }
        }
        if (f.severity) {
            where.push('sl.severity = ?');
            params.push(f.severity);
        }
        if (f.category) {
            where.push('sl.category = ?');
            params.push(f.category);
        }
        const { ilike } = require('../utils/searchSql');
        if (f.route) {
            where.push('sl.route ILIKE ?');
            params.push('%' + f.route + '%');
        }
        // The action select carries an exact value; a typed fragment still works.
        if (f.action) {
            where.push('sl.action ILIKE ?');
            params.push(/[%_]/.test(f.action) ? f.action : '%' + f.action + '%');
        }
        if (f.requestId) {
            where.push('sl.request_id = ?');
            params.push(f.requestId);
        }
        if (f.actor) {
            where.push(`(${ilike('a.username')} OR ${ilike('sl.actor_ref')})`);
            params.push('%' + f.actor + '%', '%' + f.actor + '%');
        }
        // Entity filter: canonical name matches every legacy spelling.
        if (f.entityType) {
            const variants = this.entityTypeVariants(f.entityType);
            where.push(`sl.entity_type IN (${variants.map(() => '?').join(',')})`);
            params.push(...variants);
        }
        if (f.entityId != null && f.entityId !== '') {
            where.push('sl.entity_id = ?');
            params.push(Number(f.entityId));
        }
        // "Everything about one person": rows where they ACTED (any user type)
        // or where they are the ENTITY. This is the /employees/:id Journal query.
        if (f.employeeId != null && f.employeeId !== '') {
            const id = Number(f.employeeId);
            const emp = this.entityTypeVariants('employee');
            where.push(
                `(sl.actor_ref = ANY(?) OR (sl.entity_type IN (${emp.map(() => '?').join(',')}) AND sl.entity_id = ?))`
            );
            params.push([`employee:${id}`, `manager:${id}`, `supervisor:${id}`], ...emp, id);
        }
        if (f.from) {
            where.push('sl.created_at >= ?::timestamptz');
            params.push(f.from);
        }
        // A bare YYYY-MM-DD "to" means "through that whole day", not midnight.
        if (f.to) {
            if (/^\d{4}-\d{2}-\d{2}$/.test(f.to)) {
                where.push("sl.created_at < (?::date + INTERVAL '1 day')");
                params.push(f.to);
            } else {
                where.push('sl.created_at <= ?::timestamptz');
                params.push(f.to);
            }
        }
        // The request trail (HTTP_POST rows) is 1/3 of the table; hide it to read intent.
        if (f.excludeHttp) where.push("sl.action NOT LIKE 'HTTP\\_%'");
        if (f.errorsOnly)
            where.push("(sl.status_code >= 400 OR sl.severity IN ('error','critical','warn'))");
        return { clause: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
    }

    /** DISTINCT category / action values, for the filter selects (scoped like the list). */
    async facets(scope = null) {
        const sc = this._scopeCond(scope);
        const where = sc ? `WHERE ${sc.cond}` : '';
        const p = sc ? sc.params : [];
        const [categories, actions] = await Promise.all([
            db.all(
                `SELECT category AS v, COUNT(*)::int AS n FROM system_logs ${where ? where + ' AND' : 'WHERE'} category IS NOT NULL GROUP BY 1 ORDER BY 1`,
                p
            ),
            db.all(
                `SELECT action AS v, COUNT(*)::int AS n FROM system_logs ${where ? where + ' AND' : 'WHERE'} action IS NOT NULL GROUP BY 1 ORDER BY 1`,
                p
            ),
        ]);
        return { categories, actions };
    }

    /**
     * Walk EVERY filtered row in pages. `onPage(rows)` is
     * awaited per page so the caller can stream; keyset paging on id keeps it
     * O(1) per page whatever the offset. Returns the row count.
     */
    async eachFilteredPage(f = {}, scope = null, onPage, pageSize = 1000) {
        const { clause, params } = this._filterClause(f);
        const sc = this._scopeCond(scope);
        let where = clause;
        const all = [...params];
        if (sc) {
            where = where ? `${where} AND ${sc.cond}` : `WHERE ${sc.cond}`;
            all.push(...sc.params);
        }
        let lastId = null;
        let total = 0;
        for (;;) {
            const cursor = lastId != null ? `${where ? where + ' AND' : 'WHERE'} sl.id < ?` : where;
            const rows = await db.all(
                `SELECT sl.*, a.username
                   FROM system_logs sl LEFT JOIN admins a ON sl.admin_id = a.id
                   ${cursor}
                  ORDER BY sl.id DESC
                  LIMIT ?`,
                lastId != null ? [...all, lastId, pageSize] : [...all, pageSize]
            );
            if (!rows.length) break;
            total += rows.length;
            await onPage(rows);
            lastId = Number(rows[rows.length - 1].id);
            if (rows.length < pageSize) break;
        }
        return total;
    }

    // Clearance predicate for the log DATA. null scope → no restriction (SuperAdmin
    // sees all). Otherwise restrict to rows whose actor is one of the holder's
    // governed employees (actor_ref = `<userType>:<id>`) or their own admin actions.
    // Unqualified column names so it composes with both aliased (`sl.`) and bare
    // `FROM system_logs` queries — the joined `admins` table has neither column.
    _scopeCond(scope) {
        if (!scope) return null;
        return {
            cond: '(admin_id = ? OR actor_ref = ANY(?))',
            params: [scope.adminId, scope.actorRefs],
        };
    }

    async findFiltered(f = {}, limit = 100, offset = 0, scope = null) {
        const { clause, params } = this._filterClause(f);
        const sc = this._scopeCond(scope);
        let where = clause;
        const all = [...params];
        if (sc) {
            where = where ? `${where} AND ${sc.cond}` : `WHERE ${sc.cond}`;
            all.push(...sc.params);
        }
        return db.all(
            `SELECT sl.*, a.username
               FROM system_logs sl LEFT JOIN admins a ON sl.admin_id = a.id
               ${where}
              ORDER BY sl.created_at DESC
              LIMIT ? OFFSET ?`,
            [...all, Number(limit), Number(offset)]
        );
    }

    async countFiltered(f = {}, scope = null) {
        const { clause, params } = this._filterClause(f);
        const sc = this._scopeCond(scope);
        let where = clause;
        const all = [...params];
        if (sc) {
            where = where ? `${where} AND ${sc.cond}` : `WHERE ${sc.cond}`;
            all.push(...sc.params);
        }
        const r = await db.get(
            `SELECT COUNT(*)::int AS count FROM system_logs sl LEFT JOIN admins a ON sl.admin_id = a.id ${where}`,
            all
        );
        return r ? r.count : 0;
    }

    // Full correlated trail for one request id: audit rows + perf events, time-ordered.
    // Scope restricts the audit rows to the holder's clearance; perf_events carry no
    // actor/employee dimension, so they are a SuperAdmin-only infra signal.
    async findByRequestId(requestId, scope = null) {
        // request_id is a uuid column: anything else used to reach PG as a cast
        // error (22P02 → HTTP 500). An unknown id is an EMPTY trail.
        if (
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
                String(requestId || '')
            )
        ) {
            return { requestId, logs: [], perf: [], invalid: true };
        }
        const sc = this._scopeCond(scope);
        const extra = sc ? ` AND ${sc.cond}` : '';
        const [logs, perf] = await Promise.all([
            db.all(
                `SELECT sl.*, a.username FROM system_logs sl LEFT JOIN admins a ON sl.admin_id = a.id
                  WHERE sl.request_id = ?${extra} ORDER BY sl.created_at ASC`,
                sc ? [requestId, ...sc.params] : [requestId]
            ),
            scope
                ? Promise.resolve([])
                : db.all(`SELECT * FROM perf_events WHERE request_id = ? ORDER BY created_at ASC`, [
                      requestId,
                  ]),
        ]);
        return { requestId, logs, perf };
    }

    // "Conditions driving issues" — SQL-native aggregates over the structured columns.
    async issuesSummary(days = 7, scope = null) {
        const d = Math.max(1, Math.min(365, Math.trunc(Number(days) || 7)));
        const since = `created_at >= now() - interval '${d} days'`;
        // Clearance scope applies to the system_logs aggregates. perf_events and
        // login_attempts carry no actor/employee dimension, so they are global-infra
        // signals shown to SuperAdmins only (empty/zero for a scope-restricted holder).
        const sc = this._scopeCond(scope);
        const S = sc ? ` AND ${sc.cond}` : '';
        const P = sc ? sc.params : [];
        const scoped = !!scope;
        const [topFailingRoutes, slowestRoutes, perfByKind, recentSlow, lockouts, totals] =
            await Promise.all([
                db.all(
                    `SELECT route, status_code, COUNT(*)::int AS n
                      FROM system_logs WHERE ${since} AND status_code >= 400 AND route IS NOT NULL${S}
                     GROUP BY route, status_code ORDER BY n DESC LIMIT 12`,
                    P
                ),
                db.all(
                    `SELECT route, COUNT(*)::int AS n, ROUND(AVG(latency_ms))::int AS avg_ms,
                           MAX(latency_ms)::int AS max_ms
                      FROM system_logs WHERE ${since} AND latency_ms IS NOT NULL AND route IS NOT NULL${S}
                     GROUP BY route ORDER BY max_ms DESC NULLS LAST LIMIT 12`,
                    P
                ),
                scoped
                    ? []
                    : db.all(`SELECT kind, COALESCE(pg_code,'—') AS pg_code, COUNT(*)::int AS n,
                           ROUND(AVG(latency_ms))::int AS avg_ms
                      FROM perf_events WHERE ${since} GROUP BY kind, pg_code ORDER BY n DESC LIMIT 15`),
                scoped
                    ? []
                    : db.all(`SELECT to_char(created_at,'YYYY-MM-DD HH24:MI') AS at, kind, route, latency_ms, pg_code, request_id
                      FROM perf_events WHERE ${since} ORDER BY created_at DESC LIMIT 20`),
                scoped
                    ? []
                    : db
                          .all(
                              `SELECT COALESCE(username, host(ip_address)) AS who, COUNT(*)::int AS fails
                      FROM login_attempts WHERE successful = false AND attempted_at >= now() - interval '${d} days'
                     GROUP BY 1 ORDER BY fails DESC LIMIT 10`
                          )
                          .catch(() => []),
                scoped
                    ? db.get(
                          `SELECT
                        (SELECT COUNT(*)::int FROM system_logs WHERE ${since} AND status_code >= 500${S}) AS errors_5xx,
                        (SELECT COUNT(*)::int FROM system_logs WHERE ${since} AND status_code IN (401,403)${S}) AS denied,
                        0 AS slow_requests, 0 AS db_issues`,
                          [...P, ...P]
                      )
                    : db.get(`SELECT
                        (SELECT COUNT(*)::int FROM system_logs WHERE ${since} AND status_code >= 500) AS errors_5xx,
                        (SELECT COUNT(*)::int FROM system_logs WHERE ${since} AND status_code IN (401,403)) AS denied,
                        (SELECT COUNT(*)::int FROM perf_events WHERE ${since} AND kind='slow_request') AS slow_requests,
                        (SELECT COUNT(*)::int FROM perf_events WHERE ${since} AND kind IN ('slow_query','db_error')) AS db_issues`),
            ]);
        return {
            days: d,
            topFailingRoutes,
            slowestRoutes,
            perfByKind,
            recentSlow,
            lockouts,
            totals,
        };
    }

    async findByAdminId(adminId, limit = 100) {
        return await db.all(
            `
            SELECT sl.*, a.username
            FROM systemLogs sl
            LEFT JOIN admins a ON sl.adminId = a.id
            WHERE sl.adminId = ?
            ORDER BY sl.createdAt DESC
            LIMIT ?
        `,
            [adminId, limit]
        );
    }

    // Aggregated analytics for the System Logs "Analytics" tab. Raw snake_case SQL
    // (PG date functions); `days` is coerced to a number and interpolated safely.
    // "Risk" actions = anything that smells like a failure/denial/lockout/delete/reset.
    async analytics(days = 30, scope = null) {
        const d = Math.max(1, Math.min(365, Math.trunc(Number(days) || 30)));
        const RISK = `(action ILIKE '%FAIL%' OR action ILIKE '%DENIED%' OR action ILIKE '%LOCK%' OR action ILIKE '%DELETE%' OR action ILIKE '%RESET%' OR action ILIKE '%UNAUTH%')`;
        const since = `created_at >= now() - interval '${d} days'`;
        // Every analytics aggregate is over system_logs, so the clearance scope
        // applies uniformly (SuperAdmin: no restriction; scoped holder: governed
        // actors + own admin actions only).
        const sc = this._scopeCond(scope);
        const S = sc ? ` AND ${sc.cond}` : '';
        const P = sc ? sc.params : [];
        const [byDay, byAction, byActor, byHour, riskByDay, topIps, totals] = await Promise.all([
            db.all(
                `SELECT to_char(date_trunc('day', created_at),'YYYY-MM-DD') AS day, COUNT(*)::int AS n
                      FROM system_logs WHERE ${since}${S} GROUP BY 1 ORDER BY 1`,
                P
            ),
            db.all(
                `SELECT action, COUNT(*)::int AS n FROM system_logs WHERE ${since}${S}
                     GROUP BY action ORDER BY n DESC LIMIT 12`,
                P
            ),
            db.all(
                `SELECT COALESCE(a.username, sl.actor_ref, 'System') AS actor, COUNT(*)::int AS n
                      FROM system_logs sl LEFT JOIN admins a ON sl.admin_id = a.id
                     WHERE sl.created_at >= now() - interval '${d} days'${S}
                     GROUP BY 1 ORDER BY n DESC LIMIT 12`,
                P
            ),
            db.all(
                `SELECT date_part('hour', created_at)::int AS hour, COUNT(*)::int AS n
                      FROM system_logs WHERE ${since}${S} GROUP BY 1 ORDER BY 1`,
                P
            ),
            db.all(
                `SELECT to_char(date_trunc('day', created_at),'YYYY-MM-DD') AS day, COUNT(*)::int AS n
                      FROM system_logs WHERE ${since} AND ${RISK}${S} GROUP BY 1 ORDER BY 1`,
                P
            ),
            db.all(
                `SELECT host(ip_address) AS ip, COUNT(*)::int AS n
                      FROM system_logs WHERE ${since} AND ip_address IS NOT NULL${S}
                     GROUP BY 1 ORDER BY n DESC LIMIT 10`,
                P
            ),
            db.get(
                `SELECT COUNT(*)::int AS total,
                           COUNT(*) FILTER (WHERE ${RISK})::int AS risk,
                           COUNT(DISTINCT COALESCE(admin_id::text, actor_ref))::int AS actors,
                           COUNT(DISTINCT host(ip_address))::int AS ips
                      FROM system_logs WHERE ${since}${S}`,
                P
            ),
        ]);
        return { days: d, byDay, byAction, byActor, byHour, riskByDay, topIps, totals };
    }
}

module.exports = new SystemLogModel();
