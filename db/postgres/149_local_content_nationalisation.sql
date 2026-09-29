-- 149 — Local content: nationalisation succession plans + regulator packs
--
-- Mining local-content laws in the countries this product serves (Mali,
-- Burkina Faso, Guinea, Côte d'Ivoire, Senegal) require an operator to PLAN the
-- replacement of expatriates by nationals and to PROVE it, period by period.
--
-- 1) lc_nationalisation_plans — one plan per expatriate-held position (the
--    expatriate incumbent + the role they hold), with a target date. Its
--    lifecycle is a STATE (active → achieved | cancelled) with a reason and an
--    actor; nothing is ever deleted. The displayed status (planned /
--    in_progress / at_risk / overdue / achieved) is COMPUTED from the dates and
--    the successors' measured readiness, never stored.
-- 2) lc_nationalisation_successors — the named national successor(s) of a
--    plan, each optionally linked to that person's IDP. Withdrawing a successor
--    is a state + reason, not a deletion.
-- 3) lc_nationalisation_events — append-only journal of every act (who, what,
--    why). UPDATE and DELETE are refused by trigger.
-- 4) lc_regulatory_packs — the per-country, per-period regulator pack: a frozen
--    JSON snapshot. A draft may be regenerated; once PUBLISHED its content is
--    immutable (trigger), and a later version SUPERSEDES it (the old row stays,
--    marked superseded, pointing at its successor). No pack is ever deleted.
--
-- Additive and idempotent.

CREATE TABLE IF NOT EXISTS public.lc_nationalisation_plans (
    id                     bigserial PRIMARY KEY,
    role_id                bigint      NOT NULL REFERENCES public.roles(id),
    incumbent_employee_id  bigint      NOT NULL REFERENCES public.employees(id),
    country_id             bigint      REFERENCES public.countries(id),
    target_date            date        NOT NULL,
    notes                  text,
    state                  text        NOT NULL DEFAULT 'active',
    state_reason           text,
    state_changed_at       timestamptz,
    state_changed_by_ref   text,
    created_by_ref         text        NOT NULL,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_lc_nat_plan_state CHECK (state IN ('active', 'achieved', 'cancelled')),
    CONSTRAINT ck_lc_nat_plan_reason CHECK (state = 'active' OR btrim(COALESCE(state_reason, '')) <> '')
);
-- One ACTIVE plan per expatriate-held position; closed plans stay as history.
CREATE UNIQUE INDEX IF NOT EXISTS uq_lc_nat_plan_active
    ON public.lc_nationalisation_plans (incumbent_employee_id, role_id) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS idx_lc_nat_plan_country ON public.lc_nationalisation_plans (country_id);

CREATE TABLE IF NOT EXISTS public.lc_nationalisation_successors (
    id                   bigserial PRIMARY KEY,
    plan_id              bigint      NOT NULL REFERENCES public.lc_nationalisation_plans(id),
    employee_id          bigint      NOT NULL REFERENCES public.employees(id),
    idp_id               bigint      REFERENCES public.idp_plans(id) ON DELETE SET NULL,
    state                text        NOT NULL DEFAULT 'active',
    state_reason         text,
    state_changed_at     timestamptz,
    state_changed_by_ref text,
    added_by_ref         text        NOT NULL,
    added_at             timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_lc_nat_succ_state CHECK (state IN ('active', 'withdrawn')),
    CONSTRAINT ck_lc_nat_succ_reason CHECK (state = 'active' OR btrim(COALESCE(state_reason, '')) <> '')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_lc_nat_succ_active
    ON public.lc_nationalisation_successors (plan_id, employee_id) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS idx_lc_nat_succ_employee ON public.lc_nationalisation_successors (employee_id);

CREATE TABLE IF NOT EXISTS public.lc_nationalisation_events (
    id           bigserial PRIMARY KEY,
    plan_id      bigint      NOT NULL REFERENCES public.lc_nationalisation_plans(id),
    successor_id bigint      REFERENCES public.lc_nationalisation_successors(id),
    action       text        NOT NULL,
    reason       text,
    details      jsonb,
    actor_ref    text        NOT NULL,
    at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lc_nat_events_plan ON public.lc_nationalisation_events (plan_id, at);

CREATE OR REPLACE FUNCTION public.fn_lc_events_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'lc_nationalisation_events is append-only (% refused)', TG_OP;
END;
$$;
DROP TRIGGER IF EXISTS trg_lc_events_append_only ON public.lc_nationalisation_events;
CREATE TRIGGER trg_lc_events_append_only
    BEFORE UPDATE OR DELETE ON public.lc_nationalisation_events
    FOR EACH ROW EXECUTE FUNCTION public.fn_lc_events_append_only();

CREATE TABLE IF NOT EXISTS public.lc_regulatory_packs (
    id                     bigserial PRIMARY KEY,
    country_id             bigint      NOT NULL REFERENCES public.countries(id),
    period_type            text        NOT NULL,
    period_label           text        NOT NULL,
    period_start           date        NOT NULL,
    period_end             date        NOT NULL,           -- exclusive
    version                integer     NOT NULL DEFAULT 1,
    state                  text        NOT NULL DEFAULT 'draft',
    template_code          text        NOT NULL,
    company_name           text,
    snapshot               jsonb       NOT NULL,
    generated_at           timestamptz NOT NULL DEFAULT now(),
    generated_by_ref       text        NOT NULL,
    published_at           timestamptz,
    published_by_ref       text,
    superseded_at          timestamptz,
    superseded_by_pack_id  bigint      REFERENCES public.lc_regulatory_packs(id),
    state_reason           text,
    state_changed_by_ref   text,
    CONSTRAINT ck_lc_pack_period_type CHECK (period_type IN ('quarter', 'year')),
    CONSTRAINT ck_lc_pack_state CHECK (state IN ('draft', 'published', 'superseded', 'discarded')),
    CONSTRAINT ck_lc_pack_period CHECK (period_end > period_start),
    CONSTRAINT uq_lc_pack_version UNIQUE (country_id, period_label, version)
);
-- At most one published and one draft pack per country and period.
CREATE UNIQUE INDEX IF NOT EXISTS uq_lc_pack_published
    ON public.lc_regulatory_packs (country_id, period_label) WHERE state = 'published';
CREATE UNIQUE INDEX IF NOT EXISTS uq_lc_pack_draft
    ON public.lc_regulatory_packs (country_id, period_label) WHERE state = 'draft';

-- A published (or superseded) pack is a filed regulatory document: its content
-- can never change again. The only move left to a published pack is to become
-- 'superseded' by a newer version; a superseded or discarded pack is final.
-- No pack is ever deleted.
CREATE OR REPLACE FUNCTION public.fn_lc_pack_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'lc_regulatory_packs: a pack is never deleted';
    END IF;
    IF OLD.state IN ('superseded', 'discarded') THEN
        RAISE EXCEPTION 'lc_regulatory_packs: pack % is % and final', OLD.id, OLD.state;
    END IF;
    IF OLD.state = 'published' THEN
        IF NEW.state <> 'superseded'
           OR NEW.snapshot IS DISTINCT FROM OLD.snapshot
           OR NEW.company_name IS DISTINCT FROM OLD.company_name
           OR NEW.template_code IS DISTINCT FROM OLD.template_code
           OR NEW.country_id IS DISTINCT FROM OLD.country_id
           OR NEW.period_label IS DISTINCT FROM OLD.period_label
           OR NEW.period_start IS DISTINCT FROM OLD.period_start
           OR NEW.period_end IS DISTINCT FROM OLD.period_end
           OR NEW.version IS DISTINCT FROM OLD.version
           OR NEW.generated_at IS DISTINCT FROM OLD.generated_at
           OR NEW.published_at IS DISTINCT FROM OLD.published_at
           OR NEW.published_by_ref IS DISTINCT FROM OLD.published_by_ref THEN
            RAISE EXCEPTION 'lc_regulatory_packs: published pack % is immutable', OLD.id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_lc_pack_immutable ON public.lc_regulatory_packs;
CREATE TRIGGER trg_lc_pack_immutable
    BEFORE UPDATE OR DELETE ON public.lc_regulatory_packs
    FOR EACH ROW EXECUTE FUNCTION public.fn_lc_pack_immutable();
