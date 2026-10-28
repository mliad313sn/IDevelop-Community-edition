-- 186 — KPI targets and threshold alerts.
--
--   kpi_targets        one row per target DECISION, dated and append-only: a
--                      change is a NEW row (the history is kept, nothing is
--                      updated in place or deleted). target_value NULL = the
--                      target is withdrawn from effective_from (no target, no
--                      target line). scope_type 'org' (scope_id NULL) or 'site'
--                      (scope_id = sites.id). set_by_ref is the deciding
--                      account's ref ('admin:<id>'), reason is mandatory.
--   kpi_alert_states   the current band of each alert rule × scope, used to
--                      detect a TRANSITION: an alert fires when a band is
--                      entered, again when the episode gets worse, and
--                      « back to normal » when it ends.
--   kpi_alert_events   one row per transition (raised | worsened | recovered):
--                      the record of what was announced. Who was told is kept
--                      in reminder_log (ref_id = the event id), so a recipient
--                      is told once even when a run is repeated.
--
-- Figures only: no person, no name, no free text except the reason of a
-- target decision (written by an administrator about a KPI, never about a
-- person).
--
-- Additive and idempotent: safe to re-run. Nothing is deleted or rewritten.

CREATE TABLE IF NOT EXISTS public.kpi_targets (
    id             bigserial PRIMARY KEY,
    kpi_id         text        NOT NULL,
    scope_type     text        NOT NULL,
    scope_id       bigint,
    target_value   numeric(10, 2),
    effective_from date        NOT NULL,
    set_by_ref     text        NOT NULL,
    reason         text        NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_kpi_targets_kpi') THEN
        ALTER TABLE public.kpi_targets
            ADD CONSTRAINT chk_kpi_targets_kpi CHECK (kpi_id ~ '^K[0-9]{1,2}$');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_kpi_targets_scope') THEN
        ALTER TABLE public.kpi_targets
            ADD CONSTRAINT chk_kpi_targets_scope CHECK (
                (scope_type = 'org' AND scope_id IS NULL)
                OR (scope_type = 'site' AND scope_id IS NOT NULL)
            );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_kpi_targets_value') THEN
        ALTER TABLE public.kpi_targets
            ADD CONSTRAINT chk_kpi_targets_value CHECK (target_value IS NULL OR target_value >= 0);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_kpi_targets_reason') THEN
        ALTER TABLE public.kpi_targets
            ADD CONSTRAINT chk_kpi_targets_reason
            CHECK (length(btrim(reason)) > 0 AND char_length(reason) <= 500);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_kpi_targets_ref') THEN
        ALTER TABLE public.kpi_targets
            ADD CONSTRAINT chk_kpi_targets_ref CHECK (char_length(set_by_ref) BETWEEN 1 AND 64);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_kpi_targets_lookup
    ON public.kpi_targets (kpi_id, scope_type, scope_id, effective_from DESC, id DESC);

-- Append-only: a target decision is never rewritten nor deleted. The shared
-- public.block_mutation() guard is used on purpose, so public.append_only_tables()
-- (migration 120), and with it the SQL console's append-only protection, sees
-- this table without a list to update.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgname = 'trg_kpi_targets_immutable'
           AND tgrelid = 'public.kpi_targets'::regclass
    ) THEN
        CREATE TRIGGER trg_kpi_targets_immutable
            BEFORE UPDATE OR DELETE ON public.kpi_targets
            FOR EACH ROW EXECUTE FUNCTION public.block_mutation();
    END IF;
END $$;

COMMENT ON TABLE public.kpi_targets IS
    'KPI targets per indicator and scope (organisation or site), dated, audited and append-only (migration 186). target_value NULL = target withdrawn.';

CREATE TABLE IF NOT EXISTS public.kpi_alert_states (
    rule_key    text        NOT NULL,
    scope_key   text        NOT NULL,
    kpi_id      text        NOT NULL,
    state       text        NOT NULL,
    level       integer     NOT NULL DEFAULT 0,
    peak_level  integer     NOT NULL DEFAULT 0,
    value       numeric,
    target      numeric,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (rule_key, scope_key)
);

COMMENT ON TABLE public.kpi_alert_states IS
    'Current band of each KPI alert rule per scope (''org'' or ''site:<id>''); peak_level = the worst level of the open episode (migration 186).';

CREATE TABLE IF NOT EXISTS public.kpi_alert_events (
    id          bigserial PRIMARY KEY,
    rule_key    text        NOT NULL,
    kpi_id      text        NOT NULL,
    scope_type  text        NOT NULL,
    scope_id    bigint,
    transition  text        NOT NULL,
    from_state  text,
    to_state    text        NOT NULL,
    value       numeric,
    target      numeric,
    recipients  integer     NOT NULL DEFAULT 0,
    delivered   integer     NOT NULL DEFAULT 0,
    complete    boolean     NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_kpi_alert_events_transition') THEN
        ALTER TABLE public.kpi_alert_events
            ADD CONSTRAINT chk_kpi_alert_events_transition
            CHECK (transition IN ('raised', 'worsened', 'recovered'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_kpi_alert_events_scope') THEN
        ALTER TABLE public.kpi_alert_events
            ADD CONSTRAINT chk_kpi_alert_events_scope
            CHECK (scope_type IN ('org', 'site'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_kpi_alert_events_open
    ON public.kpi_alert_events (created_at) WHERE complete = false;

COMMENT ON TABLE public.kpi_alert_events IS
    'One row per KPI alert transition (raised, worsened, recovered) and how many recipients were told (migration 186). Figures only, never a person.';

SELECT public.fn_console_reader_sync();
