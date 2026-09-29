'use strict';
/**
 * THE DISPUTE LADDER, BUILT ON THE SAME VIEW — AND ON ONE REUSED COLUMN.
 *
 * Two independent defects of the same file, both measured by execution on a
 * development database inside a rolled-back transaction.
 *
 * (1) P2-13 / P2-12 — THE REPLACED ROUND.
 *     `self_assessments` is a VIEW over `self_assessment_rounds WHERE
 *     superseded_at IS NULL` (migration 113), while
 *     `supervisor_reviews.self_assessment_id` points at ONE round. Both dispute
 *     lists LEFT JOINed the view, so as soon as the person was asked again:
 *       - the manager's decision screen showed « Auto » as an EMPTY cell next
 *         to « Superviseur 3 », and
 *       - the employee's page showed « Votre note » empty — not even a « — » —
 *         next to the reviewer's 3.
 *     The measurement existed the whole time (round 223929, self_rated_level 3).
 *     House rule 11 inverted: an existing measurement presented as missing, on
 *     the very screen where a gap is arbitrated.
 *     `_applyDecisionToReview` had it worse: an UPDATE ... FROM the view matched
 *     ZERO rows, so the dispute was recorded 'resolved' with its decided rating
 *     and the OFFICIAL skill level was changed, while the review it decided kept
 *     the pre-dispute level, a stale gap and status 'disputed'. Measured:
 *       review 1023 (replaced round) → rowCount 0
 *       control review on a current round → 1
 *       same statement on self_assessment_rounds → 1
 *     After the fix, resolveL0(rating 2) on review 1023 wrote
 *       {"status":"completed","supervisorRatedLevel":2,"gap":-1}   (2 − 3)
 *
 * (2) P2-11 — THE EMPLOYEE'S OWN WORDS, OVERWRITTEN.
 *     `assessment_disputes.reason NOT NULL` is written ONCE, by the EMPLOYEE,
 *     when they open the dispute. All three resolve paths then did `reason = ?`
 *     with the DECIDER's note. Measured: open with « ma preuve de formation n a
 *     pas ete lue » → resolveL0 with « niveau maintenu a 2, preuve jugee
 *     insuffisante » → the employee's sentence was GONE, and a sweep of every
 *     text/varchar/json(b) column of the schema found no other copy. Neither L0
 *     nor L1 wrote a system_logs row either. And the employee's page renders
 *     `dispute.reason` only in the 'resolved' branch, unlabelled, under « Note
 *     finale » — so what survived read as if the employee had written it.
 *     Destruction doubled with misattribution. House rule: a resolution is a
 *     STATE plus a MOTIVE, never a deletion.
 *
 * These tests prevent both from coming back: no dispute read or write may
 * address the view again, and no resolve path may assign `reason` rather than
 * append to it.
 */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'services', 'DisputeServiceV2.js'),
    'utf8'
);
// Statement bodies only — the file's comments name the view on purpose.
const SQL = SRC.replace(/^\s*(\/\*[\s\S]*?\*\/|\/\/.*)$/gm, '').replace(/^\s*\*.*$/gm, '');

describe('the dispute path addresses the round the review judged', () => {
    test('no statement reads or writes the self_assessments VIEW', () => {
        expect(SQL).not.toMatch(/\bFROM self_assessments\b/);
        expect(SQL).not.toMatch(/\bJOIN self_assessments\b/);
        expect(SQL).not.toMatch(/\bUPDATE self_assessments\b/);
    });

    test('the decision is written onto the review through the rounds table', () => {
        const helper = SRC.slice(
            SRC.indexOf('static async _applyDecisionToReview('),
            SRC.indexOf('static async _applyDecidedRatingToSkill(')
        );
        expect(helper).toMatch(/FROM self_assessment_rounds sa/);
        expect(helper).toMatch(/sa\.id = sr\.self_assessment_id/);
    });

    test('a decision that lands on NO row is observable to the caller', () => {
        // It silently changed nothing for every replaced round; the helper now
        // reports what it touched so a caller can never assume it applied.
        const helper = SRC.slice(
            SRC.indexOf('static async _applyDecisionToReview('),
            SRC.indexOf('static async _applyDecidedRatingToSkill(')
        );
        expect(helper).toMatch(/return changes;/);
    });

    test('both dispute lists join the rounds table and carry superseded_at', () => {
        for (const name of ['listForManager', 'listForEmployee']) {
            const start = SRC.indexOf('static async ' + name + '(');
            expect(start).toBeGreaterThan(-1);
            const body = SRC.slice(start, start + 1600);
            expect(body).toMatch(
                /LEFT JOIN self_assessment_rounds sa ON sa\.id = sr\.self_assessment_id/
            );
            expect(body).toMatch(/sa\.superseded_at/);
        }
    });

    test('the five locked_state writes target the rounds table', () => {
        const writes = SQL.match(/UPDATE self_assessment_rounds sa/g) || [];
        expect(writes.length).toBe(5);
    });
});

describe("the employee's motive is never overwritten by the decider's note", () => {
    const resolvers = ['resolveL2', 'resolveL1', 'resolveL0'];

    test.each(resolvers)('%s never assigns reason, and labels what it appends', (name) => {
        const level = name.replace('resolve', '');
        const start = SRC.indexOf('static async ' + name + '(');
        expect(start).toBeGreaterThan(-1);
        const body = SRC.slice(start, start + 1400);
        const update = body.slice(body.indexOf('UPDATE assessment_disputes'));
        expect(update).not.toMatch(/\breason = \?/);
        expect(update).toContain(`appendResolutionNote('${level}')`);
    });

    test('the one helper the three share appends, it does not assign', () => {
        const helper = SRC.slice(
            SRC.indexOf('function appendResolutionNote(level)'),
            SRC.indexOf('class DisputeServiceV2')
        );
        expect(helper).toMatch(/reason = COALESCE\(reason, ''\)/);
        expect(helper).toMatch(/\[resolution:\$\{level\}\]/);
    });

    test('nowhere in the file is reason assigned from a parameter', () => {
        expect(SQL).not.toMatch(/\breason = \?/);
    });

    test('the marker is built in SQL, so the note is stored byte-for-byte', () => {
        // Building it in JS would mean the decider's text is concatenated before
        // it reaches the driver — and a note containing the marker would then be
        // indistinguishable from the marker itself.
        expect(SRC).toMatch(/function appendResolutionNote\(level\)/);
        expect(SRC).toMatch(/\|\| \?`;/);
    });

    test('the decider is still recorded on the row, not laundered into the text', () => {
        for (const name of ['resolveL1', 'resolveL0']) {
            const start = SRC.indexOf('static async ' + name + '(');
            expect(SRC.slice(start, start + 1400)).toMatch(/decided_by = \?/);
        }
        expect(
            SRC.slice(
                SRC.indexOf('static async resolveL2('),
                SRC.indexOf('static async resolveL1(')
            )
        ).toMatch(/decided_by_admin_id = \?/);
    });
});
