'use strict';

/**
 * persona-digest — the « What changed » summaries (migration 187). The engine
 * is PersonaDigestService.tick(); it does nothing while personaDigestsEnabled
 * is off (the default), and it self-gates to the digest hour (digestHour) and,
 * for a weekly cadence, the digest day (digestDow). Registered hourly; one
 * archive row per person and day (a unique key), so a second run the same
 * day writes and sends nothing.
 */

async function tick(opts) {
    return require('../services/PersonaDigestService').tick(opts || {});
}

module.exports = { tick };
