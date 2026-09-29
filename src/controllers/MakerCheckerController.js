'use strict';

/**
 * MakerCheckerController — the READ path of the two-person-rule queue.
 *
 * the queue used to be a bare 36-line <table> printing the raw
 * kind, the numeric maker id, a raw timestamp and the payload as a <pre> JSON
 * blob, with no filters, no paging and no empty state. It is rebuilt on the
 * /cancellations pattern — a GET filter form (state / kind / site), a pager
 * from utils/listTools, translated states and kinds, the maker's name, dates
 * through the shared formatter and a readable one-line summary of the payload.
 *
 * The decide path stays in routes/v2-uam.js (MakerCheckerService.decide).
 */

const db = require('../config/database');
const { parsePage, buildPager } = require('../utils/listTools');

/** The lifecycle of maker_checker_requests.state (PG enum `mc_state`). */
const STATES = ['pending', 'approved', 'applied', 'rejected', 'failed', 'cancelled'];

/** Kinds are registered at boot by the owning services (MakerCheckerService.register). */
function knownKinds() {
    try {
        // eslint-disable-next-line global-require
        const Svc = require('../services/MakerCheckerService');
        return typeof Svc.kinds === 'function' ? Svc.kinds() : [];
    } catch (_) {
        return [];
    }
}

/**
 * A readable one-line summary of the payload. Kinds are few and registered in
 * code, so each gets an explicit sentence; anything unregistered falls back to
 * the field list (never a raw JSON dump on screen).
 */
function summarize(kind, payload, t) {
    const p =
        (typeof payload === 'string'
            ? (() => {
                  try {
                      return JSON.parse(payload);
                  } catch (_) {
                      return {};
                  }
              })()
            : payload) || {};
    if (kind === 'pip.create') {
        return t('admin:mcq_sum_pip_create', {
            defaultValue: 'Performance plan for employee #{{employee}}, {{from}} → {{to}}',
            employee: p.employeeId != null ? p.employeeId : '?',
            from: p.startsOn || '—',
            to: p.endsOn || '—',
        });
    }
    const fields = Object.keys(p).slice(0, 6).join(', ');
    return fields || t('admin:mcq_sum_empty', { defaultValue: 'No details' });
}

const MakerCheckerController = {
    async queue(req, res) {
        const t = (k, o) => (req.t ? req.t(k, o) : (o && o.defaultValue) || k);
        // Default view = what actually needs a decision. `?state=all` (or any
        // unknown value) lifts the filter, so nothing is hidden — only unasked-for.
        const rawState = req.query.state === undefined ? 'pending' : String(req.query.state);
        const stateFilter = STATES.includes(rawState) ? rawState : '';
        const filters = {
            state: stateFilter || 'all',
            kind: String(req.query.kind || '').slice(0, 64),
            siteId: /^\d+$/.test(String(req.query.siteId || '')) ? Number(req.query.siteId) : '',
        };

        const where = [];
        const params = [];
        if (stateFilter) {
            where.push('r.state = ?');
            params.push(stateFilter);
        }
        if (filters.kind) {
            where.push('r.kind = ?');
            params.push(filters.kind);
        }
        // The subject employee lives in the payload; the site filter joins through it.
        if (filters.siteId) {
            where.push('e.site_id = ?');
            params.push(filters.siteId);
        }
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

        const from = `FROM maker_checker_requests r
             LEFT JOIN admins m ON m.id = r.maker_id
             LEFT JOIN admins c ON c.id = r.checker_id
             LEFT JOIN employees e ON e.id = NULLIF(r.payload->>'employeeId','')::bigint
             LEFT JOIN sites s ON s.id = e.site_id`;

        const totalRow = await db.get(`SELECT COUNT(*) AS c ${from} ${whereSql}`, params);
        const total = Number((totalRow && (totalRow.c ?? totalRow.count)) || 0);
        const { page, perPage, offset } = parsePage(req.query, { defaultPerPage: 50 });

        const rows = await db.all(
            `SELECT r.id, r.kind, r.payload, r.state, r.reason, r.error, r.maker_id,
                    r.created_at, r.decided_at, r.applied_at,
                    m.username AS maker_username, c.username AS checker_username,
                    e.id AS employee_id, e.first_name, e.last_name, e.employee_number,
                    s.name AS site_name
             ${from} ${whereSql}
             ORDER BY r.created_at DESC
             LIMIT ${perPage} OFFSET ${offset}`,
            params
        );

        const items = rows.map((r) => ({
            id: r.id,
            kind: r.kind,
            kindLabel: t(`admin:mcq_kind_${String(r.kind).replace(/\./g, '_')}`, {
                defaultValue: r.kind,
            }),
            state: r.state,
            reason: r.reason,
            error: r.error,
            createdAt: r.createdAt ?? r.created_at,
            decidedAt: r.decidedAt ?? r.decided_at,
            makerId: r.makerId ?? r.maker_id ?? null,
            makerName: r.makerUsername ?? r.maker_username ?? null,
            checkerName: r.checkerUsername ?? r.checker_username ?? null,
            employeeId: r.employeeId ?? r.employee_id ?? null,
            employeeName:
                [r.firstName ?? r.first_name, r.lastName ?? r.last_name]
                    .filter(Boolean)
                    .join(' ') || null,
            employeeNumber: r.employeeNumber ?? r.employee_number ?? null,
            siteName: r.siteName ?? r.site_name ?? null,
            summary: summarize(r.kind, r.payload, t),
        }));

        const sites = await db.all('SELECT id, name FROM sites ORDER BY name');

        res.render('pages/maker-checker/index', {
            title: t('chrome:pt_approvals_queue', { defaultValue: 'Approvals queue' }),
            items,
            filters,
            states: STATES,
            kinds: knownKinds(),
            sites,
            pager: buildPager(req.query, {
                page,
                total,
                perPage,
                basePath: '/v2/uam/maker-checker/queue',
            }),
            me: req.user,
        });
    },
};

module.exports = MakerCheckerController;
module.exports.STATES = STATES;
module.exports.summarize = summarize;
