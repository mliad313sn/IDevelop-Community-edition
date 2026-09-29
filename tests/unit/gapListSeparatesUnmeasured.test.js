'use strict';

/**
 * "20 gaps" meant 8 shortfalls and 12 things nobody had looked at.
 *
 * `ContinuityService.scoreRows` is deliberately careful here: it keeps every
 * never-assessed requirement in the gap list — the department-designed set is
 * never hidden — and marks it `current: null`, counting it separately in
 * `unmeasured`. Both consumers then threw that marker away.
 *
 *   * the succession bench rendered `gapSummary.map(g => g.skillName)` as one
 *     undifferentiated list under a column headed "Gaps";
 *   * `LmsService.curationQueue` counted every entry as course demand.
 *
 * Measured on the dev dataset, employee 158 against role 87:
 *     51 of 63 assessed, 20 gap rows = 8 measured shortfalls + 12 unmeasured.
 * The plan owner read "20 gaps" and the curator was asked to source training
 * for twelve shortfalls nobody had observed.
 *
 * A measured shortfall is evidence. An unmeasured requirement is a question.
 * They are now shown, and counted, as different things.
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
const ContinuityService = require('../../src/services/ContinuityService');

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

describe('scoreRows keeps the two kinds of gap distinguishable', () => {
    test('an unmeasured requirement carries current null and is counted apart', () => {
        const out = ContinuityService.scoreRows([
            {
                skillId: 1,
                skillName: 'measured shortfall',
                required: 3,
                current: 1,
                assessedLevel: 1,
            },
            { skillId: 2, skillName: 'measured, met', required: 2, current: 2, assessedLevel: 2 },
            {
                skillId: 3,
                skillName: 'never assessed a',
                required: 3,
                current: null,
                assessedLevel: null,
            },
            {
                skillId: 4,
                skillName: 'never assessed b',
                required: 4,
                current: null,
                assessedLevel: null,
            },
        ]);
        expect(out.assessed).toBe(2);
        expect(out.unmeasured).toBe(2);
        expect(out.required).toBe(4);
        // three "gaps", but only ONE is an observed shortfall
        expect(out.gaps).toHaveLength(3);
        expect(out.gaps.filter((g) => g.current != null)).toHaveLength(1);
        expect(out.gaps.filter((g) => g.current == null)).toHaveLength(2);
    });
});

suite('the real case the committee measured', () => {
    test('employee 158 vs role 87 splits 20 into 8 shortfalls and 12 unknowns', async () => {
        const r = await ContinuityService.readinessForRole(158, 87);
        const gs = r.gaps || [];
        const short = gs.filter((g) => g.current != null);
        expect(gs.length).toBe(20);
        expect(short.length).toBe(8);
        expect(gs.length - short.length).toBe(12);
        expect(r.assessed).toBe(51);
        expect(r.required).toBe(63);
    });
});

describe('both consumers respect the marker', () => {
    test('the bench cell lists only observed shortfalls, and names the rest', () => {
        const view = read('views/pages/continuity/index.ejs');
        expect(view).toMatch(
            /_short\s*=\s*_gs\.filter\(function\(g\)\{return g\.current!=null;\}\)/
        );
        expect(view).toMatch(/_unmeas\s*=\s*_gs\.length-_short\.length/);
        // the old undifferentiated flatten is gone
        expect(view).not.toMatch(
            /const gaps=\(s\.gapSummary\|\|\[\]\)\.map\(function\(g\)\{return g\.skillName;\}\)\.join/
        );
        // and the count is translated, with the placeholder intact
        for (const lang of ['fr', 'en']) {
            const t = JSON.parse(read(`locales/${lang}/talentx.json`));
            expect(t.ct_gaps_unmeasured).toBeTruthy();
            expect(t.ct_gaps_unmeasured).toMatch(/\{n\}/);
        }
    });

    test('course demand counts observed shortfalls only', () => {
        // Load the module, not just its text. The first version of this test
        // read the file as a string and passed happily while the file did not
        // PARSE — a backtick inside the SQL template literal had terminated it,
        // and six unrelated suites went red on module loading instead.
        expect(() => require('../../src/services/LmsService')).not.toThrow();

        const svc = read('src/services/LmsService.js').replace(/\s+/g, ' ');
        expect(svc).toMatch(
            /FROM successors s, jsonb_array_elements\(s\.gap_summary\) g WHERE g->>'current' IS NOT NULL/
        );
    });
});

suite('the SQL predicate really excludes a JSON null', () => {
    test("g->>'current' IS NOT NULL keeps the shortfall and drops the unknowns", async () => {
        const payload = JSON.stringify([
            { skillId: 1, skillName: 'measured shortfall', required: 3, current: 1 },
            { skillId: 2, skillName: 'never assessed a', required: 3, current: null },
            { skillId: 3, skillName: 'never assessed b', required: 4, current: null },
        ]);
        const all = await db.all('SELECT 1 FROM jsonb_array_elements(?::jsonb) g', [payload]);
        const kept = await db.all(
            "SELECT (g->>'skillId') AS sid FROM jsonb_array_elements(?::jsonb) g WHERE g->>'current' IS NOT NULL",
            [payload]
        );
        expect(all).toHaveLength(3); // what it counted before
        expect(kept).toHaveLength(1); // what it counts now
        expect(String(kept[0].sid)).toBe('1');
    });
});
