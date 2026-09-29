'use strict';

/**
 * Tiny in-memory TTL cache for hot read endpoints (executive dashboard).
 * Single-process by design (matches the app's deployment model). Entries are
 * keyed by caller identity + URL so RBAC-scoped responses never leak across
 * users. bust drops everything — call it after writes that change the
 * underlying aggregates (assessments, imports).
 */
class TtlCache {
    constructor(ttlMs = 30_000, maxEntries = 500) {
        this.ttlMs = ttlMs;
        this.maxEntries = maxEntries;
        this.map = new Map(); // key -> { value, expires }  (insertion order = recency)
        // Diagnostics only — never used to make a caching decision.
        this.stats = { hits: 0, misses: 0, expired: 0, evictions: 0 };
    }

    get(key) {
        const e = this.map.get(key);
        if (!e) {
            this.stats.misses++;
            return undefined;
        }
        if (Date.now() > e.expires) {
            this.map.delete(key);
            this.stats.expired++;
            this.stats.misses++;
            return undefined;
        }
        // LRU, not FIFO. Eviction drops the FIRST key in insertion order, so a
        // hit has to move its key to the end or the cache has no notion of
        // recency at all: with N users x M dashboard endpoints all inserting,
        // a pure FIFO evicts the entry that is being read every second just as
        // readily as one nobody has touched since it was written, and the hit
        // rate collapses precisely when the cache matters most. Re-inserting is
        // O(1) on a Map and preserves `expires` — a hit does NOT extend the
        // TTL, so the staleness bound is unchanged.
        this.map.delete(key);
        this.map.set(key, e);
        this.stats.hits++;
        return e.value;
    }

    set(key, value) {
        // delete-then-set so an overwrite also refreshes recency position.
        this.map.delete(key);
        while (this.map.size >= this.maxEntries) {
            // drop the least recently used entry (Map preserves insertion order)
            const first = this.map.keys().next().value;
            if (first === undefined) break;
            this.map.delete(first);
            this.stats.evictions++;
        }
        this.map.set(key, { value, expires: Date.now() + this.ttlMs });
    }

    /**
     * Register a fan-out hook run on every bust. Lets a second cache built on
     * the same data (e.g. DashboardService's scope-keyed executive cache) share
     * ONE invalidation point, so a write path can never clear one and forget
     * the other. A throwing hook is swallowed: invalidation must never be the
     * thing that fails a write.
     */
    onBust(fn) {
        if (typeof fn === 'function') (this._bustHooks || (this._bustHooks = [])).push(fn);
        return this;
    }

    bust() {
        this.map.clear();
        for (const fn of this._bustHooks || []) {
            try {
                fn();
            } catch {
                /* never block a write */
            }
        }
    }
}

// SIZING. Keys here are `userType:userId:originalUrl` — one entry per user PER
// ENDPOINT. public/js/dashboard.js fetches 17 DISTINCT endpoints (22 named
// fetchAPI call sites) on one dashboard load, so a 500-slot cache is saturated
// by ~30 concurrent users and from there on every additional user evicts an entry
// somebody else is actively reading. At 4 000 employees / ~200 concurrent
// managers the working set is ~3 400 keys and the hit rate collapses to
// nothing — while each miss costs seconds (see scripts/loadtest-readiness.js).
//
// Entries are single-endpoint JSON aggregates: the ENTIRE executive payload
// (seven aggregates plus provenance) measured 10.7 KB on the the dev dataset org shape,
// and an individual endpoint is a fraction of that. 4 000 entries is therefore
// single-digit MB, and the size is driven by the count of sites / departments /
// roles, not by headcount. Override with DASHBOARD_CACHE_MAX_ENTRIES.
const dashboardCache = new TtlCache(
    30_000,
    Math.max(50, Number(process.env.DASHBOARD_CACHE_MAX_ENTRIES) || 4000)
);

// Single-flight registry: key -> Promise<body> for an in-flight computation. Lets
// concurrent identical requests share ONE computation instead of all recomputing
// when an entry is cold/expired (cache-stampede protection). Keys already encode the
// caller identity, so a shared body is always within the same RBAC scope.
const pending = new Map();

/**
 * Express middleware: serve cached JSON for GETs, coalesce concurrent misses, and
 * capture res.json to populate the cache. Mount BEFORE the routes it should cover.
 */
function dashboardCacheMiddleware(req, res, next) {
    if (req.method !== 'GET' || !req.user) return next();
    const key = `${req.user.userType || 'admin'}:${req.user.id}:${req.originalUrl}`;
    const hit = dashboardCache.get(key);
    if (hit !== undefined) {
        res.set('X-Cache', 'HIT');
        return res.json(hit);
    }

    // Coalesce: if an identical request is already computing, await its result.
    const inflight = pending.get(key);
    if (inflight) {
        res.set('X-Cache', 'COALESCED');
        inflight.then(
            (body) => {
                if (!res.headersSent) res.json(body);
            },
            () => next() // leader failed/aborted — compute ourselves
        );
        return;
    }

    let resolveBody = () => {};
    let rejectBody = () => {};
    const p = new Promise((resolve, reject) => {
        resolveBody = resolve;
        rejectBody = reject;
    });
    p.catch(() => {}); // avoid unhandledRejection when no waiter is attached
    pending.set(key, p);
    const clear = () => {
        if (pending.get(key) === p) pending.delete(key);
    };
    res.on('close', () => {
        rejectBody(new Error('aborted'));
        clear();
    });

    const origJson = res.json.bind(res);
    res.json = (body) => {
        if (res.statusCode === 200) {
            dashboardCache.set(key, body);
            resolveBody(body);
        } else {
            rejectBody(new Error('non-200'));
        }
        clear();
        res.set('X-Cache', 'MISS');
        return origJson(body);
    };
    next();
}

module.exports = { TtlCache, dashboardCache, dashboardCacheMiddleware };
