'use strict';

const db = require('../config/database');

/**
 * Prune high-volume TELEMETRY tables so they don't grow without bound.
 *
 * IMPORTANT: this deliberately does NOT touch system_logs — that is the
 * tamper-evident, hash-chained audit log (immutable by DB trigger, a compliance
 * artifact). Only operational telemetry with no evidentiary value is pruned:
 *   - perf_events (slow requests / slow queries / DB error codes)
 *   - notifications that are read AND older than the window
 *   - reminder_log (the exactly-once nudge ledger — one row per reminder sent)
 * Retention is env-configurable; runs idempotently (hourly tick, cheap DELETE).
 *
 * reminder_log note: the ledger only has to answer "did we already send THIS
 * period's nudge?", and its period buckets are days/weeks/months — so rows older
 * than the retention window can never claim anything again. Left unpruned it grew
 * forever (every employee × every reminder kind × every week).
 */
// Retention windows are runtime-tunable from App Settings (category "jobs");
// the env vars remain the fallback.
const ENV_PERF_DAYS = Number(process.env.PERF_EVENTS_RETENTION_DAYS) || 30;
const ENV_NOTIF_DAYS = Number(process.env.NOTIFICATION_RETENTION_DAYS) || 120;
const ENV_REMINDER_DAYS = Number(process.env.REMINDER_LOG_RETENTION_DAYS) || 180;

async function tick() {
    let perf = 0,
        notif = 0,
        reminders = 0;
    let perfDays = ENV_PERF_DAYS,
        notifDays = ENV_NOTIF_DAYS,
        reminderDays = ENV_REMINDER_DAYS;
    try {
        const AppSettingsModel = require('../models/AppSettingsModel');
        perfDays = Number(
            await AppSettingsModel.getValue('perfEventsRetentionDays', ENV_PERF_DAYS)
        );
        notifDays = Number(
            await AppSettingsModel.getValue('notificationRetentionDays', ENV_NOTIF_DAYS)
        );
        reminderDays = Number(
            await AppSettingsModel.getValue('reminderLogRetentionDays', ENV_REMINDER_DAYS)
        );
    } catch {
        /* settings unavailable → env/default */
    }
    // 0 (or negative/NaN) = "keep forever" per the getValue convention — NOT
    // "delete everything older than now". Skip the prune in that case.
    if (Number.isFinite(perfDays) && perfDays > 0) {
        try {
            const r = await db.run(
                `DELETE FROM perf_events WHERE created_at < now() - (? || ' days')::interval`,
                [perfDays]
            );
            perf = (r && (r.changes ?? r.rowCount)) || 0;
        } catch (e) {
            /* table may not exist on older schemas */
        }
    }
    if (Number.isFinite(notifDays) && notifDays > 0) {
        try {
            // The notifications table tracks read-state via read_at (timestamp), NOT an
            // is_read boolean — the old column name silently 42703'd every tick, so read
            // notifications were never pruned and the table grew without bound.
            const r = await db.run(
                `DELETE FROM notifications
                  WHERE read_at IS NOT NULL
                    AND created_at < now() - (? || ' days')::interval`,
                [notifDays]
            );
            notif = (r && (r.changes ?? r.rowCount)) || 0;
        } catch (e) {
            /* notifications schema variant */
        }
    }
    if (Number.isFinite(reminderDays) && reminderDays > 0) {
        try {
            const r = await db.run(
                `DELETE FROM reminder_log WHERE sent_at < now() - (? || ' days')::interval`,
                [reminderDays]
            );
            reminders = (r && (r.changes ?? r.rowCount)) || 0;
        } catch (e) {
            /* table absent before migration 65 */
        }
    }
    // The job ledger is telemetry too: ~30 rows an hour, kept
    // 90 days — enough to read a quarter of "did the backup run" from one page.
    let jobRuns = 0;
    try {
        jobRuns = await require('../services/JobRunService').prune(90);
    } catch (e) {
        /* table absent before migration 111 */
    }
    if (perf || notif || reminders || jobRuns) {
        console.log(
            `[telemetry-prune] removed perf_events=${perf}, notifications=${notif}, reminder_log=${reminders}, job_runs=${jobRuns}`
        );
    }
    return { perf, notif, reminders, jobRuns };
}

module.exports = { tick };
