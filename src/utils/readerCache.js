'use strict';

/**
 * readerCache — the per-READER cache of the heavy dashboard models: the first
 * screen, a context tab, the manager's home and the board pack's sections. A
 * large population recomputes every indicator on each open; this keeps the
 * result for one reader, for a few minutes, until anything changes.
 *
 * CONFIDENTIALITY. An entry belongs to ONE reader and ONE clearance. Its
 * identifier is a SHA-256 digest of:
 *   - the reader: user type, id, role, linked employee, sorted permissions;
 *   - the clearance actually resolved for this request: a digest of the ids of
 *     the reader's whole population and of the scoped one (an administrator
 *     whose clearance changed gets a new entry, never the old one);
 *   - the validated scope, the module switches, the capabilities and the
 *     navigation gates the model reads;
 *   - the model name, the tab, its query parameters and the language.
 * Two readers therefore never share an entry, even with the same scope
 * (tests/unit/readerCache.test.js proves it). Entries live in a Map, never in a
 * plain object keyed by request data.
 *
 * FRESHNESS. The cache is dropped:
 *   - on ANY successful write request (POST, PUT, PATCH, DELETE answered below
 *     400): `bustOnWrite` is mounted in server.js before every router, so a
 *     person never reads a figure older than their own last change;
 *   - when the existing dashboard cache is busted (assessment writes, imports:
 *     src/utils/ttlCache.js `dashboardCache.onBust`);
 *   - after DASHBOARD_MODEL_CACHE_TTL_MS (default 5 minutes): the backstop for
 *     changes made outside HTTP (the nightly jobs, a database console).
 * A computation that overlaps a write is not stored. `computedAt(model)` says
 * when a served model was computed, so a page can print it.
 *
 * Every hit is a deep CLONE: a caller that decorates the model can never change
 * what the reader's next request sees. Concurrent identical requests share one
 * computation.
 *
 * Off under NODE_ENV=test unless DASHBOARD_MODEL_CACHE=1 (unit suites feed
 * different mocks through the same calls); DASHBOARD_MODEL_CACHE=0 turns it off.
 */

const crypto = require('crypto');
const { TtlCache, dashboardCache } = require('./ttlCache');

const TTL_MS = Math.max(1000, Number(process.env.DASHBOARD_MODEL_CACHE_TTL_MS) || 300_000);
const MAX_ENTRIES = Math.max(20, Number(process.env.DASHBOARD_MODEL_CACHE_MAX_ENTRIES) || 600);

const store = new TtlCache(TTL_MS, MAX_ENTRIES);
const inflight = new Map();
const stamps = new WeakMap();
let generation = 0;

function enabled() {
    const flag = process.env.DASHBOARD_MODEL_CACHE;
    if (flag === '0') return false;
    if (flag === '1') return true;
    return process.env.NODE_ENV !== 'test';
}

/** Deep clone: plain objects, arrays, Date, Map, Set; functions and class instances by reference. */
function clone(v, seen = new Map()) {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) return seen.get(v);
    if (v instanceof Date) return new Date(v.getTime());
    if (v instanceof Map) {
        const m = new Map();
        seen.set(v, m);
        for (const [k, x] of v) m.set(k, clone(x, seen));
        return m;
    }
    if (v instanceof Set) {
        const s = new Set();
        seen.set(v, s);
        for (const x of v) s.add(clone(x, seen));
        return s;
    }
    if (Array.isArray(v)) {
        const a = new Array(v.length);
        seen.set(v, a);
        for (let i = 0; i < v.length; i++) a[i] = clone(v[i], seen);
        return a;
    }
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return v;
    const o = {};
    seen.set(v, o);
    for (const k of Object.keys(v)) o[k] = clone(v[k], seen);
    return o;
}

/** A stable text of a value: object keys sorted, so equal content gives equal text. */
function canonical(v) {
    if (v === undefined) return '';
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    return (
        '{' +
        Object.keys(v)
            .sort()
            .filter((k) => typeof v[k] !== 'function')
            .map((k) => JSON.stringify(k) + ':' + canonical(v[k]))
            .join(',') +
        '}'
    );
}

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/** The ids of a population, sorted, as one digest (the clearance, not its size). */
function idsDigest(ids) {
    const list = (Array.isArray(ids) ? ids : []).map(Number).sort((a, b) => a - b);
    return digest(list.join(','));
}

/** Everything about the reader that changes what they may see. */
function readerTag(u) {
    if (!u) return 'anonymous';
    const perms = Array.isArray(u.permissions) ? u.permissions.map(String).sort() : [];
    return canonical({
        type: u.userType || '',
        id: u.id === undefined || u.id === null ? '' : String(u.id),
        role: u.role || '',
        employee: u.employeeId === undefined || u.employeeId === null ? '' : String(u.employeeId),
        perms,
    });
}

/**
 * The parts of a dashboard context (DashboardHomeService.context) a model reads:
 * reader, clearance, scope, modules, capabilities, navigation gates.
 */
function contextParts(ctx) {
    const c = ctx || {};
    return {
        reader: readerTag(c.user),
        clearance: idsDigest(c.full && c.full.ids),
        population: idsDigest(c.pop && c.pop.ids),
        scope: canonical(c.scope || null),
        refused: !!c.scopeRefused,
        modules: canonical(c.flags || null),
        caps: canonical(c.caps || null),
        nav: canonical(c.navVisible || null),
    };
}

/** The identifier of one entry: a digest, so its length never depends on the request. */
function entryId(name, parts) {
    return digest(String(name) + '\u0000' + canonical(parts || {}));
}

/**
 * memo(name, parts, compute) → a clone of the model, computed once per entry.
 * `parts` must carry the reader (contextParts does): an entry without a reader
 * is never cached.
 */
async function memo(name, parts, compute) {
    if (!enabled() || !parts || !parts.reader || parts.reader === 'anonymous') return compute();
    const id = entryId(name, parts);
    const hit = store.get(id);
    if (hit !== undefined) return served(hit);
    if (inflight.has(id)) return served(await inflight.get(id));
    const gen = generation;
    const p = (async () => {
        const value = await compute();
        const entry = { value, at: new Date() };
        // a write landed while this was computing: serve it, do not keep it
        if (gen === generation) store.set(id, entry);
        return entry;
    })();
    inflight.set(id, p);
    try {
        return served(await p);
    } finally {
        inflight.delete(id);
    }
}

function served(entry) {
    const out = clone(entry.value);
    if (out && typeof out === 'object') stamps.set(out, entry.at);
    return out;
}

/** When a model served by memo was computed (a Date), or null when not cached. */
function computedAt(model) {
    return (model && typeof model === 'object' && stamps.get(model)) || null;
}

function bust() {
    generation++;
    store.map.clear();
}
if (typeof dashboardCache.onBust === 'function') dashboardCache.onBust(() => bust());

/** Express middleware: a successful write request drops every cached model. */
function bustOnWrite(req, res, next) {
    const m = String(req.method || 'GET').toUpperCase();
    if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return next();
    res.on('finish', () => {
        if (res.statusCode < 400) bust();
    });
    return next();
}

module.exports = {
    memo,
    bust,
    bustOnWrite,
    clone,
    computedAt,
    contextParts,
    readerTag,
    entryId,
    enabled,
    TTL_MS,
    MAX_ENTRIES,
    _store: store,
};
