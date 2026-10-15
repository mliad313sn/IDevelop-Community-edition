'use strict';

/**
 * kpiFormat: numbers of the KPI pages in the reader's language. French
 * "66,7 %" and English "66.7%"; null / undefined / NaN print as null so the
 * caller chooses the "Not measured" wording (a missing value is never 0).
 */

function locale(lang) {
    return lang === 'en' ? 'en-GB' : 'fr-FR';
}

/** A number with `digits` decimals, or null when it is not a measurement. */
function fmtNum(v, digits = 0, lang = 'fr') {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return new Intl.NumberFormat(locale(lang), {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
    })
        .format(n)
        .replace(/[\u202f\u00a0]/g, ' ');
}

/** A percentage 0-100 with `digits` decimals ("66,7 %" / "66.7%"), or null. */
function fmtPct(v, digits = 1, lang = 'fr') {
    const s = fmtNum(v, digits, lang);
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
    };
}

module.exports = { fmtNum, fmtPct, forLang };
