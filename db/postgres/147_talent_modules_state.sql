-- 147 — Talent modules: opportunity close/fill trail + survey audience
--
-- 1) An opportunity could never leave 'open': no code path wrote its state, so
--    a filled role stayed on the marketplace forever. Closing or filling it is
--    now an explicit act with a reason and an actor — recorded here, never a
--    deletion (house rule: states + reason, nothing erased).
--
-- 2) Opening a survey notified EVERY active employee org-wide, whoever opened
--    it. The audience is now the opener's scope (SuperAdmin: the organisation),
--    frozen at open time in survey_audience so that "who was invited" can be
--    answered and a person outside the audience cannot respond. The table holds
--    INVITATIONS, never answers: anonymous surveys stay anonymous.
--    Surveys opened before this migration keep audience_scoped = false and
--    therefore keep their historical org-wide audience.
--
-- Additive and idempotent.

ALTER TABLE public.opportunities ADD COLUMN IF NOT EXISTS state_reason                 text;
ALTER TABLE public.opportunities ADD COLUMN IF NOT EXISTS state_changed_at             timestamptz;
ALTER TABLE public.opportunities ADD COLUMN IF NOT EXISTS state_changed_by_admin_id    bigint REFERENCES public.admins(id) ON DELETE SET NULL;
ALTER TABLE public.opportunities ADD COLUMN IF NOT EXISTS state_changed_by_employee_id bigint REFERENCES public.employees(id) ON DELETE SET NULL;

ALTER TABLE public.surveys ADD COLUMN IF NOT EXISTS audience_scoped boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.survey_audience (
    survey_id   bigint      NOT NULL REFERENCES public.surveys(id) ON DELETE CASCADE,
    employee_id bigint      NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
    invited_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (survey_id, employee_id)
);
CREATE INDEX IF NOT EXISTS idx_survey_audience_employee ON public.survey_audience (employee_id);
