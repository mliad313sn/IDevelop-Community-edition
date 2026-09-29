const SystemLogModel = require('../models/SystemLogModel');
const RBACService = require('../services/RBACService');
const { csvCell } = require('../utils/csvSafe');
const { parsePage, buildPager, safeFilename } = require('../utils/listTools');

// Clearance scope for the log DATA (access is already gated by the permission).
// null → unrestricted (SuperAdmin sees everything). Otherwise → the holder may
// only see rows whose actor is one of their governed employees, plus their own
// admin actions. Global-infra signals (perf/login/IP) are handled SuperAdmin-only
// inside the model. actor_ref is written as `<userType>:<id>` (see LogService).
async function scopeFor(user) {
    if (RBACService.isSuperAdmin(user)) return null;
    const emps = await RBACService.getFilteredEmployees(user, { includeInactive: true }); // audit trail: a leaver's past actions stay visible to their admin
    const refs = [];
    for (const e of emps) {
        const id = Number(e.id);
        refs.push(`employee:${id}`, `manager:${id}`, `supervisor:${id}`);
    }
    if (user && user.id != null) refs.push(`admin:${Number(user.id)}`);
    return { adminId: Number(user && user.id) || -1, actorRefs: refs };
}

const SEVERITIES = ['info', 'warn', 'error', 'critical'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate the query into a filter object + per-field messages. An
 * invalid value is DROPPED from the filter and reported next to its field; the
 * page renders with the remaining filters instead of bouncing to /dashboard.
 * Both the list and the export go through here, so they can never disagree.
 */
function parseFilters(query, t) {
    const q = query || {};
    const f = {};
    const errors = {};
    const msg = (key, fallback) => (typeof t === 'function' ? t(`syslogs:${key}`) : fallback);
    const str = (k) => (q[k] != null && String(q[k]).trim() !== '' ? String(q[k]).trim() : null);

    const status = str('status');
    if (status) {
        const st = SystemLogModel.parseStatus(status);
        if (st) f.status = st;
        else
            errors.status = msg(
                'log_err_status',
                'Enter an HTTP status (403), a class (4xx) or a range (400-499).'
            );
    }
    const severity = str('severity');
    if (severity) {
        if (SEVERITIES.includes(severity.toLowerCase())) f.severity = severity.toLowerCase();
        else errors.severity = msg('log_err_severity', 'Unknown severity.');
    }
    for (const k of ['category', 'route', 'action', 'actor']) {
        const v = str(k);
        if (v) f[k] = v.slice(0, 200);
    }
    const requestId = str('requestId');
    if (requestId) {
        if (UUID.test(requestId)) f.requestId = requestId;
        else errors.requestId = msg('log_err_request_id', 'A request id is a UUID.');
    }
    for (const k of ['from', 'to']) {
        const v = str(k);
        if (!v) continue;
        if (ISO_DATE.test(v) && !Number.isNaN(new Date(v).getTime())) f[k] = v;
        else errors[k] = msg('log_err_date', 'Enter a date as YYYY-MM-DD.');
    }
    if (f.from && f.to && f.from > f.to)
        errors.to = msg('log_err_date_order', 'The end date is before the start date.');
    const entityType = str('entityType');
    if (entityType) {
        if (/^[a-z_]{2,40}$/i.test(entityType)) f.entityType = entityType;
        else errors.entityType = msg('log_err_entity_type', 'Unknown entity type.');
    }
    for (const k of ['entityId', 'employeeId']) {
        const v = str(k);
        if (!v) continue;
        if (/^\d{1,12}$/.test(v)) f[k] = Number(v);
        else errors[k] = msg('log_err_id', 'An identifier is a whole number.');
    }
    if (q.errorsOnly === '1' || q.errorsOnly === 'true') f.errorsOnly = true;
    if (q.excludeHttp === '1' || q.excludeHttp === 'true') f.excludeHttp = true;
    return { filters: f, errors };
}

/** ISO-8601 in the export (sortable in Excel; the page renders fmtDateTime). */
function iso(d) {
    if (!d) return '';
    const x = d instanceof Date ? d : new Date(d);
    return Number.isNaN(x.getTime()) ? String(d) : x.toISOString();
}

const EXPORT_HEADERS = [
    'id',
    'created_at',
    'username',
    'actor_ref',
    'action',
    'category',
    'severity',
    'entity_type',
    'entity_id',
    'details',
    'http_method',
    'route',
    'status_code',
    'latency_ms',
    'request_id',
    'ip_address',
    'user_agent',
];

function exportRow(log) {
    const details =
        log.details == null
            ? ''
            : typeof log.details === 'object'
              ? JSON.stringify(log.details)
              : String(log.details);
    return [
        log.id,
        iso(log.createdAt),
        log.username || 'System',
        log.actorRef || '',
        log.action || '',
        log.category || '',
        log.severity || '',
        log.entityType || '',
        log.entityId == null ? '' : log.entityId,
        details,
        log.httpMethod || '',
        log.route || '',
        log.statusCode == null ? '' : log.statusCode,
        log.latencyMs == null ? '' : log.latencyMs,
        log.requestId || '',
        log.ipAddress || '',
        log.userAgent || '',
    ];
}

/** `journaux-2026-09-01-2026-09-10-actor-admin.csv` — the filter is in the name. */
function exportFilename(f, ext) {
    const parts = ['journaux'];
    parts.push(f.from || 'debut', f.to || new Date().toISOString().slice(0, 10));
    for (const k of [
        'actor',
        'category',
        'action',
        'severity',
        'entityType',
        'entityId',
        'employeeId',
    ]) {
        if (f[k] != null && f[k] !== '') parts.push(k, String(f[k]));
    }
    if (f.status) parts.push('status', `${f.status.min}-${f.status.max}`);
    if (f.errorsOnly) parts.push('problemes');
    return safeFilename(parts.join('-')).replace(/\.csv$/i, `.${ext}`);
}

class SystemLogController {
    async index(req, res) {
        try {
            if (!RBACService.hasPermission(req.user, 'view_system_logs')) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('syslogs:log_no_permission')
                        : 'You do not have permission to view system logs'
                );
                return res.redirect('/dashboard');
            }
            const scope = await scopeFor(req.user);
            const { filters: f, errors: filterErrors } = parseFilters(req.query, req.t);
            const { page, perPage, offset } = parsePage(req.query, {
                perPageOptions: [50, 100, 250],
                defaultPerPage: 50,
            });

            // Always route through the filtered path so the clearance scope applies
            // even when the user set no filters (empty f = no extra predicates).
            const [total, logs, facets] = await Promise.all([
                SystemLogModel.countFiltered(f, scope),
                SystemLogModel.findFiltered(f, perPage, offset, scope),
                SystemLogModel.facets(scope),
            ]);
            const pager = buildPager(req.query, { page, total, perPage, basePath: '/system-logs' });
            const exportQs = new URLSearchParams();
            Object.entries(req.query).forEach(([k, v]) => {
                if (!['page', 'perPage', 'format'].includes(k) && v != null && v !== '')
                    exportQs.set(k, String(v));
            });

            res.render('pages/system-logs/index', {
                title: req.t ? req.t('chrome:pt_system_logs') : 'System Logs',
                logs,
                total,
                filters: f,
                filterErrors,
                facets,
                pager,
                perPage,
                exportQs: exportQs.toString(),
                query: req.query,
                severities: SEVERITIES,
                entityTypes: Object.keys(SystemLogModel.ENTITY_SYNONYMS),
            });
        } catch (error) {
            console.error('System logs index error:', error);
            req.flash(
                'error',
                req.t ? req.t('syslogs:log_load_error') : 'Error loading system logs'
            );
            res.redirect('/dashboard');
        }
    }

    // Full correlated trail for one request id — the core reconciliation view.
    async requestTrail(req, res) {
        try {
            if (!RBACService.hasPermission(req.user, 'view_system_logs')) {
                return res.status(403).json({ error: 'Access denied' });
            }
            const scope = await scopeFor(req.user);
            const trail = await SystemLogModel.findByRequestId(String(req.params.id), scope);
            // Not a uuid → 404 with an empty trail, never a 500.
            if (trail.invalid)
                return res.status(404).json({
                    requestId: trail.requestId,
                    logs: [],
                    perf: [],
                    error: 'unknown_request_id',
                });
            res.json(trail);
        } catch (error) {
            console.error('System logs request-trail error:', error);
            res.status(500).json({ error: 'Error loading request trail' });
        }
    }

    // "Conditions driving issues" JSON summary (top failing/slowest routes, perf, lockouts).
    async issues(req, res) {
        try {
            if (!RBACService.hasPermission(req.user, 'view_system_logs')) {
                return res.status(403).json({ error: 'Access denied' });
            }
            const scope = await scopeFor(req.user);
            const data = await SystemLogModel.issuesSummary(req.query.days || 7, scope);
            res.json(data);
        } catch (error) {
            console.error('System logs issues error:', error);
            res.status(500).json({ error: 'Error computing issues summary' });
        }
    }

    /**
     * Export EXACTLY the filtered list: same parseFilters as the page,
     * streamed page by page (no 10 000-row cap), ISO dates, UTF-8 BOM + `sep=,`
     * so fr-FR Excel splits the columns, every facet column, formula-injection
     * guard on every cell, and a filename that names the filter and the dates.
     */
    async export(req, res) {
        try {
            if (!RBACService.hasPermission(req.user, 'view_system_logs')) {
                return res.status(403).json({ error: 'Access denied' });
            }
            const scope = await scopeFor(req.user);
            const { filters: f, errors } = parseFilters(req.query, req.t);
            if (Object.keys(errors).length) {
                // A bad filter must not silently export everything instead.
                return res.status(400).json({ error: 'invalid_filter', fields: errors });
            }
            const format = req.query.format === 'json' ? 'json' : 'csv';
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader(
                'Content-Disposition',
                `attachment; filename="${exportFilename(f, format)}"`
            );

            if (format === 'json') {
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.write('{"logs":[');
                let first = true;
                await SystemLogModel.eachFilteredPage(f, scope, async (rows) => {
                    for (const log of rows) {
                        res.write((first ? '' : ',') + JSON.stringify(log));
                        first = false;
                    }
                });
                res.write(']}');
                return res.end();
            }

            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            // Same Excel treatment as every other export (ReportBuilderService.excelCsv).
            res.write('﻿' + 'sep=,\r\n' + EXPORT_HEADERS.map(csvCell).join(',') + '\r\n');
            await SystemLogModel.eachFilteredPage(f, scope, async (rows) => {
                // csvCell neutralizes spreadsheet formula injection (=,+,-,@,tab,CR) +
                // RFC-4180 quotes. Critical here: action/details/userAgent embed
                // attacker-controllable values (e.g. a crafted User-Agent on a failed login).
                res.write(
                    rows.map((log) => exportRow(log).map(csvCell).join(',')).join('\r\n') + '\r\n'
                );
            });
            res.end();
        } catch (error) {
            console.error('System logs export error:', error);
            if (res.headersSent) return res.end();
            req.flash(
                'error',
                req.t ? req.t('syslogs:log_export_error') : 'Error exporting system logs'
            );
            res.redirect('/system-logs');
        }
    }

    // JSON aggregates for the Analytics tab (charts). Scoped to the holder's clearance.
    async analytics(req, res) {
        try {
            if (!RBACService.hasPermission(req.user, 'view_system_logs')) {
                return res.status(403).json({ error: 'Access denied' });
            }
            const scope = await scopeFor(req.user);
            const data = await SystemLogModel.analytics(req.query.days || 30, scope);
            res.json(data);
        } catch (error) {
            console.error('System logs analytics error:', error);
            res.status(500).json({ error: 'Error computing log analytics' });
        }
    }
}

const controller = new SystemLogController();
controller.scopeFor = scopeFor; // reused by the employee "Journal" section
controller.parseFilters = parseFilters;
controller.exportFilename = exportFilename;
controller.EXPORT_HEADERS = EXPORT_HEADERS;
module.exports = controller;
