'use strict';

/**
 * DashboardScopeService — the scope bar of the dashboard: which part of the
 * reader's clearance the page shows (a site, a department, or all of it), and
 * the last scope the reader chose, remembered on the SERVER (migration 185).
 *
 * RULES
 *   - The scope is in the URL (?site=, ?department=, ?scope=all) so a link can
 *     be shared and the back button works. A URL without a scope restores the
 *     reader's last choice for that page.
 *   - Never browser storage: a shared computer or a kiosk serves several
 *     people one after the other, and a scope kept in the browser would carry
 *     one person's choice over to the next. The preference is keyed on the
 *     signed-in account.
 *   - A scope is a PREFERENCE, never a clearance. Only a site or a department
 *     where somebody of the reader's own population works is offered and
 *     accepted. A URL naming any other unit is refused (the page says so; the
 *     filter is not applied and nothing is remembered). A remembered scope
 *     that no longer fits is dropped silently.
 *   - Only whole numbers (and 'none' for « No site ») ever reach a query, and
 *     they reach it as bound parameters.
 */

const db = require('../config/database');

/** The pages that remember a scope (fixed keys: no client value is stored as a key). */
const PAGES = Object.freeze(['dashboard', 'board_pack']);

const INT = /^[1-9][0-9]{0,9}$/;

function lastOf(v) {
    return Array.isArray(v) ? v[v.length - 1] : v;
}

/**
 * The scope asked for in a query string, or null when the URL names none.
 * @returns {{site: number|'none'|null, department: number|null, all: boolean, malformed: boolean}|null}
 */
function parseQuery(query) {
    const q = query || {};
    const site = lastOf(q.site);
    const dept = lastOf(q.department);
    const scope = lastOf(q.scope);
    const has = (v) => v !== undefined && v !== null && v !== '';
    if (!has(site) && !has(dept) && scope !== 'all') return null;
    const out = { site: null, department: null, all: false, malformed: false };
    if (scope === 'all' && !has(site) && !has(dept)) {
        out.all = true;
        return out;
    }
    if (has(site)) {
        const s = String(site);
        if (s === 'none') out.site = 'none';
        else if (INT.test(s)) out.site = Number(s);
        else out.malformed = true;
    }
    if (has(dept)) {
        const d = String(dept);
        if (INT.test(d)) out.department = Number(d);
        else out.malformed = true;
    }
    return out;
}

function principalOf(user) {
    if (!user || user.id === null || user.id === undefined) return null;
    const id = Number(user.id);
    if (!Number.isInteger(id) || id <= 0) return null;
    return { type: user.userType === 'admin' ? 'admin' : 'employee', id };
}

function pageKey(page) {
    return PAGES.includes(page) ? page : null;
}

/** The stored scope object of a page, or null (nothing stored, or the table is absent). */
async function readPref(user, page) {
    const p = principalOf(user);
    const k = pageKey(page);
    if (!p || !k) return null;
    try {
        const row = await db.get(
            `SELECT scope FROM dashboard_scope_prefs
              WHERE user_type = ? AND user_id = ? AND page = ?`,
            [p.type, p.id, k]
        );
        if (!row) return null;
        const s = typeof row.scope === 'string' ? JSON.parse(row.scope) : row.scope;
        return s && typeof s === 'object' && !Array.isArray(s) ? s : null;
    } catch (_) {
        return null;
    }
}

/** Remember a validated scope ({} = all of the reader's clearance). Best effort. */
async function writePref(user, page, scope) {
    const p = principalOf(user);
    const k = pageKey(page);
    if (!p || !k) return false;
    const clean = {};
    if (scope && scope.site !== undefined && scope.site !== null) clean.site = scope.site;
    if (scope && scope.department !== undefined && scope.department !== null)
        clean.department = scope.department;
    try {
        await db.runInSavepoint(() =>
            db.run(
                `INSERT INTO dashboard_scope_prefs (user_type, user_id, page, scope, updated_at)
                 VALUES (?, ?, ?, ?::jsonb, now())
                 ON CONFLICT (user_type, user_id, page)
                 DO UPDATE SET scope = EXCLUDED.scope, updated_at = now()`,
                [p.type, p.id, k, JSON.stringify(clean)]
            )
        );
        return true;
    } catch (_) {
        return false;
    }
}

/**
 * The units the reader may scope to: the sites and departments where people
 * of the reader's OWN population work (clearance first), with head counts.
 * @param {{ids:number[], rows:Array}} pop KpiService.resolvePopulation({viewer})
 */
async function options(pop) {
    const P = pop || { ids: [], rows: [] };
    const sites = new Map();
    const depts = new Map();
    let noSite = 0;
    for (const r of P.rows || []) {
        if (r.siteId === null || r.siteId === undefined) noSite++;
        else {
            const e = sites.get(r.siteId) || { id: r.siteId, name: r.siteName || '', n: 0 };
            e.n++;
            sites.set(r.siteId, e);
        }
        if (r.departmentId !== null && r.departmentId !== undefined)
            depts.set(r.departmentId, (depts.get(r.departmentId) || 0) + 1);
    }
    let departments = [];
    if (depts.size) {
        const rows = await db.all(
            `SELECT d.id AS "id", d.name AS "name", d.site_id AS "siteId", s.name AS "siteName"
               FROM departments d LEFT JOIN sites s ON s.id = d.site_id
              WHERE d.id = ANY(?)`,
            [[...depts.keys()]]
        );
        const seen = new Map();
        for (const r of rows || []) seen.set(r.name, (seen.get(r.name) || 0) + 1);
        departments = (rows || []).map((r) => ({
            id: Number(r.id),
            name: r.name,
            siteId: r.siteId === null || r.siteId === undefined ? null : Number(r.siteId),
            // the same department name on two sites reads « Name — Site »
            label: seen.get(r.name) > 1 && r.siteName ? `${r.name} — ${r.siteName}` : r.name,
            n: depts.get(Number(r.id)) || 0,
        }));
        departments.sort((a, b) => String(a.label).localeCompare(String(b.label)));
    }
    return {
        people: (P.ids || []).length,
        sites: [...sites.values()].sort((a, b) => String(a.name).localeCompare(String(b.name))),
        noSite,
        departments,
    };
}

/**
 * Check a parsed scope against the reader's options.
 * @returns {{ok: true, scope: {site?, department?}} | {ok: false}}
 */
function validate(parsed, opts) {
    if (!parsed) return { ok: true, scope: {} };
    if (parsed.malformed) return { ok: false };
    if (parsed.all) return { ok: true, scope: {} };
    const O = opts || { sites: [], departments: [], noSite: 0 };
    const scope = {};
    if (parsed.site === 'none') {
        if (!O.noSite) return { ok: false };
        scope.site = 'none';
    } else if (parsed.site !== null && parsed.site !== undefined) {
        if (!(O.sites || []).some((s) => s.id === parsed.site)) return { ok: false };
        scope.site = parsed.site;
    }
    if (parsed.department !== null && parsed.department !== undefined) {
        const d = (O.departments || []).find((x) => x.id === parsed.department);
        if (!d) return { ok: false };
        // a department of another site than the chosen one is a contradiction
        if (typeof scope.site === 'number' && d.siteId !== null && d.siteId !== scope.site)
            return { ok: false };
        scope.department = parsed.department;
    }
    return { ok: true, scope };
}

/** A stored scope object back into the parsed shape (ids only; anything else drops it). */
function fromStored(stored) {
    if (!stored || typeof stored !== 'object') return null;
    const q = {};
    if (stored.site !== undefined) q.site = String(stored.site);
    if (stored.department !== undefined) q.department = String(stored.department);
    if (!Object.keys(q).length)
        return { site: null, department: null, all: true, malformed: false };
    return parseQuery(q);
}

/**
 * Resolve the scope of one request on one page.
 *   URL scope valid    → applied and remembered (source 'url')
 *   URL scope invalid  → refused: { refused: true } (not applied, not remembered)
 *   no URL scope       → the remembered one when it still fits (source 'saved'),
 *                        else all of the reader's clearance (source 'default')
 * @returns {Promise<{scope: {site?, department?}, source: string, refused: boolean}>}
 */
async function resolve({ user, query, page, opts, remember = true }) {
    const parsed = parseQuery(query);
    if (parsed) {
        const v = validate(parsed, opts);
        if (!v.ok) return { scope: {}, source: 'url', refused: true };
        if (remember) await writePref(user, page, v.scope);
        return { scope: v.scope, source: 'url', refused: false };
    }
    const stored = fromStored(await readPref(user, page));
    if (stored) {
        const v = validate(stored, opts);
        if (v.ok) return { scope: v.scope, source: 'saved', refused: false };
    }
    return { scope: {}, source: 'default', refused: false };
}

/** The query string of a scope ('' for all), for links that must keep it. */
function queryOf(scope) {
    const s = scope || {};
    const parts = [];
    if (s.site !== undefined && s.site !== null)
        parts.push('site=' + encodeURIComponent(String(s.site)));
    if (s.department !== undefined && s.department !== null)
        parts.push('department=' + encodeURIComponent(String(s.department)));
    return parts.join('&');
}

/** The KpiService scope of a dashboard scope. */
function kpiScope(viewer, scope) {
    const out = { viewer };
    if (scope && scope.site !== undefined && scope.site !== null) out.siteId = scope.site;
    if (scope && scope.department !== undefined && scope.department !== null)
        out.departmentId = scope.department;
    return out;
}

module.exports = {
    PAGES,
    parseQuery,
    validate,
    options,
    readPref,
    writePref,
    resolve,
    queryOf,
    kpiScope,
    fromStored,
};
