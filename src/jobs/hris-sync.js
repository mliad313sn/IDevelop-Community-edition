'use strict';

/**
 * hris-sync — the nightly HRIS synchronisation (src/services/HrisSyncService).
 *
 * DISABLED until a connector is enabled on /admin/integrations/hris: the tick
 * then returns { skipped: 'no_connector' } without touching anything.
 *
 * CADENCE. Hourly tick, self-gated to one pass per day at or after the
 * connector's hour (02:00 by default, set on the admin screen). The day is
 * claimed in hris_connectors.last_scheduled_on before anything runs, so two
 * instances never both sync.
 *
 * WHAT IT DOES. Always a dry run first (recorded in hris_sync_runs). It
 * APPLIES only when the admin ticked "apply automatically"; otherwise the
 * SuperAdmins are notified that a plan waits for review. A plan that trips
 * the mass-leaver guard is never applied and raises an alert.
 */
async function tick({ now = new Date(), force = false } = {}) {
    const Hris = require('../services/HrisSyncService');
    const r = await Hris.runScheduled({ now, force });
    if (r && r.done) console.log(`[hris-sync] ${r.provider}: ${r.status} (dry run #${r.dryRun})`);
    return r;
}

module.exports = { tick };
