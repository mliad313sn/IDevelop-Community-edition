'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * AMDEC #2 (criticality 420) and #3 (criticality 405).
 *
 * `supervisor_reviews.gap` is the single number an employee reads to decide
 * whether to contest a review, so it is the last column in the product that may
 * lie. Two defects made it do exactly that, and they compounded:
 *
 *   #3  The row was created AT SUBMIT holding the employee's own rating with
 *       gap = 0 and reviewed_at = now(). Proven by probe: before anyone had
 *       opened the assessment the page already read "Superviseur 1 / Ecart 0"
 *       under a green "d'accord" badge, and showed a review date.
 *   #2  When the supervisor then genuinely disagreed, the V2 workflow wrote the
 *       new supervisor_rated_level but never recomputed `gap`. Proven by probe:
 *       a rating moved 1 -> 3 still stored gap 0 — the employee read agreement
 *       on a divergence of 2.
 *
 * Scoring rationale: G=7 (the employee loses the basis for contesting, and the
 * dispute window closes), O=8 (every review where a supervisor adjusts a rating
 * — the normal case), D=10 (undetectable: a green badge showing 0 looks exactly
 * like genuine agreement).
 *
 * NULL is now the honest value for "not reviewed yet", which is why the three
 * columns became nullable in migration 84.
 */

const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

describe('a review nobody has performed claims nothing (AMDEC #3)', () => {
    const svc = read('src/services/SelfAssessmentService.js');

    test('submit inserts no supervisor rating and no gap', () => {
        expect(svc).toMatch(/VALUES \(\?, \?, \?, NULL, NULL, \?, 'pending'\)/);
    });

    test('re-submitting after changes_requested clears the stale rating, gap and date', () => {
        // The previous supervisor rating judged an answer the employee has since
        // changed; carrying it forward would re-assert a verdict nobody gave.
        expect(svc).toMatch(/supervisor_rated_level = NULL, gap = NULL, reviewed_at = NULL/);
    });

    test('the migration makes the three columns nullable and clears fabricated rows', () => {
        const mig = read('db/postgres/84_supervisor_review_gap_integrity.sql');
        expect(mig).toMatch(/ALTER COLUMN supervisor_rated_level DROP NOT NULL/);
        expect(mig).toMatch(/ALTER COLUMN gap DROP NOT NULL/);
        expect(mig).toMatch(/ALTER COLUMN reviewed_at DROP NOT NULL/);
        expect(mig).toMatch(/ALTER COLUMN reviewed_at DROP DEFAULT/);
        expect(mig).toMatch(/WHERE status = 'pending' AND decision IS NULL/);
    });
});

describe('the gap is recomputed on every finalisation (AMDEC #2)', () => {
    const wf = read('src/services/SelfAssessmentWorkflowService.js');

    test('the finalisation reads the self rating before writing', () => {
        expect(wf).toMatch(/sa\.self_rated_level AS "selfLevel"/);
    });

    test('the gap is derived from the two ratings, never left untouched', () => {
        expect(wf).toMatch(/finalLevel - Number\(row\.selfLevel\)/);
        expect(wf).toMatch(/supervisor_rated_level = \?, gap = \?/);
    });

    test('an omitted rating resolves to the self rating (a real agreement)', () => {
        // Validating without changing anything IS agreement — gap 0 is then
        // truthful, unlike the gap 0 that used to be written at submit time.
        //
        // SECTION accounts / B2 narrowed this: a REJECTION is not an agreement, so the
        // fall-through to the self-rating is now conditional on the decision.
        // The agreement case itself is unchanged and is asserted BEHAVIOURALLY
        // (approve with no level → level = self, gap = 0) in
        // tests/unit/rejectionIsNotAValidation.test.js.
        expect(wf).toMatch(/row\.currentLevel != null/);
        // The RULE, not its punctuation: prettier reflows this into a nested
        // ternary chain and drops the parentheses the old pattern demanded
        // (`: isReject` / `? null` / `: Number(row.selfLevel)` on three lines).
        // What must hold is that a rejection yields null and anything else falls
        // through to the self rating.
        expect(wf).toMatch(/isReject\s*\?\s*null\s*:\s*Number\(row\.selfLevel\)/);
    });

    test('the review date is stamped at decision time, not at submit time', () => {
        expect(wf).toMatch(/reviewed_at = COALESCE\(reviewed_at, now\(\)\)/);
    });

    test('a missing review row is a no-op, not a crash', () => {
        // The no-supervisor admin-queue path legitimately has no row.
        expect(wf).toMatch(/if \(!row\) return;/);
    });

    test('the gap is written on the admin path too, not only when a reviewer is recorded', () => {
        // The old code had two divergent UPDATEs; the level (and so the gap) was
        // optional in both. There must now be ONE statement that always sets it.
        const updates =
            wf.match(/SET decision = \?, recommendation = \?, status = 'completed'/g) || [];
        expect(updates).toHaveLength(1);
    });
});

describe('no surface renders a verdict that does not exist', () => {
    test('the employee page shows "pending", not a green zero, when the gap is unknown', () => {
        const view = read('views/pages/employee/supervisor-reviews.ejs');
        expect(view).toMatch(
            /srReviewed = review\.supervisorRatedLevel != null && review\.gap != null/
        );
        expect(view).toMatch(/if \(!srReviewed\)/);
        // The success badge must be reachable only after the pending branch.
        expect(view.indexOf('if (!srReviewed)')).toBeLessThan(view.indexOf('badge-success">0<'));
    });

    test('the supervisor form cannot silently default to the lowest rating', () => {
        // With no rating stored, a `required` select whose first option is "0"
        // pre-selects 0 — submitting the worst level as if it were a decision.
        const view = read('views/pages/supervisor/review.ejs');
        expect(view).toMatch(
            /<option value="" <%= review\.supervisorRatedLevel == null \? 'selected' : '' %> disabled>/
        );
        expect(view).toMatch(/if \(supervisorRatingSelect\.value === ''\)/);
    });

    test('the live gap preview does not print NaN before a rating is chosen', () => {
        const view = read('views/pages/supervisor/review.ejs');
        // The guard has since gained a second arm (constat 4): a review whose
        // judged round carries NO self-rating now yields `selfRating === null`
        // and short-circuits here too, instead of computing a gap against zero.
        // Assert the NaN arm is still the FIRST condition, and leave the rest open.
        expect(view).toMatch(/if \(Number\.isNaN\(supervisorRating\)/);
        expect(view).toMatch(/selfRating === null/);
    });

    test('the pending explanation exists in both languages', () => {
        for (const lang of ['fr', 'en']) {
            const emp = JSON.parse(read(`locales/${lang}/employee.json`));
            const tx = JSON.parse(read(`locales/${lang}/talentx.json`));
            expect(typeof emp.sr_gap_pending_title).toBe('string');
            expect(emp.sr_gap_pending_title.length).toBeGreaterThan(0);
            expect(typeof tx.rv_choose_rating).toBe('string');
            expect(tx.rv_choose_rating.length).toBeGreaterThan(0);
        }
    });
});
