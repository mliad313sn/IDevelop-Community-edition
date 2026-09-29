'use strict';

/**
 * HealthController — "Santé de l'instance" (/admin/health, SuperAdmin).
 *
 * the one page that answers the operator's
 * questions after an incident — did every job run, when, with what result;
 * do we have a backup and where; can the instance send mail; is the schema
 * up to date and how big is the database; is the licence in order. Every
 * number comes from the job ledger, the backup directory or the database —
 * nothing is inferred, and an unmeasured value renders as « — ».
 */

const fs = require('fs');
const path = require('path');
const db = require('../config/database');
const RBACService = require('../services/RBACService');
const JobRunService = require('../services/JobRunService');
const LogService = require('../services/LogService');

// Human summary of the TICKS cron: "*/15 * * * *" -> every 15 min, "40 * * * *" -> hourly at :40.
// (Line comment on purpose: the cron text contains the block-comment terminator.)
function scheduleOf(t) {
    const m = /^\*\/(\d+) \* \* \* \*$/.exec(t.cron);
    if (m) return { kind: 'every', minutes: Number(m[1]) };
    const h = /^(\d+) \* \* \* \*$/.exec(t.cron);
    if (h) return { kind: 'hourly', minute: Number(h[1]) };
    return { kind: 'cron', cron: t.cron };
}

async function one(sql, params = []) {
    try {
        const r = await db.get(sql, params);
        return r ? Object.values(r)[0] : null;
    } catch {
        return null;
    }
}

/** JSON reset backups written by DatabaseCleanupService.createBackup (data/backups). */
function listResetBackups() {
    const dir = path.resolve(__dirname, '../../data/backups');
    try {
        return fs
            .readdirSync(dir)
            .filter((f) => /^backup_.*\.json$/.test(f))
            .map((f) => {
                const st = fs.statSync(path.join(dir, f));
                return { name: f, sizeBytes: st.size, createdAt: st.mtime.toISOString() };
            })
            .sort((a, b) => (a.name < b.name ? 1 : -1))
            .slice(0, 20);
    } catch {
        return [];
    }
}

/** Pending migrations, by the runner's own rule (scripts/migrate-preflight.plan). */
async function migrationsState() {
    try {
        const { plan } = require('../../scripts/migrate-preflight');
        const files = fs.readdirSync(path.join(__dirname, '..', '..', 'db', 'postgres'));
        const keys = (await db.all('SELECT key FROM schema_meta')).map((r) => r.key);
        const p = plan(files, keys);
        return {
            shipped: p.shipped.length,
            applied: p.applied.length,
            pending: p.pending,
            ahead: p.ahead,
            latest: p.applied[p.applied.length - 1] || null,
        };
    } catch {
        return null;
    }
}

async function collect() {
    const { TICKS } = require('../jobs');
    const [latest, lastOk, failures, backup, migrations] = await Promise.all([
        JobRunService.latestByTick().catch(() => ({})),
        JobRunService.lastOkByTick().catch(() => ({})),
        JobRunService.recentFailures(7, 20).catch(() => []),
        require('../jobs/db-backup')
            .status()
            .catch(() => null),
        migrationsState(),
    ]);
    const now = Date.now();
    const ticks = TICKS.map((t) => {
        const last = latest[t.name] || null;
        const durationMs =
            last && last.startedAt && last.finishedAt
                ? new Date(last.finishedAt) - new Date(last.startedAt)
                : null;
        const okAt = lastOk[t.name] || null;
        const stale =
            JobRunService.DAILY_TICKS.includes(t.name) &&
            okAt &&
            now - new Date(okAt).getTime() > JobRunService.STALE_AFTER_MS;
        return {
            name: t.name,
            schedule: scheduleOf(t),
            everyMin: t.everyMin,
            bootRun: !!t.bootRun,
            last,
            durationMs,
            lastOkAt: okAt,
            next: JobRunService.nextDue(t, last && last.startedAt, now),
            daily: JobRunService.DAILY_TICKS.includes(t.name),
            stale: !!stale,
            running: !!(last && !last.finishedAt),
        };
    });

    // SMTP: configured · master switch · verified on/by · last failure.
    const AppSettingsModel = require('../models/AppSettingsModel');
    const get = async (k, d) => {
        try {
            return await AppSettingsModel.getValue(k, d);
        } catch {
            return d;
        }
    };
    const smtp = {
        host: await get('smtpHost', ''),
        enabled: Boolean(await get('enableEmailNotifications', false)),
        verifiedAt: await get('smtpVerifiedAt', null),
        verifiedBy: await get('smtpVerifiedBy', null),
        lastFailure: await get('smtpLastFailure', null),
        // 'EMAIL_FAILED' is the action EmailService.js:160 actually logs on a send
        // failure. The other two strings were the whole filter until now, and
        // 'EMAIL_SEND_FAILED' appears NOWHERE in src/ — so this counter read 0
        // even when every single send was failing, which is precisely the
        // situation the operator opens this page to diagnose.
        failures7d: await one(
            "SELECT COUNT(*)::int AS n FROM system_logs WHERE action IN ('EMAIL_TEST_FAILED','EMAIL_SEND_FAILED','EMAIL_FAILED') AND created_at >= now() - interval '7 days'"
        ),
        scheduleFailures: await one(
            "SELECT COUNT(*)::int AS n FROM report_schedules WHERE last_status LIKE 'email_failed%'"
        ),
    };

    // Database: size, largest tables, audit/telemetry volumes, retention.
    const database = {
        sizeBytes: Number(await one('SELECT pg_database_size(current_database()) AS n')) || null,
        tables: await db
            .all(
                `SELECT c.relname AS name, pg_total_relation_size(c.oid) AS bytes,
                    COALESCE(c.reltuples, 0)::bigint AS rows
               FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relkind = 'r'
              ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 8`
            )
            .catch(() => []),
        systemLogs: await one('SELECT COUNT(*)::int AS n FROM system_logs'),
        perfEvents: await one('SELECT COUNT(*)::int AS n FROM perf_events'),
        jobRuns: await one('SELECT COUNT(*)::int AS n FROM job_runs'),
        retention: {
            perfEventsDays: await get('perfEventsRetentionDays', null),
            notificationDays: await get('notificationRetentionDays', null),
            reminderLogDays: await get('reminderLogRetentionDays', null),
        },
        migrations,
    };

    let license = null;
    try {
        license = await require('../services/EntitlementService').status();
    } catch {
        license = null;
    }
    let restorePoints = [];
    try {
        restorePoints = require('../services/SqlConsoleService').listRestorePoints().slice(0, 10);
    } catch {
        restorePoints = [];
    }

    return {
        ticks,
        failures,
        backup,
        smtp,
        database,
        license,
        restorePoints,
        // Separation of duties: the SQL console is an operator (env) switch, shown
        // here so a super admin can see whether it is on without being able to flip it.
        sqlConsoleEnabled: require('../services/SqlConsoleService').isEnabled(),
        resetBackups: listResetBackups(),
        jobsMode: process.env.REDIS_URL ? 'bullmq' : 'in-process',
        generatedAt: new Date(now),
    };
}

/**
 * The reason a tick did nothing, or null when it did something.
 *
 * Two shapes are in the wild: the older jobs return `{ skipped: 'not_due' }`
 * (a string), the department brief returns `{ skipped: { notDue: 3, … } }` (a
 * breakdown). Both mean the same thing to the operator — "it ran, nothing went
 * out" — and both must be reported neutrally rather than as a success.
 */
function _skipReason(result) {
    if (!result || typeof result !== 'object') return null;
    if (typeof result.skipped === 'string') return result.skipped;
    if (result.sent > 0 || result.done === true) return null;
    if (result.skipped && typeof result.skipped === 'object') {
        const reasons = Object.entries(result.skipped)
            .filter(([, v]) => (Array.isArray(v) ? v.length : Number(v) > 0))
            .map(([k, v]) => `${k}=${Array.isArray(v) ? v.length : v}`);
        if (reasons.length) return reasons.join(', ');
        // Ran, claimed nothing, skipped nothing: there was simply nothing due.
        if (result.recipients !== undefined && !result.sent) return 'nothing_due';
    }
    return null;
}

class HealthController {
    async page(req, res) {
        const data = await collect();
        res.render('pages/admin/health', {
            title: req.t ? req.t('chrome:pt_health') : 'Instance health',
            ...data,
        });
    }

    /** "Exécuter maintenant" — one tick, under the ledger, attributed to the admin. */
    async runTick(req, res) {
        const name = String(req.params.tick || '');
        const jobs = require('../jobs');
        const tick = jobs.TICKS.find((t) => t.name === name);
        if (!tick) {
            req.flash('error', req.t ? req.t('admin:health_unknown_tick') : 'Unknown job.');
            return res.redirect('/admin/health');
        }
        const actorRef = `admin:${req.user.id}`;
        let outcome;
        try {
            const result = await jobs.runTickByName(name, { actorRef });
            outcome = { ok: true, result };
        } catch (e) {
            outcome = { ok: false, error: (e && e.message) || String(e) };
        }
        await LogService.log({
            adminId: req.user.id,
            action: 'JOB_RUN_MANUAL',
            entityType: 'job',
            category: 'system',
            severity: outcome.ok ? 'info' : 'warn',
            actorRef,
            details: `Manual run of ${name}: ${outcome.ok ? 'ok ' + JSON.stringify(outcome.result || null).slice(0, 300) : 'FAILED ' + outcome.error}`,
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
            requestId: req.id || null,
        });
        if (!outcome.ok) {
            req.flash(
                'error',
                req.t
                    ? req.t('admin:health_run_failed', { tick: name, error: outcome.error })
                    : `${name} failed: ${outcome.error}`
            );
        } else {
            // A tick that ran but did NOTHING is not a success message. Every
            // self-gated tick (manager-digest, personal-digest, dept-brief…)
            // returns `skipped` when it is outside its window, and a green "a
            // tourné" on top of "not_due" is what makes an operator believe a
            // brief went out when nothing did. The reason is shown as-is, in a
            // neutral flash.
            const reason = _skipReason(outcome.result);
            // 'warning' and NOT 'info': views/partials/flash.ejs renders success,
            // warnings and errors only — an 'info' flash is written to the session
            // and never displayed, so the operator would see NOTHING at all.
            if (reason)
                req.flash(
                    'warning',
                    req.t
                        ? req.t('admin:health_run_skipped', { tick: name, reason })
                        : `${name} ran but sent nothing (${reason}).`
                );
            else
                req.flash(
                    'success',
                    req.t ? req.t('admin:health_run_ok', { tick: name }) : `${name} ran.`
                );
        }
        res.redirect('/admin/health#ticks');
    }

    /**
     * "Renvoyer un bilan" — re-send ONE archived department brief to ONE
     * recipient, exactly as it was sent (the frozen payload is re-rendered, never
     * recomputed), under the job ledger and attributed to the admin. Same shape
     * as backupNow: a named tick object, JobRunService.run, a system-log line and
     * a flash — so a manual re-send is as auditable as a scheduled one.
     */
    async resendBrief(req, res) {
        const cadence = String(req.body.cadence || '');
        const period = String(req.body.period || '');
        const userType = req.body.userType === 'admin' ? 'admin' : 'employee';
        const userId = Number(req.body.userId);
        const actorRef = `admin:${req.user.id}`;
        const briefJob = require('../jobs/dept-brief');
        const tick = {
            name: 'dept-brief.tick',
            fn: () => briefJob.tick({ resend: { cadence, period, only: { userType, userId } } }),
        };
        let r;
        try {
            r = await JobRunService.run(tick, { trigger: 'manual', actorRef });
        } catch (e) {
            r = { errors: 1, reason: (e && e.message) || String(e) };
        }
        const ok = Boolean(r && r.sent);
        await LogService.log({
            adminId: req.user.id,
            action: ok ? 'DEPT_BRIEF_RESENT' : 'DEPT_BRIEF_RESEND_FAILED',
            entityType: 'dept_brief',
            category: 'system',
            severity: ok ? 'info' : 'warn',
            actorRef,
            details: `Manual re-send of the ${cadence} brief ${period} to ${userType}:${userId}: ${JSON.stringify(r || null).slice(0, 300)}`,
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
            requestId: req.id || null,
        });
        if (ok)
            req.flash(
                'success',
                req.t ? req.t('admin:health_run_ok', { tick: 'dept-brief.tick' }) : 'Brief re-sent.'
            );
        else
            req.flash(
                'warning',
                req.t
                    ? req.t('admin:health_run_skipped', {
                          tick: 'dept-brief.tick',
                          reason: (r && r.reason) || 'no_archived_brief',
                      })
                    : 'Nothing re-sent.'
            );
        res.redirect('/admin/health#ticks');
    }

    /** "Sauvegarder maintenant" — forced pg_dump, recorded like a scheduled run. */
    async backupNow(req, res) {
        const backupJob = require('../jobs/db-backup');
        const actorRef = `admin:${req.user.id}`;
        const tick = { name: 'db-backup.tick', fn: () => backupJob.tick({ force: true }) };
        let r;
        try {
            r = await JobRunService.run(tick, { trigger: 'manual', actorRef });
        } catch (e) {
            r = { done: false, status: 'failed: ' + ((e && e.message) || e) };
        }
        await LogService.log({
            adminId: req.user.id,
            action: r.done ? 'BACKUP_MANUAL_OK' : 'BACKUP_MANUAL_FAILED',
            entityType: 'database',
            category: 'system',
            severity: r.done ? 'info' : 'warn',
            actorRef,
            details: r.done
                ? `Manual backup written: ${r.file} (${r.sizeBytes} bytes)`
                : `Manual backup failed: ${r.status}`,
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
            requestId: req.id || null,
        });
        if (r.done)
            req.flash(
                'success',
                req.t
                    ? req.t('admin:health_backup_ok', {
                          file: r.file,
                          mb: (r.sizeBytes / 1048576).toFixed(1),
                      })
                    : `Backup written: ${r.file}`
            );
        else
            req.flash(
                'error',
                req.t
                    ? req.t('admin:health_backup_failed', { status: r.status })
                    : `Backup failed: ${r.status}`
            );
        res.redirect('/admin/health#backups');
    }

    /** History of one tick (JSON, for the expandable row). */
    async history(req, res) {
        const name = String(req.params.tick || '');
        if (!require('../jobs').TICKS.some((t) => t.name === name))
            return res.status(404).json({ error: 'unknown_tick' });
        res.json({ tick: name, runs: await JobRunService.history(name, 30) });
    }
}

const controller = new HealthController();
controller.collect = collect;
controller.scheduleOf = scheduleOf;
controller.migrationsState = migrationsState; // reused by /about
controller._skipReason = _skipReason; // pinned by tests/unit/deptBriefJob.test.js
controller.requireSuperAdminUser = (user) => RBACService.isSuperAdmin(user);
module.exports = controller;
