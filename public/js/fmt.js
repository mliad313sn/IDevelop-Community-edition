/* eslint-env browser */
/**
 * fmt.js — the browser's number and date formatter, the mirror of the server's
 * src/utils/kpiFormat.js (same names, same rules, same output), so a figure
 * printed by a page and the same figure in a chart tooltip read the same.
 *
 *   Fmt.fmtNum(n, digits = 0)     fr « 1 234,5 »   en « 1,234.5 »
 *   Fmt.fmtPct(n, digits = 1)     fr « 66,7 % »    en « 66.7% »
 *   Fmt.fmtDelta(n, unit = 'pts') fr « +3,2 pts »  en « +3.2 pts »; unit null | '' | 'count' → « +4 »
 *   Fmt.fmtN(n)                   « n = 41 »
 *   Fmt.fmtLevel(n)               a proficiency level, one decimal: fr « 2,5 »  en « 2.5 »
 *   Fmt.fmtDate(d)                « 02/10/2026 » (day first in both languages)
 *   Fmt.fmtMonth(d)               fr « oct. 2026 »  en « Oct 2026 »
 *
 * Every function takes an optional trailing language ('fr' | 'en' | 'en-GB'…);
 * without one, the page language (<html lang>), French when there is none.
 * Spaces are plain spaces, as on the server pages.
 *
 * NUMBERS: null, undefined, NaN, '', a blank string, a boolean or a non-numeric
 * string give null — never 0 — and the caller prints "Not measured". A value
 * that rounds to zero prints without a sign. DATES: absent or invalid give ''.
 *
 * Loaded as a plain <script> (window.Fmt) and require()-able from node (tests).
 */
(function (global, factory) {
    'use strict';
    var api = factory(global);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (global) global.Fmt = api;
})(typeof window !== 'undefined' ? window : null, function (global) {
    'use strict';

    var MINUS = '−';
    var SPACES = /[\u202f\u00a0]/g;

    function pageLang() {
        try {
            return (
                (global &&
                    global.document &&
                    global.document.documentElement.getAttribute('lang')) ||
                'fr'
            );
        } catch (_) {
            return 'fr';
        }
    }

    /** 'en' or 'fr' for any language tag; the page language when none is given. */
    function lang(locale) {
        var l = String(locale == null || locale === '' ? pageLang() : locale).toLowerCase();
        return l.indexOf('en') === 0 ? 'en' : 'fr';
    }

    function intlLocale(l) {
        return l === 'en' ? 'en-GB' : 'fr-FR';
    }

    /** A finite number, or null for anything that is not a measurement. */
    function toNum(n) {
        if (n === null || n === undefined || typeof n === 'boolean') return null;
        if (typeof n === 'string' && n.trim() === '') return null;
        var v = typeof n === 'number' ? n : Number(n);
        return isFinite(v) ? v : null;
    }

    function digitsOf(d, dflt) {
        var k = Number(d);
        return d !== null && d !== undefined && k === Math.floor(k) && k >= 0 && k <= 10 ? k : dflt;
    }

    /** The number with `digits` decimals in language l; a rounded zero has no sign. */
    function body(v, digits, l) {
        var x = Math.abs(v) < 0.5 * Math.pow(10, -digits) ? 0 : v;
        return new Intl.NumberFormat(intlLocale(l), {
            minimumFractionDigits: digits,
            maximumFractionDigits: digits,
        })
            .format(x)
            .replace(SPACES, ' ');
    }

    function fmtNum(n, digits, locale) {
        var v = toNum(n);
        if (v === null) return null;
        return body(v, digitsOf(digits, 0), lang(locale));
    }

    function fmtPct(n, digits, locale) {
        var s = fmtNum(n, digitsOf(digits, 1), locale);
        if (s === null) return null;
        return lang(locale) === 'en' ? s + '%' : s + ' %';
    }

    /** One decimal: the way a proficiency level (0 to 4) is printed. */
    function fmtLevel(n, locale) {
        return fmtNum(n, 1, locale);
    }

    /**
     * A signed change. unit: 'pts' (default, 1 decimal), '%' (1 decimal), any
     * other word (1 decimal), or null / '' / 'count' (integer, no unit: « +4 »).
     * A change that rounds to zero carries no sign.
     */
    function fmtDelta(n, unit, locale, digits) {
        var u = unit === undefined ? 'pts' : unit;
        var v = toNum(n);
        if (v === null) return null;
        var isCount = u === null || u === '' || u === 'count';
        var l = lang(locale);
        var k = digitsOf(digits, isCount ? 0 : 1);
        var s = body(Math.abs(v), k, l);
        var zero = Math.abs(v) < 0.5 * Math.pow(10, -k);
        var core = (zero ? '' : v < 0 ? MINUS : '+') + s;
        if (isCount) return core;
        if (u === '%') return l === 'en' ? core + '%' : core + ' %';
        return core + ' ' + u;
    }

    /** « n = 41 » (the number of people behind a figure). null → null. */
    function fmtN(n, locale) {
        var s = fmtNum(n, 0, locale);
        return s === null ? null : 'n = ' + s;
    }

    // ---- dates (calendar days, never shifted by the browser's time zone) ----
    var MONTHS = {
        fr: [
            'janv.',
            'févr.',
            'mars',
            'avr.',
            'mai',
            'juin',
            'juil.',
            'août',
            'sept.',
            'oct.',
            'nov.',
            'déc.',
        ],
        en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    };

    function pad(n) {
        return (n < 10 ? '0' : '') + n;
    }

    /** { y, m (1-12), d } of a calendar day, or null. 'YYYY-MM-DD' is never shifted. */
    function dayParts(input) {
        if (input === null || input === undefined || input === '' || typeof input === 'boolean')
            return null;
        if (typeof input === 'string') {
            var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(input.trim());
            if (m) {
                var y = Number(m[1]);
                var mo = Number(m[2]);
                var d = Number(m[3]);
                var x0 = new Date(Date.UTC(y, mo - 1, d));
                if (
                    x0.getUTCFullYear() !== y ||
                    x0.getUTCMonth() !== mo - 1 ||
                    x0.getUTCDate() !== d
                )
                    return null;
                return { y: y, m: mo, d: d };
            }
        }
        var x = input instanceof Date ? input : new Date(input);
        if (isNaN(x.getTime())) return null;
        return { y: x.getFullYear(), m: x.getMonth() + 1, d: x.getDate() };
    }

    function fmtDate(d) {
        var p = dayParts(d);
        return p ? pad(p.d) + '/' + pad(p.m) + '/' + p.y : '';
    }

    function fmtMonth(d, locale) {
        var p = dayParts(d);
        return p ? MONTHS[lang(locale)][p.m - 1] + ' ' + p.y : '';
    }

    function fmtDateLong(d, locale) {
        var p = dayParts(d);
        return p ? p.d + ' ' + MONTHS[lang(locale)][p.m - 1] + ' ' + p.y : '';
    }

    return {
        fmtNum: fmtNum,
        fmtPct: fmtPct,
        fmtLevel: fmtLevel,
        fmtDelta: fmtDelta,
        fmtN: fmtN,
        fmtDate: fmtDate,
        fmtMonth: fmtMonth,
        fmtDateLong: fmtDateLong,
        toNum: toNum,
        lang: lang,
        MINUS: MINUS,
    };
});
