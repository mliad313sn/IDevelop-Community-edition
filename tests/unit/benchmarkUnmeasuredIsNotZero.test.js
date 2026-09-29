'use strict';

/**
 * Two defects found by the PRODUCT OWNER while reviewing the committee's own work.
 *
 * NEW-2 — the fix that stopped halfway.
 * Lot A corrected `jobs/fit-history.js` so an unassessed role is PERSISTED as
 * NULL rather than 0. But `BenchmarkModel` went on SERVING the fabricated 0, and
 * two views went on printing it. Live, for three Internal Audit roles with 5
 * occupants and ZERO assessments between them against 794 requirements:
 *
 *   /benchmark            "ADÉQUATION CRITIQUE 0%" · "ÉCARTS CRITIQUES 2 / 1 / 2"
 *   /benchmark/role/137   "0% ADÉQUATION" · "1 TITULAIRE AVEC ÉCART CRITIQUE"
 *                         and each of 152 never-measured requirements plotted as level 0
 *   one occupant published with fit 0 and ELEVEN critical gaps
 *
 * while /supervisor/gap-analysis said of the same person: 0 gaps, 0 critical,
 * 152 unmeasured. Two screens, two answers, same human being.
 *
 * Cause in both places: `v_employee_skill_gaps` coalesces an absent level to 0,
 * so `LEAST(actual, required)` is 0 and `actual < required` is true. The model
 * now applies the same `is_assessed` predicate fit-history already used.
 *
 * After the fix (measured live):
 *   roles 137/138/139 -> fit null, criticalFit null, criticalGap 0, measured 0
 *   occupant Ange Bouadi -> fit null, critGap 0   (was fit 0, critGap 11)
 *   measured control UX/UI Designer -> fit 30, coverage 100   (unchanged)
 *
 * NEW-3 — the honesty KPI printed its own denominator backwards.
 * The locale convention is {0}=expected, {1}=assessed. `rdReadBodyAssessedOnly`
 * is called (expected, assessed) and reads correctly; `rdBasedOnAssessed` was
 * called (assessed, expected), so the headline card read
 *   "sur les 3 353 exigences évaluées de 2 476"
 * two lines above its own LECTURE text saying "2 476 ... de 3 353".
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
const BenchmarkModel = HAS_DB ? require('../../src/models/BenchmarkModel') : null;

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

// ---------------------------------------------------------------- NEW-2, model
suite('an unassessed role has no fit, not a fit of zero', () => {
    let rows = null;
    beforeAll(async () => {
        rows = await BenchmarkModel.getFit({});
    });

    test('the fixture we rely on still exists (guards against a vacuous suite)', () => {
        expect(rows.filter((r) => Number(r.coverage) === 0).length).toBeGreaterThan(0);
    });

    test.each(['benchmarkFit', 'criticalFit'])(
        'a role at 0%% coverage reports %s as null',
        async (field) => {
            for (const r of rows.filter((x) => Number(x.coverage) === 0)) {
                expect(r[field]).toBeNull();
            }
        }
    );

    test('it claims no MEASURED critical gap for people nobody assessed', () => {
        for (const r of rows.filter((x) => Number(x.coverage) === 0)) {
            expect(Number(r.occupantsCriticalGap)).toBe(0);
            expect(Number(r.occupantsReady)).toBe(0);
            expect(Number(r.gapPoints)).toBe(0);
        }
    });

    test('it exposes how many occupants were actually measured', () => {
        for (const r of rows.filter((x) => Number(x.coverage) === 0)) {
            expect(Number(r.measuredOccupants)).toBe(0);
        }
    });

    test('a MEASURED role still reports a real fit — the guard did not blank everything', () => {
        const measured = rows.filter((r) => Number(r.coverage) > 0 && r.benchmarkFit != null);
        expect(measured.length).toBeGreaterThan(0);
        for (const r of measured) expect(Number(r.benchmarkFit)).toBeGreaterThanOrEqual(0);
    });
});

suite('an unassessed occupant has no fit and no critical gap', () => {
    test('fit is null and critGap is 0 where coverage is 0', async () => {
        const fit = await BenchmarkModel.getFit({});
        const unmeasured = fit.filter((r) => Number(r.coverage) === 0);
        expect(unmeasured.length).toBeGreaterThan(0);
        for (const role of unmeasured) {
            const { occupants } = await BenchmarkModel.getRoleOccupants(role.roleId, {});
            for (const o of occupants) {
                expect(o.fit).toBeNull();
                expect(Number(o.critGap)).toBe(0);
                expect(Number(o.reqCount)).toBeGreaterThan(0); // they DO have requirements
            }
        }
    });
});

// ----------------------------------------------------------------- NEW-2, views
describe('the benchmark views never print a fabricated zero', () => {
    const index = read('views/pages/benchmark/index.ejs');
    const role = read('views/pages/benchmark/role.ejs');

    test('the list dashes the critical-gap and ready columns when nothing was measured', () => {
        expect(index).toMatch(
            /var measured = f\.measuredOccupants == null \? null : Number\(f\.measuredOccupants\);/
        );
        expect(index).toMatch(/measured === 0\) \{ %><span class="bm-nodata"/);
    });

    test('the drill-through dashes its critical-gap stat too', () => {
        expect(role).toMatch(/rbMeasured === 0 \? '—'/);
    });

    test('an unassessed heat cell shows a dash, not the coalesced 0', () => {
        expect(role).toMatch(/<%= c\.assessed \? c\.actual : '—' %>/);
        expect(role).not.toMatch(/not_assessed_paren'\) %>"><%= c\.actual %><\/td>/);
    });
});

// ----------------------------------------------------------------------- NEW-3
describe('the readiness KPI states its denominator the right way round', () => {
    const js = read('public/js/dashboard.js');
    // The window used to be 320 characters, sized for a one-line call. prettier
    // lays the same call out one argument per line, which pushed grp(never) past
    // the window and turned a pure reformat into a red test. 900 covers the
    // multi-line form with room to spare; the regexes below tolerate whitespace.
    const pick = (needle) => {
        const i = js.indexOf(needle);
        expect(i).toBeGreaterThan(-1);
        return js.slice(i, i + 900);
    };

    test('rdBasedOnAssessed is called (expected, assessed) like its neighbour', () => {
        expect(pick('I18N.rdBasedOnAssessed')).toMatch(
            /grp\(expectedReq\),\s*grp\(assessedReq\),\s*coveragePct/
        );
    });

    test('its inline fallback uses the same {1}-of-{0} convention as the locales', () => {
        expect(pick('I18N.rdBasedOnAssessed')).toMatch(
            /over the \{1\} of \{0\} requirements assessed/
        );
    });

    test('the neighbouring LECTURE line is unchanged, so the two agree', () => {
        expect(pick('I18N.rdReadBodyAssessedOnly')).toMatch(
            /grp\(expected\),\s*grp\(assessed\),\s*coverage,\s*grp\(never\)/
        );
    });

    test('both locales still expect {0}=expected and {1}=assessed', () => {
        // The call site must match the locale, so pin the locale's own order too:
        // if someone "fixes" the placeholders instead, this test says so rather
        // than letting the two corrections cancel each other out.
        for (const lang of ['fr', 'en']) {
            const bag = JSON.parse(read(`locales/${lang}/dash.json`));
            expect(bag.rd_based_on_assessed).toMatch(/\{1\}[^{]*\{0\}/);
            expect(bag.rd_read_body_assessed_only).toMatch(/\{1\}[^{]*\{0\}/);
        }
    });
});
