'use strict';

/**
 * typedConfirmation — the word a person types to confirm an irreversible
 * action (4.0.0 port, wave 10). The browser's form asks for it, and the
 * SERVER checks it again: a POST without the word, or with another word, is
 * refused before anything changes. Either language's word is accepted, with
 * or without accents and in any case.
 *
 *   settingsReset  POST /app-settings/reset (every setting back to its default)
 *   goLive         scripts/reset-for-golive.js --confirm (the go-live wipe)
 *
 * Pure, no dependency.
 */

const WORDS = Object.freeze({
    settingsReset: Object.freeze(['RESET', 'REINITIALISER']),
    goLive: Object.freeze(['PRODUCTION']),
});

/** Upper case, accents removed, trimmed; at most 64 characters are read. */
function normaliseWord(value) {
    return String(value === null || value === undefined ? '' : value)
        .slice(0, 64)
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .trim()
        .toUpperCase();
}

/**
 * Does `value` match one of the words of `action`? An unknown action never matches.
 * @param {string} action  a key of WORDS
 * @param {*} value        what the person typed
 */
function typedWordMatches(action, value) {
    const words = Object.prototype.hasOwnProperty.call(WORDS, action) ? WORDS[action] : null;
    if (!words) return false;
    const w = normaliseWord(value);
    return w.length > 0 && words.includes(w);
}

module.exports = { WORDS, normaliseWord, typedWordMatches };
