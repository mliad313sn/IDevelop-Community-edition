'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * AMDEC #1 (criticality 720) — saving must never un-approve.
 *
 * `createOrUpdateSelfAssessment` reset ANY existing row to
 * `status='draft', workflow_state='draft'` with no state guard. Verified by
 * probe against real data: an APPROVED assessment came back as a draft while
 * `supervisor_reviews` still read completed/approve — two records disagreeing
 * about the same fact, with nothing logged.
 *
 * The blast radius was the whole page, not one row: the view set
 * `data-answered="1"` for every previously rated skill (approved included) and
 * the selects were never disabled, so a single "save draft" — or the background
 * auto-save — posted the employee's entire approved set back as drafts and
 * regressed their campaign state invisibly.
 *
 * Scoring rationale: G=8 (data integrity), O=9 (ordinary use — anyone returning
 * to adjust one answer), D=10 (silent; the screen shows the new value and says
 * "saved"). That combination is the most dangerous shape in this product.
 */

const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

describe('a save cannot re-open an assessment that left the employee', () => {
    const svc = read('src/services/SelfAssessmentService.js');

    test('only draft and changes_requested are editable', () => {
        expect(svc).toMatch(/const EDITABLE = \['draft', 'changes_requested'\]/);
    });

    test('the state is checked BEFORE the update that resets to draft', () => {
        const guard = svc.indexOf('EDITABLE.includes(state)');
        const reset = svc.indexOf("status = 'draft', workflow_state = 'draft'");
        expect(guard).toBeGreaterThan(-1);
        expect(reset).toBeGreaterThan(-1);
        expect(guard).toBeLessThan(reset);
    });

    test('a non-editable row is reported back, not silently ignored', () => {
        // The caller must be able to tell the user the edit did not apply.
        expect(svc).toMatch(/return \{ id: keepId, skipped: true, state \}/);
    });

    test('the guard reads workflow_state first, falling back to status', () => {
        // `status` is a 4-value enum; `workflow_state` is text and carries the
        // richer states (changes_requested, under_review, arbitration).
        expect(svc).toMatch(/current\.workflowState \|\| current\.status/);
    });
});

describe('the page does not offer to edit what the server will refuse', () => {
    const view = read('views/pages/employee/self-assessment.ejs');

    test('submitted / reviewed / approved rows are locked', () => {
        expect(view).toMatch(
            /saLocked = \['submitted', 'reviewed', 'approved'\]\.includes\(skill\.status\)/
        );
        expect(view).toMatch(/saLocked \? 'disabled' : ''/);
    });

    test('locked rows are excluded from what the form posts', () => {
        // data-answered drives collect(); leaving it '1' is what made one save
        // resubmit the entire approved set.
        expect(view).toMatch(
            /data-answered="<%= \(skill\.selfRatedLevel != null && !saLocked\) \? '1' : '0' %>"/
        );
    });

    test('a locked row is visibly labelled, not just inert', () => {
        expect(view).toMatch(/sa-lock-badge/);
        expect(view).toMatch(/employee:sa_locked/);
    });
});
