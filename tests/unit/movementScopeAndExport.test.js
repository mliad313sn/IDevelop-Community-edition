'use strict';

/**
 * The movements page reported one set of numbers above a table showing another,
 * and its CSV quietly shipped a fraction of the rows.
 *
 * (25) `feed` applied stream / kind / site / department / search;
 *      `summary` applied only the time window and the RBAC scope. Filtering the
 *      page to a site therefore left the KPI strip reporting the whole
 *      organisation — the committee measured 215 movements in the strip above a
 *      table showing 8.
 *
 * (26) `exportCsv` forced `limit = 500` under a doc comment promising "exactly
 *      what the page shows — same scope, same filters". On a 365-day window
 *      with 3068 matching rows it shipped 500 and said nothing, so a
 *      reconciliation done from that file was wrong AND looked complete.
 *      Measured: 500 of 3068 before, 3068 after.
 *
 * Both now build their row set through one shared `_scope`, so the strip and
 * the table cannot describe different populations again.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const fs = require('fs');
const ROOT = path.join(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// Needs a POPULATED database (several sites, assessed people, reviews): runs
// only against an opt-in fixture database — see CONTRIBUTING.md.
const HAS_DB = /idevelop_fixtures/.test(String(process.env.DATABASE_URL || ''));
const suite = HAS_DB ? describe : describe.skip;
const db = HAS_DB ? require('../../src/config/database') : null;
const MovementService = require('../../src/services/MovementService');

const USER = { id: 1, userType: 'admin', role: 'superadmin' };

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

suite('the KPI strip counts the same rows the table lists', () => {
    const agree = async (opts) => {
        const [summary, feed] = await Promise.all([
            MovementService.summary(USER, opts),
            MovementService.feed(USER, { ...opts, limit: MovementService.MAX_ROWS }),
        ]);
        return {
            strip: Number(summary.movements),
            table: feed.filter((r) => r.stream === 'movement').length,
        };
    };

    test('the fixture we rely on still exists (guards against a vacuous suite)', async () => {
        const n = await db.get(
            "SELECT COUNT(*)::int AS n FROM v_movement_feed WHERE occurred_at >= now() - INTERVAL '365 days'"
        );
        expect(Number(n.n)).toBeGreaterThan(0);
    });

    test('unfiltered', async () => {
        const r = await agree({ days: 30 });
        expect(r.strip).toBe(r.table);
    });

    test('scoped to one site', async () => {
        const site = await db.get(
            'SELECT DISTINCT site_name AS n FROM v_movement_feed WHERE site_name IS NOT NULL LIMIT 1'
        );
        const r = await agree({ days: 365, siteName: site.n });
        expect(r.strip).toBe(r.table);
    });

    test('scoped to one stream', async () => {
        const r = await agree({ days: 365, stream: 'movement' });
        expect(r.strip).toBe(r.table);
    });

    test('a filter that matches nothing reports nothing, not everything', async () => {
        const r = await agree({ days: 365, siteName: '__no_such_site__' });
        expect(r.strip).toBe(0);
        expect(r.table).toBe(0);
    });
});

suite('the export ships what the filter matched', () => {
    test('a window larger than the old cap is no longer truncated', async () => {
        const total = await db.get(
            "SELECT COUNT(*)::int AS n FROM v_movement_feed WHERE occurred_at >= now() - INTERVAL '365 days'"
        );
        // the fixture must actually exceed the old cap, or this proves nothing
        expect(Number(total.n)).toBeGreaterThan(500);

        const capped = await MovementService.feed(USER, { days: 365, limit: 500 });
        const full = await MovementService.feed(USER, {
            days: 365,
            limit: MovementService.MAX_ROWS,
        });
        expect(capped).toHaveLength(500); // what it used to send
        expect(full).toHaveLength(Number(total.n)); // what it sends now
    });
});

describe('the two surfaces share one definition of the row set', () => {
    const svc = read('src/services/MovementService.js').replace(/\s+/g, ' ');
    const ctrl = read('src/controllers/MovementController.js').replace(/\s+/g, ' ');

    test('both feed and summary go through _scope', () => {
        expect((svc.match(/this\._scope\(ids, opts\)/g) || []).length).toBe(2);
        // Exactly one function may still build a scope from ids alone:
        // filterOptions, which populates the filter dropdowns and must NOT
        // apply the site filter — doing so would collapse the list to whatever
        // is already selected. Count it rather than forbidding the shape.
        expect((svc.match(/const scope = Array\.isArray\(ids\)/g) || []).length).toBe(1);
        const optionsBody = svc.slice(svc.indexOf('async filterOptions'));
        expect(optionsBody).toMatch(/const scope = Array\.isArray\(ids\)/);
    });

    test('the export asks for everything, not a hard 500', () => {
        expect(ctrl).toMatch(/filters\.limit = MovementService\.MAX_ROWS/);
        expect(ctrl).not.toMatch(/filters\.limit = 500/);
        expect(MovementService.MAX_ROWS).toBeGreaterThan(500);
    });

    test('the export still neutralises formula injection', () => {
        // csvCell, not a private quote-doubler — a name starting with = + - @
        // would otherwise execute when the file is opened.
        expect(ctrl).toMatch(/const esc = csvCell/);
    });
});
