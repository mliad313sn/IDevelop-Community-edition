-- 160 — HRIS synchronisation (connector framework, Personio, Lucca, CSV drop folder)
--
-- People data could only come in through the Excel/CSV import screens or SCIM.
-- This migration adds the storage behind src/integrations/hris and
-- src/services/HrisSyncService:
--
--   hris_connectors      one row per connector (csv | personio | lucca). At most
--                        ONE is enabled at a time. `config` holds non-secret
--                        settings (base URL, folder, column/attribute names);
--                        `credentials` is a secretBox ciphertext ('enc:v1:…')
--                        and is never sent back to the browser.
--   hris_value_mappings  external value → local unit, shared by every connector
--                        AND by SCIM placement: a department name, a site, a
--                        service or a job title mapped to a local id. A value
--                        that maps nowhere is reported, never invented.
--   hris_links           external id ↔ employee, per provider. This is what
--                        makes a second run idempotent: a linked person is
--                        compared, not created again.
--   hris_sync_runs       one row per run: dry run or apply, who or what
--                        triggered it, the counts, the plan and the errors.
--                        The normalised records are kept only until the run is
--                        applied (or superseded), so a reviewed plan is what
--                        gets applied.
--
-- Plus one setting, off by default: hris.scimAutoPlace (SCIM joiners are
-- placed directly when every value maps).
--
-- Additive and idempotent. Nothing existing is altered.

CREATE TABLE IF NOT EXISTS hris_connectors (
    id                  bigserial   PRIMARY KEY,
    provider            text        NOT NULL,
    enabled             boolean     NOT NULL DEFAULT false,
    config              jsonb       NOT NULL DEFAULT '{}'::jsonb,
    credentials         text,
    auto_apply          boolean     NOT NULL DEFAULT false,
    leaver_guard_pct    numeric(5,2) NOT NULL DEFAULT 10,
    schedule_hour       integer     NOT NULL DEFAULT 2,
    last_scheduled_on   date,
    last_success_at     timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    updated_by          text,
    CONSTRAINT uq_hris_connectors_provider UNIQUE (provider),
    CONSTRAINT chk_hris_connectors_provider CHECK (provider IN ('csv', 'personio', 'lucca')),
    CONSTRAINT chk_hris_connectors_guard CHECK (leaver_guard_pct > 0 AND leaver_guard_pct <= 100),
    CONSTRAINT chk_hris_connectors_hour CHECK (schedule_hour BETWEEN 0 AND 23)
);
-- One enabled connector at a time: the scheduled job must know which to run.
CREATE UNIQUE INDEX IF NOT EXISTS uq_hris_connectors_one_enabled
    ON hris_connectors ((true)) WHERE enabled;

CREATE TABLE IF NOT EXISTS hris_value_mappings (
    id              bigserial   PRIMARY KEY,
    kind            text        NOT NULL,
    external_value  text        NOT NULL,
    external_key    text        NOT NULL,
    target_id       bigint      NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    created_by      text,
    CONSTRAINT chk_hris_value_mappings_kind CHECK (kind IN ('site', 'department', 'service', 'role')),
    CONSTRAINT uq_hris_value_mappings UNIQUE (kind, external_key)
);

CREATE TABLE IF NOT EXISTS hris_links (
    id              bigserial   PRIMARY KEY,
    provider        text        NOT NULL,
    external_id     text        NOT NULL,
    employee_id     bigint      NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    last_seen_at    timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_hris_links_external UNIQUE (provider, external_id),
    CONSTRAINT uq_hris_links_employee UNIQUE (provider, employee_id)
);
CREATE INDEX IF NOT EXISTS idx_hris_links_employee ON hris_links (employee_id);

CREATE TABLE IF NOT EXISTS hris_sync_runs (
    id              bigserial   PRIMARY KEY,
    provider        text        NOT NULL,
    mode            text        NOT NULL,
    status          text        NOT NULL,
    trigger         text        NOT NULL,
    actor_ref       text,
    source_label    text,
    started_at      timestamptz NOT NULL DEFAULT now(),
    finished_at     timestamptz,
    counts          jsonb       NOT NULL DEFAULT '{}'::jsonb,
    plan            jsonb,
    records         jsonb,
    errors          jsonb       NOT NULL DEFAULT '[]'::jsonb,
    applied_from    bigint,
    CONSTRAINT chk_hris_sync_runs_mode CHECK (mode IN ('dry_run', 'apply')),
    CONSTRAINT chk_hris_sync_runs_status CHECK (status IN ('running', 'planned', 'applied', 'aborted', 'failed', 'superseded')),
    CONSTRAINT chk_hris_sync_runs_trigger CHECK (trigger IN ('manual', 'upload', 'schedule', 'test'))
);
CREATE INDEX IF NOT EXISTS idx_hris_sync_runs_started ON hris_sync_runs (started_at DESC);

INSERT INTO app_settings (setting_key, setting_value, setting_type, description, category)
VALUES ('hris.scimAutoPlace', 'false', 'boolean',
        'SCIM provisioning: place a new user directly (site, department, service, role, supervisor) when every value of the SCIM enterprise extension maps through the HRIS mapping rules; otherwise the request waits in the onboarding queue.',
        'onboarding')
ON CONFLICT (setting_key) DO NOTHING;
