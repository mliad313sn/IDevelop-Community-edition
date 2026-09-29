'use strict';

/**
 * Closeout of the retired campaign routes (Lot A).
 *
 * Lot A folded the old `/v2/slf/cycles` page and its JSON lifecycle endpoints
 * into the campaign console under `/cycles`. Two things have to stay true at the
 * same time, and neither is self-evident from reading one file:
 *
 *   1. the LEGACY paths still answer **410 Gone** (and the page 301s) — that is
 *      deliberate. A stale bookmark, a cached tab or an old integration must get
 *      a clear "this moved to /cycles", never a silent 404 and never the old
 *      behaviour, which bypassed the audited close;
 *   2. the CANONICAL paths are the ones actually registered on the app router.
 *
 * Pinning only (1) would let a rename empty the console while the legacy door
 * still politely says "moved" to nowhere. Pinning only (2) would let someone
 * delete the 410s and turn every old link into a 404. This file pins BOTH, and
 * the canonical list below is written out longhand ON PURPOSE: it is a contract,
 * not a mirror of the router, so a future rename cannot satisfy it by accident.
 *
 * The legacy half is exercised over real HTTP against the real router — the
 * status code and the body are what a stale client sees, so they are what is
 * asserted, rather than the shape of the source text.
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const http = require('http');
const express = require('express');

const v2slf = require('../../src/routes/v2-slf');
const appRouter = require('../../src/routes/index');

// ---------------------------------------------------------------------------
// A bare app carrying only the retired router. The session/passport/i18n stack
// is replaced by the three things the middleware in the path actually touches,
// so the test measures the ROUTE, not the boot sequence.
// ---------------------------------------------------------------------------
let server;
let base;

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.isAuthenticated = () => true;
        req.user = { id: 1, userType: 'admin', role: 'superadmin', permissions: ['manage_cycles'] };
        req.flash = () => {};
        next();
    });
    app.use('/v2/slf', v2slf);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
});

/** Every route object the app router registers, flattened to "METHOD path". */
function registeredRoutes(router) {
    const out = [];
    (router.stack || []).forEach((layer) => {
        if (!layer.route) return;
        const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
        Object.keys(layer.route.methods)
            .filter((m) => layer.route.methods[m])
            .forEach((m) => paths.forEach((p) => out.push(`${m.toUpperCase()} ${p}`)));
    });
    return out;
}

const APP_ROUTES = registeredRoutes(appRouter);

describe('the legacy campaign paths are GONE, deliberately and loudly', () => {
    // The four the old page posted to. 410 — not 404, not 200, not a redirect:
    // a stale page must be told the door was removed, so it stops retrying.
    const LEGACY_JSON = [
        '/v2/slf/cycles',
        '/v2/slf/cycles/1/open',
        '/v2/slf/cycles/1/lock',
        '/v2/slf/cycles/1/close',
    ];

    test.each(LEGACY_JSON)('POST %s answers 410 Gone and names its successor', async (path) => {
        const r = await fetch(base + path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: 'SHOULD-NEVER-BE-CREATED' }),
        });
        expect(r.status).toBe(410);
        const body = await r.json();
        // A stale caller gets a machine-readable pointer, not a bare status.
        expect(body).toEqual({ ok: false, code: 'moved', error: '/cycles' });
    });

    test('the retired PAGE 301s to the console so a bookmark still lands somewhere useful', async () => {
        const r = await fetch(base + '/v2/slf/cycles', { redirect: 'manual' });
        expect(r.status).toBe(301);
        expect(r.headers.get('location')).toBe('/cycles');
    });

    test('410 is the answer for the write verbs only — the read is a redirect, never a 410', async () => {
        const read = await fetch(base + '/v2/slf/cycles', { redirect: 'manual' });
        expect(read.status).not.toBe(410);
    });

    test('the legacy lifecycle verbs are not quietly re-implemented on the old router', () => {
        // If someone ever re-adds a working handler under /v2/slf, this catches it:
        // the retired router must own exactly one cycles GET (the redirect) and
        // exactly one cycles POST group (the 410).
        const legacy = registeredRoutes(v2slf).filter((r) => r.includes('/cycles'));
        expect(legacy.sort()).toEqual(
            [
                'GET /cycles',
                'POST /cycles',
                'POST /cycles/:id/close',
                'POST /cycles/:id/lock',
                'POST /cycles/:id/open',
            ].sort()
        );
    });
});

describe('the canonical campaign console is the registered one', () => {
    // Written longhand: this is the contract Lot A published. A rename must come
    // here and say so — it cannot pass by renaming the router alone.
    const CANONICAL = [
        'GET /cycles',
        'GET /cycles/new',
        'POST /cycles',
        'GET /cycles/running.json',
        'GET /cycles/:id(\\d+)',
        'GET /cycles/:id(\\d+)/edit',
        'POST /cycles/:id(\\d+)',
        'GET /cycles/:id(\\d+)/export.csv',
        'GET /cycles/:id(\\d+)/roster.json',
        'GET /cycles/:id(\\d+)/relaunch-preview',
        'POST /cycles/:id(\\d+)/relaunch',
        'POST /cycles/:id(\\d+)/reopen',
        'POST /cycles/:id(\\d+)/extend',
        'POST /cycles/:id(\\d+)/lock',
        'POST /cycles/:id(\\d+)/cancel',
        'POST /cycles/:id(\\d+)/close',
        'POST /cycles/:id(\\d+)/participants/exclude-bulk',
        'POST /cycles/:id(\\d+)/participants/:employeeId(\\d+)/exclude',
        'POST /cycles/:id(\\d+)/participants/:employeeId(\\d+)/include',
        'POST /cycles/:id(\\d+)/participants/:employeeId(\\d+)/reviewer',
        'POST /cycles/:id(\\d+)/nudge',
        // ---- SECTION campaign-rules (A5 / A6 / A8) — campaign lifecycle ----
        'POST /cycles/:id(\\d+)/reopen-closed',
        'POST /cycles/:id(\\d+)/closure-proposal/decide',
        'GET /cycles/off-campaign.json',
        'GET /cycles/:id(\\d+)/write-gate.json',
    ];

    test.each(CANONICAL)('%s is registered on the app router', (route) => {
        expect(APP_ROUTES).toContain(route);
    });

    test('the console owns the whole /cycles namespace — no stray extras, no gaps', () => {
        const actual = APP_ROUTES.filter((r) => / \/cycles(\/|$)/.test(r));
        expect(actual.sort()).toEqual([...CANONICAL].sort());
    });

    test('every :id on the console is numeric-constrained (no string id reaches a bigint column)', () => {
        APP_ROUTES.filter((r) => / \/cycles\//.test(r) && r.includes(':')).forEach((r) => {
            // Each parameter segment must carry its \d+ constraint.
            (r.match(/:[A-Za-z]+(\([^)]*\))?/g) || []).forEach((seg) => {
                expect(seg).toMatch(/\(\\d\+\)$/);
            });
        });
    });

    test('the console does NOT answer 410 anywhere — the 410s live only on the retired router', () => {
        const src = require('fs').readFileSync(
            require('path').join(__dirname, '../../src/routes/index.js'),
            'utf8'
        );
        const lotA = src.slice(
            src.indexOf('// ---- SECTION campaigns'),
            src.indexOf('// ---- end SECTION campaigns')
        );
        expect(lotA.length).toBeGreaterThan(500);
        expect(lotA).not.toMatch(/\b410\b/);
    });
});

describe('the two halves stay paired — a rename cannot silently break both', () => {
    // Each retired path and the canonical path that replaced it. If the canonical
    // side is renamed, the 410 becomes a lie; this is where that is caught.
    const SUCCESSION = [
        ['POST /v2/slf/cycles', 'POST /cycles'],
        ['POST /v2/slf/cycles/:id/open', 'POST /cycles/:id(\\d+)/relaunch'],
        ['POST /v2/slf/cycles/:id/lock', 'POST /cycles/:id(\\d+)/lock'],
        ['POST /v2/slf/cycles/:id/close', 'POST /cycles/:id(\\d+)/close'],
        ['GET /v2/slf/cycles', 'GET /cycles'],
    ];

    test.each(SUCCESSION)('%s is retired because %s took it over', (legacy, canonical) => {
        expect(APP_ROUTES).toContain(canonical);
    });

    test('the 410 body points at a path the app actually serves', async () => {
        const r = await fetch(base + '/v2/slf/cycles', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        });
        const body = await r.json();
        expect(APP_ROUTES).toContain(`GET ${body.error}`);
    });
});
