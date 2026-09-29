'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * AMDEC L4-9 (300), L1-7 (288), L5-7 (288) and L1-11 (189).
 *
 * L4-9  The report builder's "active only" checkbox was sent to the server and
 *       never read. Every report source is built on `v_employee_details`, which
 *       filters `is_active = true` IN THE VIEW, so reports are active-only by
 *       construction — a user could untick the box and be shown the same figures
 *       while believing they had included leavers, making turnover analysis
 *       impossible and the screen state a lie. The control now states the scope
 *       instead of offering a choice the engine cannot honour. G=5, O=6, D=10.
 *
 * L1-7  `submitAssessment` submitted every draft row. Combined with joiner shells
 *       (which now carry a NULL level, L3-2) that would file "no answer" as an
 *       answer and raise a supervisor review for a competency nobody assessed.
 *       Verified: an employee with 13 shells who answers ONE now submits 1 and
 *       raises 1 review, not 13. G=6, O=6, D=8.
 *
 * L5-7  `issueAndSend` sets `isAccountActive` unconditionally, so "resend
 *       credentials" on a DEPARTED employee silently reopened their access with a
 *       working temporary password. The bulk screen filters on is_active; the
 *       single-employee route accepted any id in scope. Verified: a leaver is now
 *       refused, and re-inviting someone who still works here but whose login was
 *       switched off proceeds AND is audited. G=8, O=4, D=9.
 *
 * L1-11 `arbitrate()` had no source-state guard — the only transition in that file
 *       without one. A manager could arbitrate from ANY state, so a DRAFT the
 *       employee had never submitted was promoted straight to 'approved' and
 *       written into skill_assessments as an official level. Verified across all
 *       eight states: draft and changes_requested (with the employee) refused,
 *       approved and rejected (terminal) refused, the four in-review states
 *       allowed. G=7, O=3, D=9.
 */

const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

describe('the report filter states the scope instead of faking a choice (L4-9)', () => {
    test('the checkbox cannot be unticked', () => {
        const v = read('views/pages/reports/builder.ejs');
        expect(v).toMatch(/<input type="checkbox" id="filterActive" checked disabled>/);
        expect(v).toMatch(/title="<%= __\('admin:rb_active_only_fixed'\) %>"/);
    });

    test('the explanation exists in both languages', () => {
        for (const lang of ['fr', 'en']) {
            const j = JSON.parse(read(`locales/${lang}/admin.json`));
            expect(typeof j.rb_active_only_fixed).toBe('string');
            expect(j.rb_active_only_fixed.length).toBeGreaterThan(0);
        }
    });

    test('the client no longer reads a control that decides nothing', () => {
        const js = read('public/js/report-builder.js');
        expect(js).not.toMatch(/activeOnly: document\.getElementById\('filterActive'\)\.checked/);
        expect(js).toMatch(/activeOnly: true/);
    });
});

describe('submitting sends only what the employee answered (L1-7)', () => {
    test('unrated drafts are not submitted', () => {
        const m = read('src/models/SelfAssessmentModel.js');
        expect(m).toMatch(
            /WHERE employeeId = \? AND status = 'draft' AND selfRatedLevel IS NOT NULL/
        );
    });

    test('the reason is recorded next to the query', () => {
        const m = read('src/models/SelfAssessmentModel.js');
        expect(m).toMatch(/Only RATED drafts are submitted/);
    });
});

describe('resending credentials cannot silently reopen access (L5-7)', () => {
    const svc = read('src/services/OnboardingCredentialService.js');

    test('a departed employee is refused', () => {
        expect(svc).toMatch(/if \(employee\.isActive === false \|\| employee\.isActive === 0\)/);
        expect(svc).toMatch(
            /This employee is deactivated — reactivate the employee record first\./
        );
    });

    test('the refusal happens before anything is written', () => {
        const guard = svc.indexOf('This employee is deactivated');
        const write = svc.indexOf('isAccountActive: 1');
        expect(guard).toBeGreaterThan(-1);
        expect(write).toBeGreaterThan(-1);
        expect(guard).toBeLessThan(write);
    });

    test('re-enabling a disabled login is allowed but recorded', () => {
        // Re-inviting a current employee whose login was switched off is the
        // legitimate remedy; doing it invisibly is not.
        expect(svc).toMatch(
            /const reopeningDisabledLogin =\s*employee\.isAccountActive === false \|\| employee\.isAccountActive === 0/
        );
        expect(svc).toMatch(/action: 'CREDENTIALS_REISSUED_REACTIVATED'/);
    });
});

describe('arbitration has a source-state guard (L1-11)', () => {
    const svc = read('src/services/SelfAssessmentWorkflowService.js');

    test('only in-review states can be arbitrated', () => {
        expect(svc).toMatch(
            /const ARBITRABLE = \['submitted', 'under_review', 'reviewed', 'arbitration'\]/
        );
        // La phrase de RÉFÉRENCE est toujours celle-ci ; elle voyage désormais
        // avec sa clé de catalogue (`say(…)`, M-02) pour être lue en français
        // sur une page française. Le garde, lui, est inchangé.
        expect(svc).toMatch(/new Error\(`Cannot arbitrate from state '\$\{sa\.workflowState\}'`\)/);
        expect(svc).toMatch(
            /'assess:saw_err_cannot_arbitrate',\s*\{\s*stateRaw: sa\.workflowState\s*\}/
        );
    });

    test('the concurrency guard matches the allowed set', () => {
        // A mismatch between the two is how a double-arbitration slips through.
        // The 4th argument is what matters — `_setState` now also takes a 5th
        // (the campaign context that feeds the closed-campaign write gate), so
        // the guard set is pinned followed by a comma OR the closing paren.
        expect(svc).toMatch(
            /await this\._setState\(selfAssessmentId, toState, extra, ARBITRABLE[,)]/
        );
    });

    test('it matches the set the approve path already enforces', () => {
        expect(svc).toMatch(
            /\['submitted', 'under_review', 'reviewed', 'arbitration'\]\.includes\(sa\.workflowState\)/
        );
    });
});
