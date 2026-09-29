'use strict';

/**
 * safety-gate — keeps the safety-competency gate's change trail current
 * (migration 150).
 *
 * Every 15 minutes:
 *   - retries due outgoing webhook deliveries (exponential backoff, abandoned
 *     and audited after SafetyGateService's MAX_ATTEMPTS);
 *   - once per day, recomputes the gate for the whole active population (plus
 *     anyone with a recorded status, so a LEAVER whose last status was CLEARED
 *     is re-evaluated and flips to BLOCKED). Certificates expire with the
 *     calendar, not with an event: without this pass a certificate lapsing
 *     overnight would only be noticed at the next API call.
 *
 * The day is marked done AFTER the sweep completes: a failed sweep is retried on
 * the next tick. Re-running is harmless — only CHANGED answers are recorded.
 */

async function tick() {
    const SafetyGateService = require('../services/SafetyGateService');
    const out = { retried: null, recomputed: 0 };
    try {
        out.retried = await SafetyGateService.retryDue();
    } catch (e) {
        console.error('[safety-gate] webhook retry failed:', e && e.message);
    }
    if (await SafetyGateService.nightlyDue()) {
        const rows = await SafetyGateService.recomputeAll('nightly');
        out.recomputed = rows.length;
        await SafetyGateService.claimNightly();
    }
    return out;
}

module.exports = { tick };
