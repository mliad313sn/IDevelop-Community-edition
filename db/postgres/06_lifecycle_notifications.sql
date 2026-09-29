-- Phase 6 — Lifecycle (JML), Notifications, Digests, DSR, API keys rotation.
BEGIN;

CREATE TYPE lifecycle_kind  AS ENUM ('joiner', 'mover', 'leaver');
CREATE TYPE notif_channel   AS ENUM ('inapp', 'email');
CREATE TYPE notif_state     AS ENUM ('queued', 'sent', 'failed', 'snoozed');
CREATE TYPE dsr_kind        AS ENUM ('access', 'rectification', 'erasure', 'portability', 'objection');
CREATE TYPE dsr_state       AS ENUM ('received', 'in_progress', 'fulfilled', 'rejected');

CREATE TABLE lifecycle_events (
    id            BIGSERIAL PRIMARY KEY,
    employee_id   BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    kind          lifecycle_kind NOT NULL,
    payload       JSONB NOT NULL,
    occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at  TIMESTAMPTZ
);
CREATE INDEX idx_lifecycle_kind ON lifecycle_events (kind);
CREATE INDEX idx_lifecycle_unprocessed ON lifecycle_events (occurred_at) WHERE processed_at IS NULL;

CREATE TABLE pii_cleanup_jobs (
    employee_id    BIGINT PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
    country_code   TEXT NOT NULL,
    due_at         TIMESTAMPTZ NOT NULL,
    completed_at   TIMESTAMPTZ,
    notes          TEXT
);

CREATE TABLE notifications (
    id          BIGSERIAL PRIMARY KEY,
    user_type   TEXT NOT NULL CHECK (user_type IN ('admin','employee')),
    user_id     BIGINT NOT NULL,
    channel     notif_channel NOT NULL,
    kind        TEXT NOT NULL,          -- 'review.due', 'dispute.escalated', 'idp.activated', ...
    locale      TEXT NOT NULL DEFAULT 'fr',
    payload     JSONB NOT NULL,
    state       notif_state NOT NULL DEFAULT 'queued',
    sent_at     TIMESTAMPTZ,
    read_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_notifications_user ON notifications (user_type, user_id, read_at);

CREATE TABLE notification_preferences (
    user_type        TEXT NOT NULL CHECK (user_type IN ('admin','employee')),
    user_id          BIGINT NOT NULL,
    kind             TEXT NOT NULL,
    channel          notif_channel NOT NULL,
    enabled          BOOLEAN NOT NULL DEFAULT true,
    quiet_hours_start TIME,
    quiet_hours_end   TIME,
    PRIMARY KEY (user_type, user_id, kind, channel)
);

CREATE TABLE dsr_requests (
    id             BIGSERIAL PRIMARY KEY,
    employee_id    BIGINT REFERENCES employees(id) ON DELETE SET NULL,
    requested_by   TEXT NOT NULL,           -- email or external ref if non-employee
    kind           dsr_kind NOT NULL,
    requested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    due_at         TIMESTAMPTZ NOT NULL,    -- requested_at + countries.dsr_sla_days
    state          dsr_state NOT NULL DEFAULT 'received',
    fulfilled_at   TIMESTAMPTZ,
    notes          TEXT
);
CREATE INDEX idx_dsr_state ON dsr_requests (state);
CREATE INDEX idx_dsr_due_at ON dsr_requests (due_at);

CREATE TABLE api_keys (
    id           BIGSERIAL PRIMARY KEY,
    label        TEXT NOT NULL,
    key_hash     TEXT NOT NULL UNIQUE,        -- bcrypt of the raw key
    scope        TEXT NOT NULL DEFAULT 'powerbi.read',
    created_by   BIGINT NOT NULL REFERENCES admins(id) ON DELETE RESTRICT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ,
    revoked_at   TIMESTAMPTZ
);

INSERT INTO schema_meta(key, value) VALUES ('06_lifecycle_notifications', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();

COMMIT;
