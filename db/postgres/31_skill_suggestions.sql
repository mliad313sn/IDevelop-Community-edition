-- ============================================================================
-- Skills inference (on-prem, no LLM). Suggested skills for an employee, derived
-- from existing signals (completed courses → mapped skills, IDP development
-- objectives, and skills-graph adjacency to already-held skills). Human-in-the-
-- loop: a manager accepts (→ writes a skill assessment) or dismisses.
-- Additive & idempotent.
-- ============================================================================
DO $$ BEGIN
    CREATE TYPE public.skill_suggestion_status AS ENUM ('pending','accepted','dismissed');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS public.skill_suggestions (
    id           bigserial PRIMARY KEY,
    employee_id  bigint NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
    skill_id     bigint NOT NULL REFERENCES public.skills(id) ON DELETE CASCADE,
    confidence   numeric(4,2) NOT NULL DEFAULT 0.5,   -- 0..1
    source       text,                                -- 'completed_course','idp_objective','adjacent' (csv)
    evidence     text,
    status       public.skill_suggestion_status NOT NULL DEFAULT 'pending',
    created_at   timestamptz NOT NULL DEFAULT now(),
    decided_at   timestamptz,
    decided_by   bigint REFERENCES public.admins(id) ON DELETE SET NULL
);

-- At most one PENDING suggestion per (employee, skill); resolved rows may repeat.
CREATE UNIQUE INDEX IF NOT EXISTS uq_skill_suggestion_pending
    ON public.skill_suggestions (employee_id, skill_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_skill_suggestions_emp ON public.skill_suggestions (employee_id, status);
