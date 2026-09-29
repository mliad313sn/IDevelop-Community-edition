'use strict';

/**
 * The whole Talent Development tab spoke English on a French-first product.
 *
 * Its KPI cards, their sub-lines and its three doughnut label sets were written
 * as bare literals with no I18N lookup at all — "Active Coaching",
 * "mentoring relationships", "3 not started · avg 42%", "Skill gap",
 * "No approved 9-box placements yet". Not fallbacks behind a key: literals.
 *
 * Every one now resolves through I18N with the English as the fallback, the
 * pattern the rest of dashboard.js already follows, and the interpolated
 * sub-lines go through fmt() with positional placeholders so French word order
 * is free to differ.
 */

const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const KEYS = [
    'td_active_coaching',
    'td_active_mentoring',
    'td_mentoring_rel',
    'td_idps_in_progress',
    'td_active_pips',
    'td_pip_success',
    'td_ninebox_assessed',
    'td_level_ups',
    'td_level_ups_sub',
    'td_idp_completion',
    'td_sub_not_started',
    'td_sub_idp',
    'td_sub_awaiting',
    'td_sub_ninebox',
    'td_sub_actions_done',
    'td_sub_pip_closures',
    'td_sub_plans_run',
    'td_st_active',
    'td_st_completed',
    'td_st_cancelled',
    'td_cause_skill_gap',
    'td_cause_other',
    'td_tier_top',
    'td_tier_core',
    'td_tier_risk',
    'td_no_ninebox',
];

const camel = (k) =>
    k.split('_').reduce((a, w, i) => a + (i ? w[0].toUpperCase() + w.slice(1) : w), '');

describe('the Talent Development tab is translated', () => {
    const js = read('public/js/dashboard.js').replace(/\s+/g, ' ');
    const view = read('views/pages/dashboard.ejs');

    test('every key exists in BOTH locales', () => {
        for (const lang of ['fr', 'en']) {
            const d = JSON.parse(read(`locales/${lang}/dash.json`));
            const missing = KEYS.filter((k) => !d[k]);
            expect(missing).toEqual([]);
        }
    });

    test('the French is actually French, not the English copied across', () => {
        const fr = JSON.parse(read('locales/fr/dash.json'));
        const en = JSON.parse(read('locales/en/dash.json'));
        // A handful that must differ — if a translator ever pastes the English
        // in, this is what notices.
        for (const k of [
            'td_active_coaching',
            'td_mentoring_rel',
            'td_tier_risk',
            'td_no_ninebox',
        ]) {
            expect(fr[k]).not.toBe(en[k]);
        }
        expect(fr.td_active_coaching).toMatch(/[Cc]oaching actif/);
        expect(fr.td_no_ninebox).toMatch(/approuv/i);
    });

    test('the view injects every one', () => {
        for (const k of KEYS) {
            expect(view).toContain(`${camel(k)}:`);
            expect(view).toContain(`dash:${k}`);
        }
    });

    test('the renderer reads them instead of hardcoding', () => {
        // Report the MISSING keys, not the 3000-line file: a plain toContain
        // failure here prints the whole bundle.
        const unused = KEYS.filter((k) => !js.includes(`I18N.${camel(k)}`));
        expect(unused).toEqual([]);
    });

    test('no bare English label is left in the tab', () => {
        // These were literals with no I18N lookup in front of them.
        for (const lit of [
            "label: 'Active Coaching'",
            "label: 'Active Mentoring'",
            "label: 'Active PIPs'",
            "label: 'Skill Level-Ups (90d)'",
            "label: 'IDP Action Completion'",
            "sub: 'mentoring relationships'",
            "sub: 'confirmed proficiency gains'",
            "['Active', 'Completed', 'Cancelled']",
            "['Skill gap', 'PIP', 'IDP', 'Other']",
            "['Top talent', 'Core', 'At risk']",
            "note.textContent = 'No approved 9-box placements yet'",
        ]) {
            expect(js).not.toContain(lit.replace(/\s+/g, ' '));
        }
    });

    test('interpolated sub-lines use positional placeholders, so word order can move', () => {
        const fr = JSON.parse(read('locales/fr/dash.json'));
        for (const k of [
            'td_sub_not_started',
            'td_sub_idp',
            'td_sub_ninebox',
            'td_sub_actions_done',
        ]) {
            expect(fr[k]).toMatch(/\{0\}/);
            expect(fr[k]).toMatch(/\{1\}/);
        }
        expect(fr.td_sub_pip_closures).toMatch(/\{2\}/);
        // and they are rendered through fmt(), not template-literal splicing
        expect(js).toMatch(/fmt\(\s*I18N\.tdSubNotStarted/);
        expect(js).toMatch(/fmt\(\s*I18N\.tdSubPipClosures/);
    });
});
