-- 150 — Safety-competency gate (« Habilitations sécurité »)
--
-- A permit-to-work / access-control system needs one answer per person:
-- may this person be sent to a safety-critical task today? The answer is
-- derived from data the product already holds (resolved assessment levels,
-- the certification register and its lapse view), filtered through a small
-- configuration: per role (optionally narrowed to one site), the CRITICAL
-- skills, the minimum level for each, and whether a currently valid
-- certificate is mandatory.
--
--   safety_gate_rules            the configuration. Nothing is ever deleted: a
--                                rule is deactivated with a reason.
--   safety_gate_settings         single row: warning window (days) before a
--                                certificate expiry, optional outgoing webhook
--                                (URL + secret encrypted by utils/secretBox).
--   safety_gate_status           last KNOWN status per employee. Never served as
--                                the answer (the answer is always recomputed);
--                                it exists to detect a CHANGE, so that every
--                                change is logged exactly once.
--   safety_gate_status_history   append-only trail of every change.
--   safety_gate_webhook_deliveries  outgoing notifications with retry/backoff.
--
-- Additive and idempotent.

CREATE TABLE IF NOT EXISTS safety_gate_rules (
    id                  bigserial   PRIMARY KEY,
    role_id             bigint      NOT NULL REFERENCES roles(id),
    site_id             bigint      REFERENCES sites(id),
    skill_id            bigint      NOT NULL REFERENCES skills(id),
    min_level           smallint    NOT NULL,
    cert_required       boolean     NOT NULL DEFAULT false,
    is_active           boolean     NOT NULL DEFAULT true,
    deactivated_reason  text,
    deactivated_at      timestamptz,
    deactivated_by      bigint,
    created_by          bigint,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_by          bigint,
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_safety_gate_rule_level CHECK (min_level BETWEEN 1 AND 4),
    CONSTRAINT chk_safety_gate_rule_deact CHECK (is_active OR deactivated_reason IS NOT NULL)
);

-- One ACTIVE rule per (role, site-or-all, skill).
CREATE UNIQUE INDEX IF NOT EXISTS ux_safety_gate_rules_active
    ON safety_gate_rules (role_id, COALESCE(site_id, 0), skill_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS ix_safety_gate_rules_role ON safety_gate_rules (role_id) WHERE is_active;

CREATE TABLE IF NOT EXISTS safety_gate_settings (
    id                   smallint    PRIMARY KEY DEFAULT 1,
    expiry_warning_days  integer     NOT NULL DEFAULT 30,
    webhook_url          text,
    webhook_secret       text,
    webhook_enabled      boolean     NOT NULL DEFAULT false,
    updated_by           bigint,
    updated_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_safety_gate_settings_single CHECK (id = 1),
    CONSTRAINT chk_safety_gate_settings_days CHECK (expiry_warning_days BETWEEN 1 AND 365)
);
-- Daily claim for the nightly recompute (jobs/safety-gate.js): one run per day
-- even with several instances, via UPDATE … WHERE last_recompute_on < today.
ALTER TABLE safety_gate_settings ADD COLUMN IF NOT EXISTS last_recompute_on date;
INSERT INTO safety_gate_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS safety_gate_status (
    employee_id   bigint      PRIMARY KEY REFERENCES employees(id),
    status        text        NOT NULL,
    reasons       jsonb       NOT NULL DEFAULT '[]'::jsonb,
    next_expiry   date,
    fingerprint   text        NOT NULL,
    computed_at   timestamptz NOT NULL DEFAULT now(),
    changed_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_safety_gate_status CHECK (status IN ('CLEARED', 'BLOCKED', 'EXPIRING', 'NOT_CONFIGURED'))
);

CREATE TABLE IF NOT EXISTS safety_gate_status_history (
    id               bigserial   PRIMARY KEY,
    employee_id      bigint      NOT NULL REFERENCES employees(id),
    previous_status  text,
    status           text        NOT NULL,
    reasons          jsonb       NOT NULL DEFAULT '[]'::jsonb,
    next_expiry      date,
    source           text        NOT NULL,
    changed_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_safety_gate_history_emp ON safety_gate_status_history (employee_id, changed_at DESC);

CREATE TABLE IF NOT EXISTS safety_gate_webhook_deliveries (
    id               bigserial   PRIMARY KEY,
    employee_id      bigint      REFERENCES employees(id),
    event            text        NOT NULL,
    payload          text        NOT NULL,
    state            text        NOT NULL DEFAULT 'pending',
    attempts         integer     NOT NULL DEFAULT 0,
    status_code      integer,
    last_error       text,
    next_attempt_at  timestamptz NOT NULL DEFAULT now(),
    delivered_at     timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_safety_gate_delivery_state CHECK (state IN ('pending', 'delivered', 'abandoned'))
);
CREATE INDEX IF NOT EXISTS ix_safety_gate_delivery_due
    ON safety_gate_webhook_deliveries (next_attempt_at) WHERE state = 'pending';
