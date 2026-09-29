'use strict';

/**
 * JobRunService — the background-job ledger and the operations alerts built on it
 *.
 *
 * Every tick execution — scheduled, at boot, or from the "Exécuter maintenant"
 * button — goes through run: a `job_runs` row is opened before the tick and
 * closed with ok/error/result after it, so /admin/health can show last run,
 * status, duration and the last error per tick, and a failure raises an in-app
 * notification to the SuperAdmins instead of a console.warn nobody reads.
 *
 * The ledger is telemetry, not audit: no hash chain, prunable by age.
 *
 * Alerts are DE-DUPLICATED PER DAY on (kind, dedupKey): a backup that is stale
 * all week produces one bell entry a day, not one per hourly tick. They are
 * in-app first; the `digest` tier rolls them into the existing daily digest
 * e-mail when `emailOnDigest` is on (NotificationService.KIND_POLICY).
 */

const db = require('../config/database');

const HOUR = 60 * 60 * 1000;
/** A daily tick that has not run for this long is reported as stale. */
const STALE_AFTER_MS = 36 * HOUR;

/** Ticks that are expected to produce work at least once a day. */
const DAILY_TICKS = [
    'db-backup.tick',
    'kpi-snapshot.tick',
    'fit-history.tick',
    'telemetry-prune.tick',
    'cert-expiry.tick',
    'reminders.tick',
    'retention-recompute.tick',
];

/**
 * Fields on a tick's returned result that mean "a unit of work SUCCEEDED".
 * A many-unit tick catches per-unit errors and returns a `failed` list/count so
 * one bad unit does not abort the pass; we cross-reference these to tell a
 * partial failure (some worked) from a total one (nothing did).
 */
const SUCCESS_KEYS = [
    'captured',
    'computed',
    'sent',
    'notified',
    'processed',
    'snapshots',
    'snapshotted',
    'written',
    'inserted',
    'updated',
    'delivered',
    'healed',
    'succeeded',
    'ok',
];

const JobRunService = {
    STALE_AFTER_MS,
    DAILY_TICKS,

    /** Open a run row. Never throws — a ledger hiccup must not stop a tick. */
    async start(tickName, { trigger = 'schedule', actorRef = null } = {}) {
        try {
            const r = await db.run(
                'INSERT INTO job_runs (tick_name, trigger, actor_ref) VALUES (?, ?, ?)',
                [tickName, trigger, actorRef]
            );
            return r && r.lastID != null ? Number(r.lastID) : null;
        } catch (e) {
            console.warn('[job_runs] start failed:', e && e.message);
            return null;
        }
    },

    /** Close a run row with its outcome. `result` is kept small (JSON, ≤ 4 KB). */
    async finish(id, { ok, error = null, result = null } = {}) {
        if (id == null) return;
        let res = null;
        try {
            res = result === undefined ? null : JSON.stringify(result);
        } catch {
            res = null;
        }
        if (res && res.length > 4096)
            res = JSON.stringify({ truncated: true, head: res.slice(0, 2000) });
        try {
            await db.run(
                'UPDATE job_runs SET finished_at = now(), ok = ?, error = ?, result = ? WHERE id = ?',
                [Boolean(ok), error ? String(error).slice(0, 2000) : null, res, id]
            );
        } catch (e) {
            console.warn('[job_runs] finish failed:', e && e.message);
        }
    },

    /**
     * Run one tick under the ledger. Returns the tick's own result; a thrown
     * error is recorded, alerted, and re-thrown to the caller (the in-process
     * scheduler swallows it, a manual run reports it to the admin).
     */
    async run(tick, { trigger = 'schedule', actorRef = null } = {}) {
        const id = await this.start(tick.name, { trigger, actorRef });
        try {
            const result = await tick.fn();
            const rf = this._resultFailure(result);
            if (rf) {
                // The tick did NOT throw but reported failures in its own result
                // (per-unit errors it swallowed to keep the pass going). Without
                // this, a run where every unit failed — or one where a unit fails
                // every day — closed as ok and never alerted (findings J6, J10).
                // Alert ops (deduped daily); close the run as failed only when
                // nothing succeeded, so a normal partial pass still reads as ok on
                // the health page but the operator is still told.
                const total = rf.succeeded === 0;
                await this.finish(id, {
                    ok: !total,
                    error: total ? `tick reported ${rf.failed} failure(s), none succeeded` : null,
                    result,
                });
                await this.alert('ops.job_failed', tick.name, {
                    tick: tick.name,
                    error: `${rf.failed} unit(s) failed${total ? ', none succeeded' : `, ${rf.succeeded} succeeded`}`,
                    partial: !total,
                    link: '/admin/health',
                });
                return result;
            }
            await this.finish(id, { ok: true, result });
            return result;
        } catch (e) {
            const msg = (e && e.message) || String(e);
            await this.finish(id, { ok: false, error: msg });
            await this.alert('ops.job_failed', tick.name, {
                tick: tick.name,
                error: msg.slice(0, 300),
                link: '/admin/health',
            });
            throw e;
        }
    },

    /**
     * Inspect a tick's RETURNED result for self-reported failures the throw-only
     * path would miss. Returns { failed, succeeded } when the result declares any
     * failed unit (a `failed`/`errors` list or count), else null. `succeeded` is
     * the sum of the recognised success counters, used to distinguish a total
     * failure from a normal partial pass.
     */
    _resultFailure(result) {
        if (!result || typeof result !== 'object') return null;
        const asCount = (v) =>
            Array.isArray(v) ? v.length : Number.isFinite(Number(v)) ? Number(v) : 0;
        // Key on the `failed` convention only. Ticks that self-alert on their own
        // partial-failure counter (dept-brief's `errors`, AC-14) are left to do so;
        // `failed` is the convention used by kpi-snapshot/dept-digest/retention,
        // which do NOT self-alert and are the ones this guard exists for.
        const failed = asCount(result.failed);
        if (failed <= 0) return null;
        let succeeded = 0;
        for (const k of SUCCESS_KEYS) succeeded += asCount(result[k]);
        return { failed, succeeded };
    },

    /** Latest run per tick, keyed by tick name. */
    async latestByTick() {
        const rows = await db.all(
            `SELECT DISTINCT ON (tick_name)
                    id, tick_name AS "tickName", trigger, actor_ref AS "actorRef",
                    started_at AS "startedAt", finished_at AS "finishedAt", ok, error, result
               FROM job_runs
              ORDER BY tick_name, started_at DESC`
        );
        const out = {};
        for (const r of rows) out[r.tickName] = r;
        return out;
    },

    /** Latest SUCCESSFUL run per tick (a failing tick still shows when it last worked). */
    async lastOkByTick() {
        const rows = await db.all(
            `SELECT DISTINCT ON (tick_name) tick_name AS "tickName", finished_at AS "finishedAt"
               FROM job_runs WHERE ok = true
              ORDER BY tick_name, started_at DESC`
        );
        const out = {};
        for (const r of rows) out[r.tickName] = r.finishedAt;
        return out;
    },

    /** Recent history of one tick, newest first. */
    async history(tickName, limit = 20) {
        return db.all(
            `SELECT id, trigger, actor_ref AS "actorRef", started_at AS "startedAt",
                    finished_at AS "finishedAt", ok, error, result
               FROM job_runs WHERE tick_name = ?
              ORDER BY started_at DESC LIMIT ?`,
            [tickName, Math.max(1, Math.min(200, Number(limit) || 20))]
        );
    },

    /** Failures in the last `days` days, newest first (the health page's "recent errors"). */
    async recentFailures(days = 7, limit = 20) {
        const d = Math.max(1, Math.min(90, Number(days) || 7));
        return db.all(
            `SELECT tick_name AS "tickName", trigger, started_at AS "startedAt", error
               FROM job_runs WHERE ok = false AND started_at >= now() - interval '${d} days'
              ORDER BY started_at DESC LIMIT ?`,
            [Math.max(1, Math.min(200, Number(limit) || 20))]
        );
    },

    /**
     * Next due moment of a tick. The in-process scheduler fires every `everyMin`
     * from process start; BullMQ follows the cron. Both are approximated here
     * from the last run: "last run + period" (never in the past by more than a
     * period — a stale tick reads as "overdue").
     */
    nextDue(tick, lastStartedAt, now = Date.now()) {
        const period = (tick.everyMin || 60) * 60 * 1000;
        if (!lastStartedAt) return null;
        const last = new Date(lastStartedAt).getTime();
        if (!Number.isFinite(last)) return null;
        const next = last + period;
        return { at: new Date(next), overdue: next < now - period };
    },

    /**
     * Daily de-duplicated in-app alert to every active SuperAdmin. Returns the
     * number of admins notified (0 when today's alert already exists).
     */
    async alert(kind, dedupKey, payload = {}) {
        try {
            const key = String(dedupKey || kind);
            const dup = await db.get(
                `SELECT 1 AS x FROM notifications
                  WHERE kind = ? AND channel = 'inapp' AND created_at::date = now()::date
                    AND payload->>'dedupKey' = ? LIMIT 1`,
                [kind, key]
            );
            if (dup) return 0;
            const admins = await db.all(
                "SELECT id FROM admins WHERE role = 'superadmin' AND is_active = true"
            );
            const Notify = require('./NotificationService');
            let n = 0;
            for (const a of admins) {
                await Notify.notify({
                    userType: 'admin',
                    userId: Number(a.id),
                    kind,
                    category: 'digest',
                    payload: { ...payload, dedupKey: key, link: payload.link || '/admin/health' },
                });
                n++;
            }
            return n;
        } catch (e) {
            console.warn('[ops-alert] failed:', kind, e && e.message);
            return 0;
        }
    },

    /**
     * The watchdog ("daily tick not run > 36 h", stale backup,
     * licence): evaluated after each scheduled tick, self-gated to once an
     * hour so it costs a couple of cheap queries. Returns what it raised.
     */
    _watchdogAt: 0,
    async watchdog(now = Date.now()) {
        if (now - this._watchdogAt < HOUR) return null;
        this._watchdogAt = now;
        const raised = [];
        try {
            const lastOk = await this.lastOkByTick();
            const anyRun = Object.keys(lastOk).length > 0;
            for (const name of DAILY_TICKS) {
                const at = lastOk[name] ? new Date(lastOk[name]).getTime() : null;
                // A ledger that has never seen the tick (fresh install) is not a
                // failure; only a tick that used to run and stopped is reported.
                if (anyRun && at && now - at > STALE_AFTER_MS) {
                    if (
                        await this.alert('ops.job_failed', `stale:${name}`, {
                            tick: name,
                            staleHours: Math.round((now - at) / HOUR),
                            link: '/admin/health',
                        })
                    )
                        raised.push(name);
                }
            }
            const backup = await require('../jobs/db-backup').status();
            if (backup.stale) {
                if (
                    await this.alert('ops.backup_stale', `backup:${backup.lastRunOn || 'never'}`, {
                        lastRunOn: backup.lastRunOn,
                        status: backup.lastStatus,
                        link: '/admin/health',
                    })
                )
                    raised.push('backup');
            }
            const lic = await require('./EntitlementService').status();
            if (lic && lic.warn) {
                if (
                    await this.alert(
                        'ops.license',
                        `license:${lic.expired ? 'expired' : 'overseat'}`,
                        { expired: lic.expired, overSeat: lic.overSeat, link: '/admin/license' }
                    )
                )
                    raised.push('license');
            }
        } catch (e) {
            console.warn('[ops-watchdog] failed:', e && e.message);
        }
        return raised;
    },

    /** Trim the ledger (called by telemetry-prune; keep `days` of history). */
    async prune(days = 90) {
        const d = Math.max(7, Math.min(3650, Number(days) || 90));
        const r = await db.run(
            `DELETE FROM job_runs WHERE started_at < now() - interval '${d} days'`
        );
        return r && r.changes ? r.changes : 0;
    },
};

module.exports = JobRunService;
