'use strict';

/**
 * colon — the label separator, in the typography of the language being read.
 *
 * . French writes « Source : » (a space BEFORE the colon), English
 * writes "Source:". Twenty-five templates carried the separator as a literal
 * `<%= __('…') %> :`, which is French punctuation applied to every language:
 * the ENGLISH brief read « Oldest : », « Count : », « Source : », the English
 * campaign page « Opens : » / « Closes : », the English access review « Last
 * activity : » twenty-five times.
 *
 * `views/pages/reports/dept-brief-show.ejs` fixed ITS page with a constant local
 * to that one template — which is exactly how the next template gets it wrong
 * again. The separator lives here instead, is published once as `res.locals.colon`
 * (beside `__` and `enumLabel`), and the catalogue (`common:colon`) keeps it a
 * translation rather than a hard-coded pair of branches.
 *
 * The literal fallbacks below are the SAME two strings as the catalogue: they
 * only matter when i18next is absent (key-passthrough boot), where a raw
 * « common:colon » on the page would be worse than either spelling.
 *
 * @module utils/colon
 */

const FR = ' :';
const EN = ':';

/**
 * @param {Function|null} t     the request translator (`req.t`), when there is one
 * @param {string} [lang]       the active language, for the no-i18next fallback
 * @returns {string} " :" in French, ":" otherwise
 */
function colon(t, lang) {
    const fallback =
        String(lang || 'fr')
            .slice(0, 2)
            .toLowerCase() === 'fr'
            ? FR
            : EN;
    if (typeof t !== 'function') return fallback;
    const s = t('common:colon', { defaultValue: fallback });
    // A passthrough translator answers with the key itself — never print that.
    return typeof s === 'string' && s !== 'common:colon' && s.trim() === ':' ? s : fallback;
}

module.exports = { colon, FR, EN };
