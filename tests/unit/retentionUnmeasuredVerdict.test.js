'use strict';

/**
 * Retention risk published a verdict about people nobody had ever judged.
 *
 * `impact_of_loss` is derived ENTIRELY from a 9-box placement. With no
 * placement, `_signals` left `impactScore` at its initialiser — 0 — and 0 bands
 * as 'low'. So an employee with no placement of any kind was stored with
 * exactly the verdict of a measured Concern:
 *
 *     impact_of_loss = 'low', computed_score = 0
 *
 * "Losing this person costs little", derived from the fact that nobody has said
 * anything about them. On idevelop that was 73 of the 78 stored rows, and
 * `jobs/retention-recompute.js` runs nightly over the whole active population,
 * so the row exists for everyone whether or not anything was measured.
 *
 * The column was NOT NULL over a three-value enum, leaving no way to say
 * "unknown"; migration 135 relaxes that (one statement — the runner can stamp a
 * multi-statement file as applied after a partial failure).
 *
 * Verified on idevelop after the change:
 *   never placed -> impactBand null, impactScore null, computedScore null
 *   placed (151) -> impactBand 'medium', impactScore 30, computedScore 65
 *
 * NOT changed, deliberately: the band cuts (40/20) against the scores the
 * function can emit ({0,15,30,50}). The cuts sit in gaps, which is untidy, but
 * they produce the intended mapping — 50 high, 30 medium, 15 low. Whether a
 * medium-medium "Critical Contributor" OUGHT to rate above 'low' impact of loss
 * is a talent-design judgement about real people's ratings, not a code defect,
 * and is left to the product owner rather than silently re-banded here.
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
const RetentionRiskService = HAS_DB ? require('../../src/services/RetentionRiskService') : null;

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

suite('an unplaced employee gets no verdict, not a favourable one', () => {
    let unplacedId = null;
    let placedId = null;

    beforeAll(async () => {
        const u = await db.get(
            `SELECT e.id FROM employees e
              WHERE e.is_active = true
                AND NOT EXISTS (SELECT 1 FROM nine_box_evaluations n
                                 WHERE n.employee_id = e.id AND n.status = 'approved')
                AND NOT EXISTS (SELECT 1 FROM talent_placements p WHERE p.employee_id = e.id)
              LIMIT 1`
        );
        const p = await db.get(
            "SELECT employee_id AS id FROM nine_box_evaluations WHERE status = 'approved' LIMIT 1"
        );
        unplacedId = u && u.id;
        placedId = p && p.id;
    });

    test('the fixture we rely on still exists (guards against a vacuous suite)', () => {
        expect(unplacedId).toBeTruthy();
        expect(placedId).toBeTruthy();
    });

    test('no placement -> impact band, impact score and total are all null', async () => {
        const s = await RetentionRiskService._signals(unplacedId);
        expect(s.impactBand).toBeNull();
        expect(s.impactScore).toBeNull();
        expect(s.computedScore).toBeNull(); // a total cannot include an unknown
        expect(s.factors.impactMeasured).toBe(false);
    });

    test('flight risk is measured only when there is a flight signal', async () => {
        // Superseded by re-audit T3: this used to assert flight is ALWAYS
        // banded, which was the fabrication (flightScore 0 → "low" for someone
        // with no placement, no active PIP and no survey answer). Flight is a
        // band only when a real signal exists; otherwise it is null, like
        // impact. `unplacedId` has no placement — whether it has a PIP/survey
        // decides, so assert the invariant that ties the two together rather
        // than a fixed value.
        const s = await RetentionRiskService._signals(unplacedId);
        const hasSignal =
            s.factors.activePip === true ||
            s.factors.engagement != null ||
            s.factors.nineBox != null;
        if (hasSignal) {
            expect(['low', 'medium', 'high']).toContain(s.flightBand);
            expect(typeof s.flightScore).toBe('number');
        } else {
            expect(s.flightBand).toBeNull();
            expect(s.flightScore).toBeNull();
        }
    });

    test('a placed employee is unaffected', async () => {
        const s = await RetentionRiskService._signals(placedId);
        expect(s.factors.impactMeasured).toBe(true);
        expect(['low', 'medium', 'high']).toContain(s.impactBand);
        expect(typeof s.impactScore).toBe('number');
        expect(s.computedScore).toBe(s.impactScore + s.flightScore);
    });

    test('the column really accepts the null (migration 135 applied)', async () => {
        const col = await db.get(
            `SELECT is_nullable FROM information_schema.columns
              WHERE table_name = 'retention_risk' AND column_name = 'impact_of_loss'`
        );
        expect(col.isNullable).toBe('YES');
    });

    test('the write path stores it, and rolls back cleanly', async () => {
        const before = await db.get(
            'SELECT impact_of_loss, computed_score FROM retention_risk WHERE employee_id = ?',
            [unplacedId]
        );
        try {
            await db.runTransaction(async () => {
                const row = await RetentionRiskService.computeFor(unplacedId);
                expect(row.impactOfLoss).toBeNull();
                expect(row.computedScore).toBeNull();
                throw new Error('__ROLLBACK__');
            });
        } catch (e) {
            if (!String(e.message).includes('__ROLLBACK__')) throw e;
        }
        const after = await db.get(
            'SELECT impact_of_loss, computed_score FROM retention_risk WHERE employee_id = ?',
            [unplacedId]
        );
        expect(after).toEqual(before);
    });
});

describe('the continuity page escapes what people typed, and dashes the unknown', () => {
    const view = read('views/pages/continuity/index.ejs');

    test('an escaper exists and every innerHTML row builder uses it', () => {
        expect(view).toMatch(/const esc = \(s\) =>/);
        // employee names, and the free text of a handover item
        expect(view).toMatch(/esc\(r\.firstName\s*\|\|\s*''\)/);
        expect(view).toMatch(/esc\(s\.firstName\s*\|\|\s*''\)/);
        expect(view).toMatch(/esc\(it\.title\)/);
        expect(view).toMatch(/esc\(it\.detail\)/);
        expect(view).toMatch(/esc\(e\.name\)/);
    });

    test('no raw user value is left interpolated into innerHTML', () => {
        expect(view).not.toMatch(/\+\(r\.firstName\|\|''\)\+/);
        expect(view).not.toMatch(/'<strong>'\+it\.title\+'<\/strong>'/);
        expect(view).not.toMatch(/'<option value="'\+e\.id\+'">'\+e\.name\+/);
    });

    test('a null band renders as a dash, never the word null or a risk- class', () => {
        expect(view).toMatch(/const band = \(v\) =>/);
        expect(view).toMatch(/v == null/);
        expect(view).toMatch(/risk-unknown/);
        // the old direct interpolation is gone
        expect(view).not.toMatch(/class="risk risk-'\+r\.impactOfLoss\+'"/);
        expect(view).not.toMatch(/class="risk risk-'\+r\.flightRisk\+'"/);
        // and the unknown badge is styled so it cannot read as a green pass
        expect(view).toMatch(/\.risk-unknown\{background:transparent/);
    });
});
