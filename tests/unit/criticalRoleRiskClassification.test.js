'use strict';

/**
 * Every critical-role row said the same thing: "RISK".
 *
 * `renderCriticalRolesTable` sorts roles into VACANT / NO CAPABILITY / 1 ONLY /
 * LOW DEPTH by comparing `headcount` and `qualifiedCount` with `===` against
 * numbers. Those columns are COUNT() and SUM() — bigint — and the pg driver
 * returns bigint as a STRING to preserve precision. `"0" === 0` is false, so
 * every branch missed and all 23 rows fell through to the generic badge.
 *
 * Measured on the dev dataset before the fix: 23 rows, 0 classified.
 * After: 10 NO CAPABILITY, 11 single-point-of-failure, 2 LOW DEPTH.
 *
 * A reader could see that 23 critical roles were at risk but not WHICH KIND —
 * and the four kinds call for opposite responses: recruit, train, hire a
 * second person, or deepen the bench.
 *
 * Fixed at both ends: the model casts to ::int (so every consumer gets a
 * number), and the renderer coerces with Number() so it does not depend on
 * driver typing holding.
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
const DashboardModel = HAS_DB ? require('../../src/models/DashboardModel') : null;

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

// The classifier, transcribed from renderCriticalRolesTable. Kept here so the
// branch logic can be exercised over both the real rows and the string shape
// the driver used to hand over.
const classify = (r) => {
    const headcount = Number(r.headcount);
    const qualifiedCount = Number(r.qualifiedCount);
    if (headcount === 0) return 'VACANT';
    if (qualifiedCount === 0) return 'NO CAPABILITY';
    if (headcount === 1 && qualifiedCount === 1) return '1 ONLY';
    if (headcount > 1 && qualifiedCount === 1) return 'LOW DEPTH';
    return 'RISK';
};

suite('critical-role rows arrive as numbers and classify', () => {
    let rows = null;
    beforeAll(async () => {
        rows = await DashboardModel.getCriticalRolesDetail({});
    });

    test('the fixture we rely on still exists (guards against a vacuous suite)', () => {
        expect(rows.length).toBeGreaterThan(0);
    });

    test('the model returns numbers, not bigint-as-string', () => {
        for (const r of rows) {
            expect(typeof r.headcount).toBe('number');
            expect(typeof r.qualifiedCount).toBe('number');
            expect(typeof r.measuredCount).toBe('number');
        }
    });

    test('no row falls through to the generic badge', () => {
        const generic = rows.filter((r) => classify(r) === 'RISK');
        expect(generic).toEqual([]);
    });

    test('the four kinds are actually distinguished', () => {
        const kinds = new Set(rows.map(classify));
        // Before the fix this set was exactly {'RISK'}.
        expect(kinds.has('RISK')).toBe(false);
        expect(kinds.size).toBeGreaterThan(1);
    });
});

describe('the classifier survives a string-typed row anyway', () => {
    test('strings classify identically to numbers', () => {
        const cases = [
            [{ headcount: 0, qualifiedCount: 0 }, 'VACANT'],
            [{ headcount: 2, qualifiedCount: 0 }, 'NO CAPABILITY'],
            [{ headcount: 1, qualifiedCount: 1 }, '1 ONLY'],
            [{ headcount: 4, qualifiedCount: 1 }, 'LOW DEPTH'],
            [{ headcount: 4, qualifiedCount: 3 }, 'RISK'],
        ];
        for (const [row, expected] of cases) {
            expect(classify(row)).toBe(expected);
            // the same row as the driver used to deliver it
            expect(
                classify({
                    headcount: String(row.headcount),
                    qualifiedCount: String(row.qualifiedCount),
                })
            ).toBe(expected);
        }
    });

    test('a strict === against the raw field would have missed every branch', () => {
        // Demonstrates the actual defect rather than asserting it in prose.
        const raw = { headcount: '0', qualifiedCount: '0' };
        expect(raw.headcount === 0).toBe(false);
        expect(raw.qualifiedCount === 0).toBe(false);
        expect(classify(raw)).toBe('VACANT');
    });
});

describe('both ends of the fix are in place', () => {
    test('the model casts the counts to int', () => {
        const m = read('src/models/DashboardModel.js').replace(/\s+/g, ' ');
        expect(m).toMatch(/COUNT\(e\.employeeId\)::int as headcount/);
        expect(m).toMatch(/END\)::int as qualifiedCount/);
    });

    test('the renderer coerces before comparing', () => {
        const js = read('public/js/dashboard.js').replace(/\s+/g, ' ');
        expect(js).toMatch(/const headcount = Number\(r\.headcount\)/);
        expect(js).toMatch(/const qualifiedCount = Number\(r\.qualifiedCount\)/);
        // and no branch still reads the raw field
        expect(js).not.toMatch(/if \(r\.headcount === 0\)/);
        expect(js).not.toMatch(/r\.qualifiedCount === 0/);
    });
});
