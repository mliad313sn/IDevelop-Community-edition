'use strict';
/**
 * « il y a 0,8 mois » is not something a person says. The 9-box console now
 * says how long ago a placement was approved in days, weeks or months, whole
 * numbers, through utils/agoBucket and plural labels in French and English.
 */
const fs = require('fs');
const path = require('path');
const { agoBucket, daysBetween } = require('../../src/utils/agoBucket');

const ROOT = path.join(__dirname, '..', '..');
const loc = (lang) =>
    JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', lang, 'talentx.json'), 'utf8'));

describe('agoBucket picks the unit a person would use', () => {
    test.each([
        [0, { unit: 'today', n: 0 }],
        [1, { unit: 'days', n: 1 }],
        [13, { unit: 'days', n: 13 }],
        [14, { unit: 'weeks', n: 2 }],
        [24, { unit: 'weeks', n: 3 }], // was « 0,8 mois »
        [59, { unit: 'weeks', n: 8 }],
        [60, { unit: 'months', n: 2 }],
        [365, { unit: 'months', n: 12 }],
    ])('%i days → %j', (d, want) => {
        expect(agoBucket(d)).toEqual(want);
    });

    test('an unknown or negative value prints nothing rather than a wrong figure', () => {
        expect(agoBucket(null)).toBeNull();
        expect(agoBucket(undefined)).toBeNull();
        expect(agoBucket('x')).toBeNull();
        expect(agoBucket(-1)).toBeNull();
    });

    test('never a fraction', () => {
        for (let d = 0; d < 800; d++) expect(Number.isInteger(agoBucket(d).n)).toBe(true);
    });

    test('daysBetween counts whole days', () => {
        const now = Date.UTC(2026, 9, 15, 12);
        expect(daysBetween(new Date(Date.UTC(2026, 9, 14, 13)), now)).toBe(0);
        expect(daysBetween(new Date(Date.UTC(2026, 9, 1, 12)), now)).toBe(14);
        expect(daysBetween('not a date', now)).toBeNull();
    });
});

describe('labels exist in French and English, singular and plural', () => {
    test.each(['fr', 'en'])('%s', (lang) => {
        const t = loc(lang);
        expect(typeof t.nb_ago_today).toBe('string');
        for (const unit of ['days', 'weeks', 'months'])
            for (const form of ['one', 'other'])
                expect(t[`nb_ago_${unit}_${form}`]).toMatch(/\{n\}/);
        expect(t.nb_mo_ago).toBeUndefined();
    });
});

describe('the 9-box console reads the bucket, never monthsSince', () => {
    const view = fs.readFileSync(
        path.join(ROOT, 'views', 'pages', 'talent', 'nine-box-console.ejs'),
        'utf8'
    );
    test('the roster cell uses sinceAgo and escapes the text', () => {
        expect(view).toMatch(
            /e\.sinceAgo\?'<span class="nb-ago text-muted">'\+esc\(agoText\(e\.sinceAgo\)\)/
        );
        expect(view).not.toMatch(/NB_T\.moAgo/);
    });
    test('the service ships the bucket beside the raw months', () => {
        const svc = fs.readFileSync(
            path.join(ROOT, 'src', 'services', 'NineBoxService.js'),
            'utf8'
        );
        expect(svc).toMatch(
            /sinceAgo: approvedAt \? agoBucket\(daysBetween\(approvedAt, now\)\) : null/
        );
    });
});
