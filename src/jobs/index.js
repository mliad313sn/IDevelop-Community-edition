'use strict';

/**
 *   src/jobs/index.js — background-job boot. Two runtimes, ONE tick registry:
 *
 *     - BullMQ (REDIS_URL set): repeatable jobs on the cycle-events queue,
 *       scales across instances.
 *     - In-process setInterval fallback (no Redis): singleton via a PG
 *       advisory lock; the default single-box Windows install uses this.
 *
 *   Every time-based tick MUST be declared in TICKS below — both runtimes
 *   iterate that registry, so a tick can never exist in one path only
 *   (the v3.22.3 telemetry-prune drift). Event-driven jobs (cycle.closed,
 *   notifications, lifecycle) stay outside the registry.
 *
 *   Workers are intentionally thin — the heavy lifting lives in the
 *   *Service classes; jobs just call them.
 */

let Queue, Worker, QueueEvents;
try {
    ({ Queue, Worker, QueueEvents } = require('bullmq'));
} catch {
    /* deferred install */
}
let IORedis;
try {
    IORedis = require('ioredis');
} catch {
    /* deferred install */
}

// ---------------------------------------------------------------------------
// Shared tick registry — the single source of truth for time-based jobs.
//   name     BullMQ job name on the cycle-events queue
//   cron     BullMQ repeat pattern (hourly ticks are minute-staggered)
//   everyMin in-process setInterval period
//   keep     BullMQ removeOnComplete/removeOnFail history depth
//   bootRun  also fire once at startup (idempotent ticks only)
// requires stay lazy (inside fn) so booting never loads optional services.
// ---------------------------------------------------------------------------
const TICKS = [
    {
        name: 'dispute-escalator.tick',
        cron: '*/15 * * * *',
        everyMin: 15,
        keep: 100,
        fn: () => require('./dispute-escalator').tick(),
    }, // dispute SLA escalation
    {
        name: 'notifications.release-snoozed',
        cron: '*/15 * * * *',
        everyMin: 15,
        keep: 100,
        fn: () => require('../services/NotificationService').releaseSnoozed(),
    },
    {
        name: 'priority-index.refresh',
        cron: '0 * * * *',
        everyMin: 60,
        keep: 100,
        fn: () => {
            try {
                return require('../services/PriorityIndexService').refresh();
            } catch {
                return null;
            }
        },
    }, // service optional
    {
        name: 'lms.sync.tick',
        cron: '0 * * * *',
        everyMin: 60,
        keep: 50,
        fn: () => {
            try {
                return require('../services/LmsService').runScheduledSync();
            } catch {
                return null;
            }
        },
    }, // hourly catalog + completion poll; service optional
    {
        name: 'report-scheduler.tick',
        cron: '*/15 * * * *',
        everyMin: 15,
        keep: 50,
        fn: () => require('./report-scheduler').tick(),
    }, // only DUE schedules actually run
    {
        name: 'fit-history.tick',
        cron: '10 * * * *',
        everyMin: 60,
        keep: 30,
        bootRun: true,
        fn: () => require('./fit-history').tick(),
    }, // daily fit snapshot (idempotent per day)
    {
        name: 'kpi-snapshot.tick',
        cron: '8 * * * *',
        everyMin: 60,
        keep: 30,
        bootRun: true,
        fn: () => require('./kpi-snapshot').tick(),
    }, // daily executive KPI-strip snapshot, org + per site (idempotent per day) — the ONLY source of the dashboard's "+x since" deltas
    {
        name: 'manager-digest.tick',
        cron: '20 * * * *',
        everyMin: 60,
        keep: 30,
        fn: () => require('./manager-digest').tick(),
    }, // weekly digest (self-gated to DOW/hour)
    {
        name: 'dept-digest.tick',
        cron: '25 * * * *',
        everyMin: 60,
        keep: 30,
        fn: () => require('./dept-digest').tick(),
    }, // opt-in bi-weekly/monthly departmental status report (self-gated to due subscriptions)
    {
        name: 'cert-expiry.tick',
        cron: '15 * * * *',
        everyMin: 60,
        keep: 30,
        fn: () => require('./cert-expiry').tick(),
    }, // 90/60/30/expired certification alerts + LMS refresher auto-assign (daily-gated)
    {
        name: 'coverage-check.tick',
        cron: '35 * * * *',
        everyMin: 60,
        keep: 30,
        fn: () => require('./coverage-check').tick(),
    }, // safe-shift rule evaluation; alerts only on breach TRANSITIONS
    {
        name: 'cycle-nudge.tick',
        cron: '45 * * * *',
        everyMin: 60,
        keep: 30,
        fn: () => require('./cycle-nudge').tick(),
    }, // campaign reminders/escalations (exactly-once via nudge_log)
    {
        name: 'cycle-deadline.tick',
        cron: '50 * * * *',
        everyMin: 60,
        keep: 30,
        fn: () => require('./cycle-deadline').tick(),
    }, // acts on closes_at: locks an overdue OPEN cycle, flags it weekly to the superadmins, then PROPOSES a closure after cycleClosureProposalDays. Since arbitrage A8 (13/09/2026) it never closes a campaign itself — a human accepts the proposal, and that close is what emits 'cycle.closed' → IDP drafts
    // Minute :22 is free (taken: */15, 0, 5, 8, 10, 12, 15, 18, 20, 25, 30, 35,
    // 40, 45, 50 ×2, 55) and — deliberately — EARLIER than personal-digest (:30),
    // whose claim is per DAY: a notification written after :30 could not be
    // e-mailed before tomorrow. It also sits well away from :45 (cycle-nudge) and
    // :50 (cycle-deadline), which can LOCK a campaign minutes after a brief has
    // asked the reader to act on it.
    // `bootRun` is safe here — and necessary: without it the Redis-less in-process
    // fallback (the real mode on this box and on the appliance) fires nothing
    // before start + 60 min, so a Windows machine rebooted more often than hourly
    // would NEVER send a brief. It cannot double-send, because the gate is an
    // atomic INSERT … ON CONFLICT DO NOTHING on dept_briefs.
    // NOT in JobRunService.DAILY_TICKS on purpose: STALE_AFTER_MS is 36 h, so a
    // cadence that is monthly or yearly by design would raise an ops.job_failed
    // alert to every SuperAdmin every single day and wear a permanent "stale" badge.
    {
        name: 'dept-brief.tick',
        cron: '22 * * * *',
        everyMin: 60,
        keep: 30,
        bootRun: true,
        fn: () => require('./dept-brief').tick(),
    }, // weekly/monthly/quarterly/yearly department brief (exactly-once via the dept_briefs UNIQUE; self-gated on the closed period)
    {
        name: 'personal-digest.tick',
        cron: '30 * * * *',
        everyMin: 60,
        keep: 30,
        fn: () => require('./personal-digest').tick(),
    }, // daily rollup of each user's unread in-app notifications (once/day claim; the "no mailbox invasion" batcher)
    {
        name: 'reminders.tick',
        cron: '5 * * * *',
        everyMin: 60,
        keep: 30,
        fn: () => require('./reminders').tick(),
    },
    {
        name: 'feedback360.tick',
        cron: '47 * * * *',
        everyMin: 60,
        keep: 30,
        fn: () => require('./feedback360').tick(),
    }, // 360° feedback: close rounds past their deadline, remind non-responders (development module only) // "nothing slips" nudges — IDP signoff stall / LMS unstarted / survey non-responders / access-review (exactly-once via reminder_log)
    // ---- Proactive continuity, retention & handover automation -------------
    // Key-person risk had no tick at all: succession queries ran only when
    // somebody opened /v2/continuity, and retention risk was computed only by a
    // per-employee button. These three make the module act on its own. Each is
    // hourly here and SELF-GATES internally (weekly / daily / monthly), the same
    // contract as reminders, cert-expiry and manager-digest.
    {
        name: 'succession-review.tick',
        cron: '55 * * * *',
        everyMin: 60,
        keep: 30,
        fn: () => require('./succession-review').tick(),
    }, // weekly: plans past review_due + critical roles with an empty bench (exactly-once via reminder_log)
    {
        name: 'retention-recompute.tick',
        cron: '12 * * * *',
        everyMin: 60,
        keep: 30,
        fn: () => require('./retention-recompute').tick(),
    }, // nightly sweep of the active population; notifies a manager only on a CROSSING into high
    // 3.23.18: safety-competency gate — catches overnight cert expiries and leavers.
    {
        name: 'safety-gate.tick',
        cron: '*/15 * * * *',
        everyMin: 15,
        keep: 50,
        bootRun: true,
        fn: () => require('./safety-gate').tick(),
    },
    // 3.23.18: daily anchor of the audit hash-chain head OUTSIDE the database
    // (ProgramData\IDevelop\audit-anchors) — a rewritten chain no longer matches.
    {
        name: 'audit-anchor.tick',
        cron: '41 * * * *',
        everyMin: 60,
        keep: 30,
        fn: () => require('./audit-anchor').tick(),
    },
    // 3.23.18: daily-gated retention sweep; report-only until retentionPurgeMode='apply'.
    {
        name: 'retention-purge.tick',
        cron: '28 * * * *',
        everyMin: 60,
        keep: 30,
        fn: () => require('./retention-purge').tick(),
    },
    {
        name: 'planning-digest.tick',
        cron: '18 * * * *',
        everyMin: 60,
        keep: 30,
        fn: () => require('./planning-digest').tick(),
    }, // monthly per-manager brief: cert expiries + empty benches + newly-high retention risk
    {
        name: 'db-backup.tick',
        cron: '40 * * * *',
        everyMin: 60,
        keep: 30,
        fn: () => require('./db-backup').tick(),
    }, // daily pg_dump (idempotent per day)
    // 3.23.20 (C3c): SSO migration invitations (outbox of migration 153). Waits
    // while SSO is not live; exactly-once per (account, provider) by design.
    {
        name: 'sso-invites.tick',
        cron: '*/5 * * * *',
        everyMin: 5,
        keep: 50,
        fn: () => require('./sso-invites').tick(),
    },
    {
        name: 'telemetry-prune.tick',
        cron: '50 * * * *',
        everyMin: 60,
        keep: 30,
        bootRun: true,
        fn: () => require('./telemetry-prune').tick(),
    }, // perf_events + read notifications — NOT the immutable audit log
];

// Fail fast on a malformed entry rather than silently skipping a tick.
for (const t of TICKS) {
    if (!t.name || !t.cron || !(t.everyMin > 0) || !(t.keep > 0) || typeof t.fn !== 'function') {
        throw new Error(`[jobs] invalid TICKS registry entry: ${t && t.name}`);
    }
}

function buildConnection() {
    if (!process.env.REDIS_URL || !IORedis) return null;
    return new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
}

function boot() {
    const connection = buildConnection();
    if (!connection || !Queue) {
        console.log('[jobs] Redis/BullMQ not configured — workers disabled');
        return { queues: {}, workers: {} };
    }

    const queues = {
        cycleEvents: new Queue('cycle-events', { connection }),
        notifications: new Queue('notifications', { connection }),
        digests: new Queue('digests', { connection }),
        lifecycle: new Queue('lifecycle', { connection }),
    };

    const workers = {
        cycleEvents: new Worker(
            'cycle-events',
            async (job) => {
                if (job.name === 'cycle.closed') {
                    // event-driven, not a tick
                    const { cycleId, locale } = job.data || {};
                    const IDPService = require('../services/IDPService');
                    return IDPService.generateDrafts(cycleId, { locale });
                }
                const tick = TICKS.find((t) => t.name === job.name);
                // Same ledger as the in-process path: a BullMQ run is a job_runs
                // row too, so /admin/health reads the same under both runtimes.
                return tick ? runTick(tick, { trigger: 'schedule' }) : null;
            },
            { connection }
        ),

        notifications: new Worker(
            'notifications',
            async (job) => {
                const Notify = require('../services/NotificationService');
                return Notify.send(job.data);
            },
            { connection }
        ),

        lifecycle: new Worker(
            'lifecycle',
            async (job) => {
                const Lfc = require('../services/LifecycleService');
                return Lfc.handle(job.name, job.data);
            },
            { connection }
        ),
    };

    // Cron schedules — every tick in the shared registry, nothing else.
    for (const t of TICKS) {
        queues.cycleEvents.add(
            t.name,
            {},
            {
                repeat: { pattern: t.cron },
                removeOnComplete: t.keep,
                removeOnFail: t.keep,
            }
        );
        // bootRun ticks are idempotent — enqueue a one-off so the boot-run
        // happens under Redis too, not just in-process.
        if (t.bootRun) {
            queues.cycleEvents.add(t.name, {}, { removeOnComplete: t.keep, removeOnFail: t.keep });
        }
    }

    return { queues, workers };
}

// ---------------------------------------------------------------------------
// Redis-less fallback. The default single-box Windows install has no Redis, so
// BullMQ stays disabled and the time-based business logic (dispute SLA
// escalation, LMS catalog/completion sync, snoozed-notification release,
// priority-index refresh) would otherwise NEVER run. This in-process scheduler
// runs those same ticks via setInterval. Single-instance only — multi-instance
// deployments MUST use Redis (this would double-run).
// ---------------------------------------------------------------------------
const MIN = 60 * 1000;
// Distinct bigint key for the singleton in-process-scheduler leader lock.
const SCHEDULER_LOCK_KEY = 4337210001;

/**
 * Run one registry tick under the job ledger. The ledger row is what
 * /admin/health shows; a failure is recorded there and raised to the
 * SuperAdmins as an `ops.job_failed` notification (JobRunService.run). The
 * error is re-thrown so a manual run can report it — the scheduler paths wrap
 * this in _safe and never let a tick kill the process.
 */
function runTick(tick, { trigger = 'schedule', actorRef = null } = {}) {
    return require('../services/JobRunService').run(tick, { trigger, actorRef });
}

/** Run a tick by name (the "Exécuter maintenant" button). Unknown name → null. */
async function runTickByName(name, { actorRef = null } = {}) {
    const tick = TICKS.find((t) => t.name === name);
    if (!tick) return null;
    return runTick(tick, { trigger: 'manual', actorRef });
}

/**
 * Close the runs a killed process left open.
 *
 * JobRunService.start inserts a row with finished_at NULL and finish closes
 * it — so a `kill`, a Windows restart or a crash mid-tick leaves the row open
 * forever, and /admin/health reads `running: !!(last && !last.finishedAt)`
 * (HealthController.js:73): the tick shows as "en cours d'exécution"
 * permanently, which is indistinguishable from a genuinely hung job and hides
 * every later run behind a lie.
 *
 * Two hours is comfortably longer than any tick here and shorter than the
 * hourly cadence, so a run still open at boot is dead by definition. Only the
 * scheduler LEADER reaps, so a second instance never closes a run the leader is
 * actually executing.
 */
async function reapOrphanRuns() {
    try {
        const db = require('../config/database');
        const r = await db.run(
            `UPDATE job_runs SET finished_at = now(), ok = false, error = 'process terminated'
              WHERE finished_at IS NULL AND started_at < now() - interval '2 hours'`
        );
        const n = (r && r.changes) || 0;
        if (n)
            console.log(`[jobs] reaped ${n} orphan job run(s) left open by a terminated process`);
        return n;
    } catch (e) {
        console.warn('[jobs] orphan-run reaper failed:', e && e.message);
        return 0;
    }
}

async function _safe(tick, trigger = 'schedule') {
    try {
        const r = await runTick(tick, { trigger });
        // The ops watchdog (stale daily ticks, stale backup, licence) rides on the
        // scheduler and self-gates to once an hour — no 22nd tick to register.
        if (trigger === 'schedule')
            require('../services/JobRunService')
                .watchdog()
                .catch(() => {});
        return r;
    } catch (e) {
        console.warn('[jobs:inproc] tick failed:', tick && tick.name, e && e.message);
        return undefined;
    }
}

/**
 * Become the singleton scheduler by holding a SESSION-level advisory lock on a
 * dedicated, long-lived connection. Across N app instances only ONE acquires it,
 * so the time-based ticks never double-fire when someone runs multiple instances
 * without Redis. Returns the held client (leader), or null (another instance leads).
 * On a DB hiccup it returns 'unknown' so the default single box is never blocked.
 */
async function _acquireSchedulerLeader() {
    const db = require('../config/database');
    try {
        const client = await db.pool.connect();
        const r = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [
            SCHEDULER_LOCK_KEY,
        ]);
        if (r.rows[0] && r.rows[0].locked) return client; // leader — keep client so the lock stays held
        client.release();
        return null;
    } catch (e) {
        console.warn(
            '[jobs:inproc] leader-lock check failed, proceeding (single-box default):',
            e && e.message
        );
        return 'unknown';
    }
}

function bootInProcess() {
    const state = { mode: 'in-process', timers: [], leaderClient: null };

    // Operators can disable in-process ticks on a node (e.g. behind a LB where one
    // dedicated worker runs them) without needing Redis.
    if (process.env.DISABLE_INPROC_JOBS === '1') {
        console.log('[jobs] in-process scheduler disabled (DISABLE_INPROC_JOBS=1)');
        return state;
    }

    (async () => {
        const lease = await _acquireSchedulerLeader();
        if (lease === null) {
            console.log(
                '[jobs] in-process scheduler: another instance holds the leader lock — ticks disabled here'
            );
            return;
        }
        if (lease && typeof lease.query === 'function') state.leaderClient = lease; // hold the lock for process life

        // Anything still "running" when the leader boots was killed with the
        // previous process — close it before the health page reports it as live.
        await reapOrphanRuns();

        const every = (ms, tick) => {
            const t = setInterval(() => _safe(tick), ms);
            if (t.unref) t.unref();
            state.timers.push(t);
        };
        // Same shared registry as the BullMQ path — see TICKS at the top.
        for (const t of TICKS) {
            every(t.everyMin * MIN, t);
            if (t.bootRun) _safe(t, 'boot');
        }

        console.log(
            `[jobs] in-process scheduler started (${state.timers.length} ticks; no Redis — singleton via advisory lock)`
        );
    })();

    return state;
}

/**
 * Boot background jobs. Prefers BullMQ when REDIS_URL is set (scales across
 * instances); otherwise falls back to the in-process scheduler so the default
 * install still runs its time-based workflows. Safe to call once at startup.
 */
let _handle = null;
function start() {
    const bull = boot();
    if (bull && bull.queues && Object.keys(bull.queues).length) {
        console.log('[jobs] BullMQ workers active (Redis)');
        _handle = { mode: 'bullmq', ...bull };
    } else {
        _handle = bootInProcess();
    }
    return _handle;
}

/**
 * Graceful shutdown: clear the in-process interval timers and close BullMQ
 * workers/queues so a service restart doesn't leave dangling Redis locks or
 * fire a tick mid-exit. Best-effort and bounded — never blocks shutdown.
 */
async function stop() {
    try {
        // In-process mode: _handle IS the state object returned by bootInProcess.
        if (_handle && _handle.mode === 'in-process' && Array.isArray(_handle.timers)) {
            _handle.timers.forEach((t) => {
                try {
                    clearInterval(t);
                } catch (_) {}
            });
            _handle.timers.length = 0;
            // Release the held advisory leader lock + return the client to the pool
            // so a restart can immediately re-acquire the singleton lock.
            if (_handle.leaderClient && typeof _handle.leaderClient.release === 'function') {
                try {
                    _handle.leaderClient.release();
                } catch (_) {
                    /* noop */
                }
                _handle.leaderClient = null;
            }
        }
    } catch (_) {
        /* noop */
    }
    try {
        if (_handle && _handle.mode === 'bullmq') {
            const closers = [];
            for (const w of Object.values(_handle.workers || {}))
                if (w && w.close) closers.push(w.close());
            for (const q of Object.values(_handle.queues || {}))
                if (q && q.close) closers.push(q.close());
            await Promise.race([
                Promise.allSettled(closers),
                new Promise((r) => setTimeout(r, 4000)),
            ]);
        }
    } catch (_) {
        /* noop */
    }
}

/**
 * Fire an event-driven job (e.g. 'cycle.closed'). Under BullMQ it enqueues onto the
 * cycle-events queue; on the Redis-less default box (no queue) it runs the same
 * handler inline so the automation still happens. Best-effort — never throws into
 * the caller's request path.
 */
async function emitEvent(name, data = {}) {
    try {
        if (_handle && _handle.mode === 'bullmq' && _handle.queues && _handle.queues.cycleEvents) {
            return await _handle.queues.cycleEvents.add(name, data, {
                removeOnComplete: 100,
                removeOnFail: 100,
            });
        }
        // In-process fallback: mirror the cycle-events worker's handler.
        if (name === 'cycle.closed') {
            const IDPService = require('../services/IDPService');
            return await IDPService.generateDrafts(data.cycleId, { locale: data.locale || 'fr' });
        }
    } catch (e) {
        console.warn('[jobs] emitEvent failed:', name, e && e.message);
    }
    return null;
}

module.exports = {
    boot,
    bootInProcess,
    start,
    stop,
    emitEvent,
    runTick,
    runTickByName,
    reapOrphanRuns,
    TICKS,
};
