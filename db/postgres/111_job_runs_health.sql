-- / , , — the background-job ledger.
--
-- Twenty-one time-based ticks run from src/jobs/index.js and, until now, the only
-- trace of any of them was a console.warn on failure plus a handful of
-- `*LastRunOn` strings scattered across app_settings. A tick that threw every
-- hour (cycle-deadline — the only thing that closes a campaign) was invisible to
-- the SuperAdmin. This table is written by the in-process scheduler, by the
-- BullMQ worker and by the "Exécuter maintenant" button on /admin/health, so
-- every run has a start, an end, an outcome and — when it failed — the error.
--
-- One row per run. `trigger` says WHO caused the run (schedule / boot / manual)
-- and `actor_ref` names the admin behind a manual run. `result` keeps whatever
-- the tick returned (small JSON), so "ran, did nothing" and "ran, sent 12" can
-- be told apart on the health page.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS job_runs (
    id          bigserial PRIMARY KEY,
    tick_name   text        NOT NULL,
    trigger     text        NOT NULL DEFAULT 'schedule'
                            CHECK (trigger IN ('schedule', 'boot', 'manual')),
    actor_ref   text,
    started_at  timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    ok          boolean,
    error       text,
    result      jsonb
);

-- The health page reads "latest run per tick" and "history of one tick"; both
-- walk this index backwards.
CREATE INDEX IF NOT EXISTS idx_job_runs_tick_started ON job_runs (tick_name, started_at DESC);

-- The ledger grows by ~30 rows an hour on a single box. It is NOT an audit
-- table (no trigger, no hash chain): telemetry-prune may trim it by age like
-- perf_events. Nothing else here is ever deleted by the application.
COMMENT ON TABLE job_runs IS 'Background-job run ledger: one row per tick execution; prunable telemetry, not audit.';

INSERT INTO schema_meta(key, value) VALUES ('111_job_runs_health', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();
