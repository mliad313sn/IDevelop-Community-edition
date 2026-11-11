-- 191 — the development loop: a plan action moves (4.0.0 port, wave 4)
--
-- A development-plan action used to be a static line: nobody could start it,
-- say it was done or validate it from a screen, so a plan never moved a level.
-- These columns carry the "do" and "evidence" steps of the loop:
--
--   idp_actions.reported_done_at / reported_note / reported_by_type / reported_by_id
--       the PERSON the plan is for says the action is done, with a short note.
--       No official effect: the action stays in_progress until the line
--       validates it. reported_by_type 'system' = a finished course said so.
--   idp_actions.validated_by_type / validated_by_id / validation_note
--       who validated the action (the line, IDPService.validateAction) and the
--       note they left.
--   idp_actions.actual_hours
--       hours really spent, entered when reported or validated. estimated_hours
--       stays the planned figure. Never inferred: NULL means "not entered".
--   idp_actions.due_on / place
--       an offline training (no LMS) keeps a date and a place.
--   action_effectiveness.evidence_source / official
--       what produced the observed level (observation | training | coaching)
--       and whether it became the official level.
--   idp_objectives.target_role_id / idp_plans.target_role_id
--       an objective written for a target role (career path), so a skill that
--       only the target role requires is never silently dropped from the plan.
--
-- reported_note and validation_note are free text about a person: they are
-- in the erasure registry (src/services/erasureRegistry.js) in the same change.
--
-- The hours CHECK runs against existing data. When an install already holds a
-- negative estimated_hours, the constraint is added NOT VALID (it binds every
-- new or changed row) and left for an administrator to validate after fixing
-- the rows: the upgrade never fails on old data.
--
-- Additive and idempotent: safe to re-run. Nothing is rewritten or deleted.

ALTER TABLE public.idp_actions ADD COLUMN IF NOT EXISTS reported_done_at  timestamptz;
ALTER TABLE public.idp_actions ADD COLUMN IF NOT EXISTS reported_note     text;
ALTER TABLE public.idp_actions ADD COLUMN IF NOT EXISTS reported_by_type  text;
ALTER TABLE public.idp_actions ADD COLUMN IF NOT EXISTS reported_by_id    bigint;
ALTER TABLE public.idp_actions ADD COLUMN IF NOT EXISTS validated_by_type text;
ALTER TABLE public.idp_actions ADD COLUMN IF NOT EXISTS validated_by_id   bigint;
ALTER TABLE public.idp_actions ADD COLUMN IF NOT EXISTS validation_note   text;
ALTER TABLE public.idp_actions ADD COLUMN IF NOT EXISTS actual_hours      numeric(6,1);
ALTER TABLE public.idp_actions ADD COLUMN IF NOT EXISTS due_on            date;
ALTER TABLE public.idp_actions ADD COLUMN IF NOT EXISTS place             text;

ALTER TABLE public.action_effectiveness ADD COLUMN IF NOT EXISTS evidence_source text;
ALTER TABLE public.action_effectiveness ADD COLUMN IF NOT EXISTS official boolean NOT NULL DEFAULT false;

ALTER TABLE public.idp_objectives ADD COLUMN IF NOT EXISTS target_role_id bigint
    REFERENCES public.roles(id) ON DELETE SET NULL;
ALTER TABLE public.idp_plans ADD COLUMN IF NOT EXISTS target_role_id bigint
    REFERENCES public.roles(id) ON DELETE SET NULL;

DO $$
DECLARE
    v_negative integer;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_idp_actions_hours_nonneg') THEN
        SELECT COUNT(*) INTO v_negative FROM public.idp_actions WHERE estimated_hours < 0;
        IF v_negative = 0 THEN
            ALTER TABLE public.idp_actions ADD CONSTRAINT chk_idp_actions_hours_nonneg
                CHECK ((actual_hours IS NULL OR actual_hours >= 0)
                   AND (estimated_hours IS NULL OR estimated_hours >= 0));
        ELSE
            ALTER TABLE public.idp_actions ADD CONSTRAINT chk_idp_actions_hours_nonneg
                CHECK ((actual_hours IS NULL OR actual_hours >= 0)
                   AND (estimated_hours IS NULL OR estimated_hours >= 0)) NOT VALID;
            RAISE NOTICE '191: % development action(s) carry negative planned hours; chk_idp_actions_hours_nonneg was added NOT VALID', v_negative;
        END IF;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_idp_actions_reported_by_type') THEN
        ALTER TABLE public.idp_actions ADD CONSTRAINT chk_idp_actions_reported_by_type
            CHECK (reported_by_type IS NULL OR reported_by_type IN ('employee', 'manager', 'admin', 'system'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_idp_actions_validated_by_type') THEN
        ALTER TABLE public.idp_actions ADD CONSTRAINT chk_idp_actions_validated_by_type
            CHECK (validated_by_type IS NULL OR validated_by_type IN ('employee', 'manager', 'admin'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_action_effectiveness_source') THEN
        ALTER TABLE public.action_effectiveness ADD CONSTRAINT chk_action_effectiveness_source
            CHECK (evidence_source IS NULL OR evidence_source IN ('observation', 'training', 'coaching'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_idp_actions_reported ON public.idp_actions (reported_done_at)
    WHERE reported_done_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_lms_enrollments_source_action ON public.lms_enrollments (source_action_id)
    WHERE source_action_id IS NOT NULL;

COMMENT ON COLUMN public.idp_actions.reported_note IS
    'The person''s own note when they report the action done (migration 191). Free text: erased with the person.';
COMMENT ON COLUMN public.idp_actions.validation_note IS
    'The validator''s note (migration 191). Free text about the person: erased with them.';
COMMENT ON COLUMN public.idp_actions.actual_hours IS
    'Hours really spent (migration 191). NULL = not entered, never 0.';
COMMENT ON COLUMN public.action_effectiveness.official IS
    'True when the observed level became the official level (migration 191).';

-- The SQL console reader stays in step with the schema (migration 168).
SELECT public.fn_console_reader_sync();
