'use strict';
/**
 * public/js/fmt.js is the browser mirror of src/utils/kpiFormat.js: the same
 * inputs give byte-identical outputs, so a value printed by a page and the same
 * value in a chart tooltip never disagree. An absence of measurement is null,
 * never 0 and never a string.
 */
const Fmt = require('../../public/js/fmt');
const server = require('../../src/utils/kpiFormat');

describe('fmt.js — documented outputs (IDevelop number locale)', () => {
    test('numbers and percentages, French and English', () => {
        expect(Fmt.fmtNum(1234.5, 1, 'fr')).toBe('1 234,5');
        expect(Fmt.fmtNum(1234.5, 1, 'en')).toBe('1,234.5');
        expect(Fmt.fmtPct(66.66, 1, 'fr')).toBe('66,7 %');
        expect(Fmt.fmtPct(66.66, 1, 'en')).toBe('66.7%');
        expect(Fmt.fmtLevel(2.45, 'fr')).toBe('2,5');
        expect(Fmt.fmtN(41, 'en')).toBe('n = 41');
    });

    test('changes carry a sign; a change that rounds to zero carries none', () => {
        expect(Fmt.fmtDelta(3.24, 'pts', 'fr')).toBe('+3,2 pts');
        expect(Fmt.fmtDelta(-1, 'pts', 'en')).toBe('−1.0 pts');
        expect(Fmt.fmtDelta(4, null, 'fr')).toBe('+4');
        expect(Fmt.fmtDelta(0.01, 'pts', 'fr')).toBe('0,0 pts');
        expect(Fmt.fmtDelta(2.5, '%', 'en')).toBe('+2.5%');
    });

    test('an absence of measurement is null — never 0, never a string', () => {
        for (const v of [null, undefined, NaN, '', '  ', 'abc', true, false, Infinity]) {
            expect(Fmt.fmtNum(v)).toBeNull();
            expect(Fmt.fmtPct(v)).toBeNull();
            expect(Fmt.fmtDelta(v)).toBeNull();
            expect(Fmt.fmtN(v)).toBeNull();
        }
        expect(Fmt.fmtPct(0, 1, 'fr')).toBe('0,0 %'); // a real zero is a result
        expect(Fmt.fmtNum(-0.4, 0, 'en')).toBe('0'); // never « -0 »
    });

    test('dates: day first in both languages, calendar days never shifted', () => {
        expect(Fmt.fmtDate('2026-10-02')).toBe('02/10/2026');
        expect(Fmt.fmtMonth('2026-02-01', 'en')).toBe('Feb 2026');
        expect(Fmt.fmtMonth('2026-10-02', 'fr')).toBe('oct. 2026');
        expect(Fmt.fmtDate('2026-02-30')).toBe('');
        expect(Fmt.fmtDate(null)).toBe('');
    });

    test('defaults to the page language, French without one (node)', () => {
        expect(Fmt.lang()).toBe('fr');
        expect(Fmt.lang('en-GB')).toBe('en');
    });
});

describe('fmt.js ≡ src/utils/kpiFormat.js (parity)', () => {
    const nums = [0, 1, -1, 0.05, -0.04, -0.4, 12.345, 1234.5, -98765.4321, 1e6, 82.15, 99.95];
    const more = ['82.1', null, undefined, '', ' ', 'x', NaN, true];
    const digits = [undefined, 0, 1, 2, null];
    test.each(['fr', 'en'])('fmtNum / fmtPct in %s', (lang) => {
        for (const n of [...nums, ...more])
            for (const d of digits) {
                expect([n, d, Fmt.fmtNum(n, d, lang)]).toEqual([n, d, server.fmtNum(n, d, lang)]);
                expect([n, d, Fmt.fmtPct(n, d, lang)]).toEqual([n, d, server.fmtPct(n, d, lang)]);
            }
    });
    test('the bound formatter of a view prints levels with one decimal', () => {
        expect(server.forLang('fr').level(2.45)).toBe(Fmt.fmtLevel(2.45, 'fr'));
        expect(server.forLang('en').level(null)).toBeNull();
    });
});
