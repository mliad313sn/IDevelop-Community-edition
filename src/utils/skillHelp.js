'use strict';

/**
 * The pure core of public/js/sa-skill-help.js, for the server: ONE resolver
 * (description language fallback, skill anchor → category anchor → generic
 * scale title) shared by the EJS partial views/partials/skill-help.ejs and the
 * reviewer console's JS render path. See that file for the rules.
 */
const core = require('../../public/js/sa-skill-help.js');

/** The generic 0-4 scale, translated, for resolve's last fallback. */
function scaleLabels(t) {
    const tr = typeof t === 'function' ? t : (k) => k;
    return {
        words: [0, 1, 2, 3, 4].map((n) => tr(`employee:scale_${n}_word`)),
        titles: [0, 1, 2, 3, 4].map((n) => tr(`employee:scale_${n}_title`)),
    };
}

module.exports = {
    resolve: core.resolve,
    panelHtml: core.panelHtml,
    gapText: core.gapText,
    nudgeFor: core.nudgeFor,
    esc: core.esc,
    scaleLabels,
};
