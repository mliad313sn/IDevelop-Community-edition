'use strict';

/**
 * kpiFormat: numbers of the KPI pages in the reader's language. French
 * "66,7 %" and English "66.7%"; null, undefined, NaN, '', a blank string or a
 * boolean print as null so the caller chooses the "Not measured" wording (a
 * missing value is never 0). A value that rounds to zero prints without a
 * sign ("0", never "-0").
 *
 * The browser mirror is public/js/fmt.js: same rules, same output
 * (tests/unit/vizFmt.test.js keeps them identical).
 */

function locale(lang) {
    return lang === 'en' ? 'en-GB' : 'fr-FR';
}

/** A finite number, or null for anything that is not a measurement. */
function toNum(v) {
    if (v === null || v === undefined || typeof v === 'boolean') return null;
    if (typeof v === 'string' && v.trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/** A number with `digits` decimals, or null when it is not a measurement. */
function fmtNum(v, digits = 0, lang = 'fr') {
    const n = toNum(v);
    if (n === null) return null;
    const d = Number.isInteger(digits) && digits >= 0 && digits <= 10 ? digits : 0;
    const x = Math.abs(n) < 0.5 * 10 ** -d ? 0 : n;
    return new Intl.NumberFormat(locale(lang), {
        minimumFractionDigits: d,
        maximumFractionDigits: d,
    })
        .format(x)
        .replace(/[\u202f\u00a0]/g, ' ');
}

/** A percentage 0-100 with `digits` decimals ("66,7 %" / "66.7%"), or null. */
function fmtPct(v, digits = 1, lang = 'fr') {
    const d = Number.isInteger(digits) && digits >= 0 && digits <= 10 ? digits : 1;
    const s = fmtNum(v, d, lang);
    if (s === null) return null;
    return lang === 'en' ? `${s}%` : `${s} %`;
}

/** Both formatters bound to one language (handed to a view). */
function forLang(lang) {
    const l = lang === 'en' ? 'en' : 'fr';
    return {
        lang: l,
        num: (v, d = 0) => fmtNum(v, d, l),
        pct: (v, d = 1) => fmtPct(v, d, l),
        // a proficiency level (0 to 4) is printed with one decimal
        level: (v) => fmtNum(v, 1, l),
    };
}

module.exports = { fmtNum, fmtPct, forLang, toNum };
