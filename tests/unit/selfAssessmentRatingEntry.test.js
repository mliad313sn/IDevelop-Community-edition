'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * Two defects on /employee/self-assessment, both about the difference between
 * "not rated" and "rated 0".
 *
 * F-03 — completion was structurally unreachable. `data-answered` means
 * "editable AND rated"; it is deliberately 0 on a locked row so that saving a
 * draft can never re-post an approved rating. But the PROGRESS counter read the
 * same flag, so the moment the person submitted, the bar fell back to
 * "0 of 50 rated · 50 still at level 0" while /employee/assessment-status
 * correctly reported 3 of 49. Two different questions were sharing one flag.
 *
 * Fix: `data-rated` ("a level exists", independent of the lock) drives progress;
 * `data-answered` still drives collect(). Proven with two genuinely submitted
 * rows inserted and then deleted:
 *
 *   locked: 2 · lockedCountedAsRated: 2 · lockedMarkedAnswered: 0 · progress 2/50
 *
 * so the counter moved AND the draft-save protection survived.
 *
 * F-04 — an honest "0 — None" could not be saved with a mouse. A never-rated
 * select had no placeholder, so it DISPLAYED "0 - Aucun". Choosing 0 changed
 * nothing, fired no `change` event, and collect() dropped the skill. Keyboard
 * users could enter it; mouse and touch users could not. Measured before the
 * fix: 50 unrated selects all showing value "0". After: 50 showing the
 * placeholder, and picking 0 by pointer flips answered 0 -> 1.
 *
 * The "still at level 0 (None)" wording was itself the absence-as-result error —
 * an unrated skill is not a level 0 — so it now reads "left to rate".
 */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const view = read('views/pages/employee/self-assessment.ejs');

describe('progress and submission use separate flags', () => {
    test('a rated row carries data-rated regardless of the lock', () => {
        expect(view).toMatch(/data-rated="<%= skill\.selfRatedLevel != null \? '1' : '0' %>"/);
    });

    test('data-answered still requires the row to be editable', () => {
        expect(view).toMatch(
            /data-answered="<%= \(skill\.selfRatedLevel != null && !saLocked\) \? '1' : '0' %>"/
        );
    });

    test('progress reads data-rated', () => {
        expect(view).toMatch(/const isRated = \(s\) => s\.dataset\.rated === '1';/);
    });

    test('collect still reads data-answered, so locked rows are never re-posted', () => {
        expect(view).toMatch(/\.filter\(\(select\) => select\.dataset\.answered === '1'\)/);
    });

    test('an interaction sets both flags', () => {
        const fn = view.slice(
            view.indexOf('function markAnswered'),
            view.indexOf('function markAnswered') + 260
        );
        expect(fn).toMatch(/dataset\.answered = '1'/);
        expect(fn).toMatch(/dataset\.rated = '1'/);
    });

    test('why the flags are separate is recorded', () => {
        expect(view).toMatch(/Two questions, two flags/);
    });
});

describe('an unrated select does not pretend to be a zero', () => {
    test('a placeholder option is rendered only when no level was saved', () => {
        expect(view).toMatch(
            /<% if \(skill\.selfRatedLevel == null\) \{ %>\s*\n\s*<option value="" selected disabled><%= __\('employee:opt_pick'\) %><\/option>/
        );
    });

    test('the placeholder has no value, so it cannot post as a rating', () => {
        expect(view).toMatch(/<option value="" selected disabled>/);
    });

    test('why a missing placeholder broke mouse entry is recorded', () => {
        expect(view).toMatch(/fires no `change` event/);
    });
});

describe('the labels are honest and bilingual', () => {
    test.each(['fr', 'en'])('%s carries the placeholder key', (lang) => {
        const bag = JSON.parse(read(`locales/${lang}/employee.json`));
        expect(typeof bag.opt_pick).toBe('string');
        expect(bag.opt_pick.length).toBeGreaterThan(0);
    });

    test.each(['fr', 'en'])('%s no longer calls an unrated skill a level 0', (lang) => {
        const bag = JSON.parse(read(`locales/${lang}/employee.json`));
        expect(bag.sa_still_zero).not.toMatch(/level 0|niveau 0/i);
    });

    test('the French wording says what is left to rate', () => {
        expect(JSON.parse(read('locales/fr/employee.json')).sa_still_zero).toBe(
            'restant à évaluer'
        );
    });

    test('the English wording matches in meaning', () => {
        expect(JSON.parse(read('locales/en/employee.json')).sa_still_zero).toBe('left to rate');
    });
});
