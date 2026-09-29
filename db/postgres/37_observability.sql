-- 37_observability.sql — event tracking & reconciliation.
-- Adds correlation + queryable request facets to the append-only audit log, plus a
-- separate (rotatable, non-hash-chained) perf_events stream for slow requests/queries
-- and DB error codes. All statements idempotent so the patch installer can re-run.

-- 1) system_logs: correlation id + structured HTTP facets + taxonomy + reliable actor.
ALTER TABLE system_logs ADD COLUMN IF NOT EXISTS request_id  uuid;
ALTER TABLE system_logs ADD COLUMN IF NOT EXISTS severity    text;   -- info | warn | error | critical
ALTER TABLE system_logs ADD COLUMN IF NOT EXISTS category    text;   -- audit | auth | http | perf | db | security
ALTER TABLE system_logs ADD COLUMN IF NOT EXISTS http_method text;
ALTER TABLE system_logs ADD COLUMN IF NOT EXISTS route       text;   -- normalized path (low cardinality)
ALTER TABLE system_logs ADD COLUMN IF NOT EXISTS status_code int;
ALTER TABLE system_logs ADD COLUMN IF NOT EXISTS latency_ms  int;
ALTER TABLE system_logs ADD COLUMN IF NOT EXISTS actor_ref   text;   -- e.g. 'manager#42' — reliable for non-admins

CREATE INDEX IF NOT EXISTS idx_system_logs_request_id ON system_logs(request_id);
CREATE INDEX IF NOT EXISTS idx_system_logs_status     ON system_logs(status_code);
CREATE INDEX IF NOT EXISTS idx_system_logs_severity   ON system_logs(severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_logs_route      ON system_logs(route, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_logs_created    ON system_logs(created_at DESC);

-- 2) perf_events: high-volume telemetry, intentionally NOT tamper-evident so the
-- cleanup service can prune it. One row per slow request/slow query/db error.
CREATE TABLE IF NOT EXISTS perf_events (
    id          bigserial PRIMARY KEY,
    request_id  uuid,
    kind        text NOT NULL,          -- 'slow_request' | 'slow_query' | 'tx_rollback' | 'db_error'
    route       text,
    sql_snippet text,
    latency_ms  int,
    pg_code     text,                    -- 40P01 deadlock, 40001 serialization, 23503 FK, 57014 timeout...
    status_code int,
    detail      jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_perf_events_created ON perf_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_perf_events_kind    ON perf_events(kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_perf_events_reqid   ON perf_events(request_id);
CREATE INDEX IF NOT EXISTS idx_perf_events_route   ON perf_events(route, created_at DESC);
