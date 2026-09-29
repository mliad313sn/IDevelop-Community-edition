'use strict';

/**
 * Re-audit L3 — the strategic empty states painted a green ✅ "no risk detected"
 * for a scope where NOBODY was ever assessed. Absence of measurement rendered as
 * a good result (cardinal rule). Staffing-risk, critical-roles and impact-gaps
 * now say "not measured" when the scope has no measurement, and keep the green
 * all-clear only when something WAS measured and came back clean.
 *
 * No jsdom in this project, so this is a source-shape test: assertions tolerate
 * arbitrary whitespace (the pre-commit hook reflows the file).
 */

const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

const src = read('public/js/dashboard.js');
const flat = src.replace(/\s+/g, ' ');

describe('L3 — an unmeasured scope is not a green all-clear', () => {
    test('loadStrategicInsights derives the unmeasured scope from riskIndex.measured === false', () => {
        expect(flat).toMatch(
            /scopeUnmeasured = !!\(data\.riskIndex && data\.riskIndex\.measured === false\)/
        );
        // and it is threaded into both strategic empty-state renderers
        // (whitespace tolerant: prettier may wrap the call across lines).
        expect(flat).toMatch(
            /renderCriticalRolesTable\(\s?'critical-roles-container', data\.criticalRoles, scopeUnmeasured\s?\)/
        );
        expect(flat).toMatch(
            /renderImpactGapsBars\(\s?'impact-gaps-container', data\.orgHealth\.topImpactGaps, scopeUnmeasured\s?\)/
        );
    });

    test('critical-roles and impact-gaps only show the green success-state when NOT unmeasured', () => {
        // Both empty states are now conditional on scopeUnmeasured.
        expect(flat).toMatch(/renderCriticalRolesTable\(containerId, roles, scopeUnmeasured\)/);
        expect(flat).toMatch(/renderImpactGapsBars\(containerId, gaps, scopeUnmeasured\)/);
        // The success-state ✅ is now in the else branch of a scopeUnmeasured ternary.
        expect(flat).toMatch(
            /scopeUnmeasured \? '<div class="empty-state">' \+ \(I18N\.scopeUnmeasured/
        );
        expect(flat).toMatch(
            /scopeUnmeasured \? '<div class="empty-state">' \+ esc\( I18N\.scopeUnmeasured/
        );
    });

    test('staffing-risk distinguishes "no risk" from "nothing measured"', () => {
        expect(flat).toMatch(/const anyMeasured = data\.some\(\(r\) => !r\.isUnmeasured\)/);
        expect(flat).toMatch(/if \(data\.length > 0 && !anyMeasured\)/);
        expect(flat).toMatch(/I18N\.scopeUnmeasured \|\|/);
    });

    test('the scope_unmeasured message exists in both locales and is wired in the view', () => {
        const en = JSON.parse(read('locales/en/dash.json'));
        const fr = JSON.parse(read('locales/fr/dash.json'));
        expect(en.scope_unmeasured).toBeTruthy();
        expect(fr.scope_unmeasured).toBeTruthy();
        expect(fr.scope_unmeasured).not.toBe(en.scope_unmeasured); // actually translated
        expect(read('views/pages/dashboard.ejs')).toMatch(
            /scopeUnmeasured: <%- JSON\.stringify\(__\('dash:scope_unmeasured'\)\) %>/
        );
    });
});
