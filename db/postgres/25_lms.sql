-- ============================================================================
-- Phase 3 — LMS Integration Hub (foundation).
--   Pluggable connector config + cached external catalog + course<->skill map
--   + enrollments + append-only completions. Completions feed the audited
--   skills core as a distinct `lms_completion` source (never overriding a more
--   recent supervisor review). Additive & idempotent.
-- ============================================================================

DO $$ BEGIN
    CREATE TYPE public.lms_enroll_status AS ENUM ('assigned','in_progress','completed','failed','cancelled');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ---- Integration config (one row per provider) -----------------------------
CREATE TABLE IF NOT EXISTS public.lms_integrations (
    id            bigserial PRIMARY KEY,
    provider      text NOT NULL,                 -- 'cornerstone' | 'mypath' | 'xapi' | 'lti' | ...
    name          text,
    base_url      text,
    auth_config   jsonb NOT NULL DEFAULT '{}'::jsonb,  -- encrypted at the app layer; masked on read
    sync_schedule text,                          -- cron string for catalog/completion polling
    webhook_secret text,                         -- HMAC secret for inbound webhook validation
    enabled       boolean NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_lms_integration_provider UNIQUE (provider)
);

-- ---- Cached external catalog -----------------------------------------------
CREATE TABLE IF NOT EXISTS public.lms_courses (
    id               bigserial PRIMARY KEY,
    provider         text NOT NULL,
    external_id      text NOT NULL,
    title            text NOT NULL,
    url              text,
    type             text,                        -- 'course' | 'path' | 'workshop' | ...
    duration_minutes integer,
    competency_tags  jsonb NOT NULL DEFAULT '[]'::jsonb,
    synced_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_lms_course UNIQUE (provider, external_id)
);
CREATE INDEX IF NOT EXISTS idx_lms_courses_provider ON public.lms_courses (provider);

-- ---- Course <-> skill mapping (the semantic glue) --------------------------
CREATE TABLE IF NOT EXISTS public.course_skill_map (
    id          bigserial PRIMARY KEY,
    course_id   bigint NOT NULL REFERENCES public.lms_courses(id) ON DELETE CASCADE,
    skill_id    bigint NOT NULL REFERENCES public.skills(id) ON DELETE CASCADE,
    level_delta smallint NOT NULL DEFAULT 1,      -- target level the course confers (0..4)
    created_by  bigint REFERENCES public.admins(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_course_skill UNIQUE (course_id, skill_id),
    CONSTRAINT chk_level_delta CHECK (level_delta BETWEEN 0 AND 4)
);
CREATE INDEX IF NOT EXISTS idx_course_skill_skill ON public.course_skill_map (skill_id);

-- ---- Enrollments (outbound assignments) ------------------------------------
CREATE TABLE IF NOT EXISTS public.lms_enrollments (
    id              bigserial PRIMARY KEY,
    employee_id     bigint NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
    course_id       bigint NOT NULL REFERENCES public.lms_courses(id) ON DELETE CASCADE,
    status          public.lms_enroll_status NOT NULL DEFAULT 'assigned',
    assigned_by     bigint REFERENCES public.admins(id) ON DELETE SET NULL,
    source_action_id bigint,                      -- links to idp_actions (soft ref; no FK to keep modules decoupled)
    external_ref    text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_enrollment UNIQUE (employee_id, course_id)
);
CREATE INDEX IF NOT EXISTS idx_lms_enroll_emp ON public.lms_enrollments (employee_id);

-- ---- Completions (append-only, idempotent on provider+external_ref) --------
CREATE TABLE IF NOT EXISTS public.lms_completions (
    id            bigserial PRIMARY KEY,
    provider      text NOT NULL,
    external_ref  text NOT NULL,                  -- provider completion id = idempotency key
    employee_id   bigint REFERENCES public.employees(id) ON DELETE SET NULL,
    course_id     bigint REFERENCES public.lms_courses(id) ON DELETE SET NULL,
    completed_at  timestamptz,
    score         numeric(6,2),
    cert_id       text,
    applied       boolean NOT NULL DEFAULT false, -- did it raise a skill?
    review_reason text,                           -- e.g. 'supervisor_locked' | 'no_mapping' | 'already_met'
    raw           jsonb,
    ingested_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_lms_completion UNIQUE (provider, external_ref)
);
CREATE INDEX IF NOT EXISTS idx_lms_completion_emp ON public.lms_completions (employee_id);

-- ---- Extend the skills-history source classifier with 'lms_completion' ------
-- An LMS completion is recorded as its own provenance so it is fully auditable
-- and distinguishable from manual / supervisor / import changes.
CREATE OR REPLACE FUNCTION public.fn_classify_assessment_source(p_notes TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_notes ILIKE '%lms completion%'           THEN 'lms_completion'
    WHEN p_notes ILIKE '%approved self-assessment%' THEN 'self_assessment'
    WHEN p_notes ILIKE '%supervisor review%'        THEN 'supervisor_review'
    WHEN p_notes ILIKE '%action close uplift%' OR p_notes ILIKE 'auto:%' THEN 'action_uplift'
    WHEN p_notes ILIKE '%import%'                   THEN 'import'
    ELSE 'manual'
  END;
$$;

-- Map the new source to a 'system' actor in the auto-capture trigger.
CREATE OR REPLACE FUNCTION public.fn_log_skill_assessment_change()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_src   TEXT;
  v_actor TEXT;
  v_cycle BIGINT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.current_level IS NOT DISTINCT FROM OLD.current_level THEN
    RETURN NEW;
  END IF;

  v_src := fn_classify_assessment_source(NEW.notes);
  v_actor := CASE v_src
      WHEN 'self_assessment'   THEN 'employee'
      WHEN 'supervisor_review' THEN 'supervisor'
      WHEN 'action_uplift'     THEN 'system'
      WHEN 'lms_completion'    THEN 'system'
      WHEN 'import'            THEN 'system'
      ELSE 'admin' END;
  SELECT id INTO v_cycle
    FROM assessment_cycles
   WHERE status = 'open'
   ORDER BY opened_at DESC NULLS LAST
   LIMIT 1;

  INSERT INTO assessment_history
      (employee_id, skill_id, previous_level, new_level, assessed_by, assessed_at, notes, source, actor_type, cycle_id)
  VALUES
      (NEW.employee_id, NEW.skill_id,
       CASE WHEN TG_OP = 'UPDATE' THEN OLD.current_level ELSE NULL END,
       NEW.current_level, NEW.assessed_by, COALESCE(NEW.assessed_at, now()),
       NEW.notes, v_src, v_actor, v_cycle);
  RETURN NEW;
END;
$$;
