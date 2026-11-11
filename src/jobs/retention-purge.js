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
 *
 * REPORT COPIES (SA-38). The same daily pass empties the in-app copies of
 * scheduled reports older than `reportRunRetentionDays` (default 90, 1-365):
 * content = NULL, purged_at, purge_reason 'retention'. The row stays (date,
 * schedule, row count) for the audit; its download answers 410 « copy
 * expired ». Independent of retentionPurgeMode: a copy is a derived extract,
 * not a person's record.
 */

const DSR = require('../services/DSRService');
const db = require('../config/database');

const REPORT_RUN_DEFAULT_DAYS = 90;

/** The copy retention window, clamped to 1-365 (default 90). */
function reportRunDays(raw) {
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return REPORT_RUN_DEFAULT_DAYS;
    return Math.min(365, Math.max(1, n));
}

/** Empty the content of every report copy older than the window. Rows kept. */
async function purgeReportRuns(settings) {
    let days = REPORT_RUN_DEFAULT_DAYS;
    if (settings) {
        try {
            days = reportRunDays(
                await settings.getValue('reportRunRetentionDays', REPORT_RUN_DEFAULT_DAYS)
            );
        } catch (_) {
            days = REPORT_RUN_DEFAULT_DAYS;
        }
    }
    const r = await db.run(
        `UPDATE report_schedule_runs
            SET content = NULL, purged_at = now(), purge_reason = 'retention'
          WHERE purged_at IS NULL AND created_at < now() - make_interval(days => ?)`,
        [days]
    );
    return { days, purged: (r && r.changes) || 0 };
}

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
    let reportCopies = null;
    try {
        reportCopies = await purgeReportRuns(settings);
    } catch (e) {
        // Reported in the ledger result; the person-data pass above stands.
        reportCopies = { error: String((e && e.message) || e).slice(0, 200) };
    }
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
    return { done: true, ...result, reportCopies };
}

module.exports = { tick, purgeReportRuns, reportRunDays };
