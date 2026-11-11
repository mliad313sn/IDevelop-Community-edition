'use strict';

const db = require('../config/database');

/**
 * Prune high-volume TELEMETRY tables so they don't grow without bound.
 *
 * IMPORTANT: this deliberately does NOT touch system_logs — that is the
 * tamper-evident, hash-chained audit log (immutable by DB trigger, a compliance
 * artifact). Only operational telemetry with no evidentiary value is pruned:
 *   - perf_events (slow requests / slow queries / DB error codes)
 *   - notifications older than the window (read, and unread: see below)
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
/**
 * RETENTION PER CATEGORY: two categories that were kept forever.
 *   - UNREAD notifications. Only read ones were pruned, so a notice nobody
 *     opened lived for ever. Setting `unreadNotificationRetentionDays`; when
 *     unset it FOLLOWS `notificationRetentionDays` (default 120 days), the same
 *     window as read ones. A notification still scheduled for later
 *     (release_at in the future) is never pruned.
 *   - REJECTED sign-up applicants (onboarding_requests): name, e-mail, password
 *     hash, IdP subject and decision note of a person who never became an
 *     employee. Setting `onboardingRejectedRetentionDays`, default 180 days
 *     after the decision. The row is PSEUDONYMISED, not deleted (the decision,
 *     its date and who decided stay for the audit of the onboarding queue).
 * 0 (or negative / NaN) = keep forever, like every other window here.
 */
const ENV_ONBOARDING_REJECTED_DAYS = Number(process.env.ONBOARDING_REJECTED_RETENTION_DAYS) || 180;

async function tick() {
    let perf = 0,
        notif = 0,
        reminders = 0,
        unread = 0,
        applicants = 0;
    let perfDays = ENV_PERF_DAYS,
        notifDays = ENV_NOTIF_DAYS,
        reminderDays = ENV_REMINDER_DAYS;
    let unreadDays = null,
        applicantDays = ENV_ONBOARDING_REJECTED_DAYS;
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
        unreadDays = await AppSettingsModel.getValue('unreadNotificationRetentionDays', null);
        applicantDays = Number(
            await AppSettingsModel.getValue(
                'onboardingRejectedRetentionDays',
                ENV_ONBOARDING_REJECTED_DAYS
            )
        );
    } catch {
        /* settings unavailable → env/default */
    }
    // Unset → the same window as read notifications.
    unreadDays = unreadDays == null || unreadDays === '' ? notifDays : Number(unreadDays);
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
    if (Number.isFinite(unreadDays) && unreadDays > 0) {
        try {
            const r = await db.run(
                `DELETE FROM notifications
                  WHERE read_at IS NULL
                    AND created_at < now() - (? || ' days')::interval
                    AND (release_at IS NULL OR release_at <= now())`,
                [unreadDays]
            );
            unread = (r && (r.changes ?? r.rowCount)) || 0;
        } catch (e) {
            /* notifications schema variant */
        }
    }
    if (Number.isFinite(applicantDays) && applicantDays > 0) {
        try {
            const r = await db.run(
                `UPDATE onboarding_requests
                    SET email = ('purged-onb-' || id || '@erased.local'), first_name = NULL, last_name = NULL,
                        password_hash = NULL, external_id = NULL, decision_note = NULL
                  WHERE status = 'rejected'
                    AND COALESCE(decided_at, requested_at) < now() - (? || ' days')::interval
                    AND email::text NOT LIKE '%@erased.local'`,
                [applicantDays]
            );
            applicants = (r && (r.changes ?? r.rowCount)) || 0;
        } catch (e) {
            /* table absent on older schemas */
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
    if (perf || notif || reminders || jobRuns || unread || applicants) {
        console.log(
            `[telemetry-prune] removed perf_events=${perf}, notifications=${notif}, unread_notifications=${unread}, reminder_log=${reminders}, job_runs=${jobRuns}; rejected applicants pseudonymised=${applicants}`
        );
    }
    return { perf, notif, reminders, jobRuns, unread, applicants };
}

module.exports = { tick };
