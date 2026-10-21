'use strict';
/**
 * Page journeys on a phone and on a desk:
 *  - « Mon auto-évaluation »: the sticky bar holds only the progress, the
 *    autosave state and the two buttons; filters and tools are a <details>
 *    below it (measured in Chromium: 22 % of a 390 × 844 screen in French);
 *  - the coaching console: a native <dialog> with labelled controls, a
 *    confirmed validation, card tables with an actions cell that wraps;
 *  - the review queue: ONE filter bar (campaign, sort, tabs), 44 px controls,
 *    a visible « My rating » label, « Already handled » folded;
 *  - a .card is display:flex, which beats the hidden attribute: every card
 *    toggled through `hidden` carries a [hidden] rule.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('self-assessment: a sticky bar under a quarter of a phone screen', () => {
    const view = read('views/pages/employee/self-assessment.ejs');
    const css = read('public/css/self-assessment.css');
    const bar = view.slice(
        view.indexOf('<div class="sa-bar" id="saBar">'),
        view.indexOf('<details class="sa-tools-wrap"')
    );
    test('the bar holds the progress and the two buttons, no filter and no tool', () => {
        expect(bar).toContain('id="saveDraftBtn"');
        expect(bar).toContain('id="submitBtn"');
        expect(bar).toContain('id="saProgressFill"');
        expect(bar).not.toMatch(/sa-chip|saSearch|saNextUnrated|saToggleAll/);
    });
    test('filters and tools are a <details> below it, opened on a wide screen only', () => {
        expect(view).toMatch(/<details class="sa-tools-wrap" id="saToolsWrap">/);
        expect(view).toMatch(
            /matchMedia\('\(min-width: 780px\)'\)\.matches\) toolsWrap\.open = true/
        );
    });
    test('the page CSS is on the tokens: no hex colour, z-index on the scale, nothing under 12 px', () => {
        expect(view).not.toMatch(/<style>\s*\/\* --- deadline banner/);
        expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        expect(css).toMatch(/z-index: var\(--z-sticky\)/);
        for (const m of css.matchAll(/font-size:\s*([\d.]+)rem/g))
            expect(Number(m[1])).toBeGreaterThanOrEqual(0.75);
    });
    test('the row status is the shared badge and the toast is the app-wide one', () => {
        expect(view).toMatch(/include\('\.\.\/\.\.\/partials\/status-badge', \{ state: _stTone/);
        expect(view).not.toContain('id="toastContainer"');
        expect(view).toMatch(/window\.toast\(msg, type \|\| 'info'\)/);
    });
});

describe('coaching console: an accessible dialog and phone cards', () => {
    const view = read('views/pages/coaching/plans-console.ejs');
    test('a native dialog, each label tied to its control, one legend', () => {
        expect(view).toMatch(
            /<dialog id="cp-modal" class="cp-dialog" aria-labelledby="cp-modal-title">/
        );
        for (const id of ['cp-kind', 'cp-context', 'cp-title', 'cp-obj', 'cp-out', 'cp-target'])
            expect(view).toContain(`for="${id}"`);
        expect(view).toContain("include('../../partials/form-legend')");
        expect(view).not.toMatch(/\* <small/);
        expect(view).toMatch(/dlg\.showModal\(\)/);
        expect(view).toMatch(/addEventListener\('close'[\s\S]{0,120}_opener\.focus\(\)/);
    });
    test('validating a plan is confirmed with a verb', () => {
        expect(view).toMatch(
            /window\.confirmDialog\(\{ title:C\.title, body:C\.body, confirmLabel:C\.yes/
        );
    });
    test('the panels toggled with `hidden` stay hidden although .card is a flex box', () => {
        expect(view).toMatch(/\.cp-panel\[hidden\],#cp-plans-panel\[hidden\]\{display:none\}/);
        expect(view).not.toMatch(/style\.display/);
    });
    test('card tables with a wrapping actions cell, no inline style', () => {
        expect((view.match(/class="table table-cards"/g) || []).length).toBe(2);
        expect((view.match(/col-actions cell-actions/g) || []).length).toBe(2);
        expect(view).not.toMatch(/style="/);
    });
});

describe('review queue: one filter bar', () => {
    const view = read('views/pages/supervisor/self-assessment-review.ejs');
    test('campaign, sort and the two tabs live in ONE bar', () => {
        expect((view.match(/class="card sa-filterbar"/g) || []).length).toBe(1);
        const bar = view.slice(
            view.indexOf('class="card sa-filterbar"'),
            view.indexOf('<div id="sa-pending"')
        );
        expect(bar).toContain('id="sa-cycle"');
        expect(bar).toContain('id="sa-sort"');
        expect(bar).toContain('data-sa-tab="queue"');
        expect(bar).toContain('data-sa-tab="pending"');
    });
    test('44 px controls, a row (.card is a column), hidden cards stay hidden', () => {
        expect(view).toMatch(/\.sa-filterbar\{[^}]*flex-direction:row/);
        expect(view).toMatch(/\.sa-tab\{min-height:44px/);
        expect(view).toMatch(/\.sa-panel\[hidden\]\{display:none\}/);
        expect(view).toMatch(/\.sa-filter-btn\[hidden\]\{display:none\}/);
    });
    test('« My rating » is a visible label tied to its select', () => {
        expect(view).toMatch(/<label class="sa-rate-lbl" for="sa-rate-'\+it\.id\+'">/);
        expect(view).toMatch(/rateLbl: <%- JSON\.stringify\(__\('talentx:sar_rate_my'\)\) %>/);
    });
    test('people with nothing left to decide fold under « Already handled », server and client', () => {
        expect(view).toMatch(/<details class="sa-done">/);
        expect(view).toMatch(/'<details class="sa-done"><summary/);
    });
});
