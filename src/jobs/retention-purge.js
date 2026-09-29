'use strict';

/**
 * retention-purge — the personal-data retention sweep (S-07).
 *
 * Until 3.23.18 nothing ever acted on an expired retention period:
 * DSRService.dueForRetention only LISTED the leavers past their country's
 * dsr_sla_days. This tick hands them to DSRService.runRetention, which
 * pseudonymises each one through the SAME path as a GDPR erasure (never a hard
 * delete, never a touch on the append-only audit trail), writes a ledger row per
 * decision and an audit row per erasure, skips legal holds and claims each job
 * row before acting.
 *
 * MODE. App Setting `retentionPurgeMode` — 'report' (the default seeded by
 * migration 151, and whatever else the setting holds) lists what WOULD be
 * erased; only 'apply', set by a SuperAdmin, erases.
 *
 * CADENCE. Hourly tick, self-gated to one pass per day through
 * `retentionPurgeLastRunOn` (read-only in the settings page by its suffix). A
 * manual run (`force`) bypasses the gate.
 */

const DSR = require('../services/DSRService');

async function tick({ force = false, now = new Date(), actorRef = null } = {}) {
    let settings = null;
    try {
        settings = require('../models/AppSettingsModel');
    } catch (_) {
        settings = null;
    }
    const today = now.toISOString().slice(0, 10);
    if (!force && settings) {
        try {
            const last = await settings.getValue('retentionPurgeLastRunOn', null);
            if (String(last || '') === today) return { done: false, skipped: 'already_today' };
        } catch (_) {
            /* unreadable gate → run; the pass itself is idempotent */
        }
    }
    const result = await DSR.runRetention({ actorRef });
    if (settings) {
        try {
            await settings.setValue(
                'retentionPurgeLastRunOn',
                today,
                'string',
                'Date of the last retention pass (written by the retention-purge job).',
                'jobs'
            );
        } catch (_) {
            /* the gate is a convenience; a second pass today is harmless */
        }
    }
    if (result.due) {
        console.log(
            `[retention-purge] run ${result.runId} (${result.mode}): ${JSON.stringify(result.counts)}`
        );
    }
    return { done: true, ...result };
}

module.exports = { tick };
