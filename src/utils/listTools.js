'use strict';

/**
 * listTools — the shared server half of the list toolkit (; ,
 * ). Every admin list builds its pager, its sort and its CSV export from
 * here, so a filter can never be lost by paging again and a sort key can never
 * reach SQL un-whitelisted.
 *
 *   parsePage(query, opts)                → { page, perPage, offset }
 *   buildPager(query, {page,total,perPage}) → links that carry EVERY current query param
 *   sortClause(query, whitelist, default) → { key, dir, orderBy } — whitelist only
 *   sortLinks(query, whitelist, sort)     → per-column href + aria-sort for <th> buttons
 *   csvResponse(res, filename, headers, rows) → Excel-safe CSV (BOM + sep + formula guard)
 */
const { csvCell } = require('./csvSafe');

const DIRS = new Set(['asc', 'desc']);

/** Query → URLSearchParams, keeping repeated keys (siteId[]=1&siteId[]=2). */
function paramsFrom(query, omit = []) {
    const qs = new URLSearchParams();
    Object.entries(query || {}).forEach(([k, v]) => {
        if (omit.includes(k) || v == null || v === '') return;
        if (Array.isArray(v))
            v.forEach((x) => {
                if (x != null && x !== '') qs.append(k, String(x));
            });
        else if (typeof v === 'object')
            return; // nested objects never belong in a list URL
        else qs.append(k, String(v));
    });
    return qs;
}

function parsePage(query, { perPageOptions = [20, 50, 100, 200], defaultPerPage = 50 } = {}) {
    const page = Math.max(1, parseInt(query && query.page, 10) || 1);
    let perPage = parseInt(query && query.perPage, 10) || defaultPerPage;
    // Allow-listed so a crafted ?perPage=999999 can't ask the DB for the whole table.
    if (!perPageOptions.includes(perPage)) perPage = defaultPerPage;
    return { page, perPage, offset: (page - 1) * perPage };
}

/**
 * Pager model for a view. `page` is clamped into [1, totalPages]; `items` is the
 * classic "1 … 4 5 [6] 7 8 … 20" window with `{ gap: true }` markers.
 */
function buildPager(query, { page, total, perPage, basePath = '', window: win = 2 } = {}) {
    const perPageN = Math.max(1, Number(perPage) || 50);
    const totalN = Math.max(0, Number(total) || 0);
    const totalPages = Math.max(1, Math.ceil(totalN / perPageN));
    const current = Math.min(Math.max(1, Number(page) || 1), totalPages);
    const base = paramsFrom(query, ['page']);
    const urlFor = (n) => {
        const qs = new URLSearchParams(base);
        qs.set('page', String(n));
        return `${basePath}?${qs.toString()}`;
    };
    const items = [];
    for (let i = 1; i <= totalPages; i++) {
        const shown = i === 1 || i === totalPages || (i >= current - win && i <= current + win);
        if (shown) items.push({ n: i, url: urlFor(i), active: i === current });
        else if (items.length && !items[items.length - 1].gap) items.push({ gap: true });
    }
    const from = totalN === 0 ? 0 : (current - 1) * perPageN + 1;
    const to = Math.min(totalN, current * perPageN);
    return {
        page: current,
        perPage: perPageN,
        total: totalN,
        totalPages,
        from,
        to,
        hasPrev: current > 1,
        hasNext: current < totalPages,
        prevUrl: current > 1 ? urlFor(current - 1) : null,
        nextUrl: current < totalPages ? urlFor(current + 1) : null,
        items,
        urlFor,
    };
}

/** Normalise a whitelist given as an array of keys or a {key: sqlExpr} map. */
function whitelistMap(whitelist) {
    if (Array.isArray(whitelist)) return Object.fromEntries(whitelist.map((k) => [k, k]));
    return whitelist || {};
}

/**
 * Resolve ?sort=&dir= against a whitelist. Unknown keys fall back to the default
 * (never an error page, never raw SQL from the client). `orderBy` is ready to
 * append after ORDER BY; an optional `tiebreak` keeps paging stable.
 */
function sortClause(query, whitelist, defaultKey, { defaultDir = 'asc', tiebreak = '' } = {}) {
    const map = whitelistMap(whitelist);
    const wanted = String((query && query.sort) || '');
    const key = Object.prototype.hasOwnProperty.call(map, wanted) ? wanted : defaultKey;
    const rawDir = String((query && query.dir) || '').toLowerCase();
    const dir = DIRS.has(rawDir) && key === wanted ? rawDir : defaultDir;
    const expr = map[key] || key;
    const orderBy = `${expr} ${dir.toUpperCase()}${tiebreak ? `, ${tiebreak}` : ''}`;
    return { key, dir, orderBy, isDefault: key === defaultKey && dir === defaultDir };
}

/**
 * Per-column link model for sortable headers: clicking the active column flips
 * the direction; any sort change goes back to page 1; every other filter is kept.
 * `ariaSort` is the WAI-ARIA value for the <th>.
 */
function sortLinks(query, whitelist, sort, { basePath = '' } = {}) {
    const map = whitelistMap(whitelist);
    const base = paramsFrom(query, ['sort', 'dir', 'page']);
    const out = {};
    Object.keys(map).forEach((key) => {
        const active = sort && sort.key === key;
        const nextDir = active && sort.dir === 'asc' ? 'desc' : 'asc';
        const qs = new URLSearchParams(base);
        qs.set('sort', key);
        qs.set('dir', nextDir);
        out[key] = {
            url: `${basePath}?${qs.toString()}`,
            active,
            dir: active ? sort.dir : null,
            ariaSort: active ? (sort.dir === 'desc' ? 'descending' : 'ascending') : 'none',
        };
    });
    return out;
}

/** Filename safe for Content-Disposition (ASCII, no path separators). */
function safeFilename(name) {
    const s = String(name || 'export.csv')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return /\.csv$/i.test(s) ? s : `${s || 'export'}.csv`;
}

/**
 * Send an Excel-ready CSV: UTF-8 BOM + `sep=,` (ReportBuilderService.excelCsv,
 * the one implementation every export shares) and the formula-injection guard
 * on every cell (csvSafe). `rows` are arrays in header order.
 */
function csvResponse(res, filename, headers, rows) {
    const { excelCsv } = require('../services/ReportBuilderService');
    const lines = [headers.map(csvCell).join(',')];
    (rows || []).forEach((r) =>
        lines.push((Array.isArray(r) ? r : Object.values(r)).map(csvCell).join(','))
    );
    const body = excelCsv(lines.join('\r\n') + '\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(filename)}"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(body);
}

module.exports = {
    parsePage,
    buildPager,
    sortClause,
    sortLinks,
    csvResponse,
    paramsFrom,
    safeFilename,
};
