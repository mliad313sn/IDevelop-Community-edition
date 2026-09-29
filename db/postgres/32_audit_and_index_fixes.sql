-- ============================================================================
-- Audit follow-up fixes (from the deep-inspection pass). Additive & idempotent.
--   30-A: serialize the audit hash-chain so concurrent inserts can't FORK it.
--   29-C/D: indexes on hot FK columns the new joins/filters use.
--   29-E: enforce one proficiency anchor per (skill,level) / (category,level).
-- ============================================================================

-- 30-A — Hash-chain must be a single linear chain. Under READ COMMITTED two
-- concurrent inserts could both read the same "latest" row_hash and fork the
-- chain. Take a transaction-level advisory lock at the top of the trigger so
-- chain appends serialize (the lock auto-releases at commit). CREATE OR REPLACE
-- updates the function the existing trigger already points to.
CREATE OR REPLACE FUNCTION public.fn_system_logs_hashchain()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p text;
BEGIN
    PERFORM pg_advisory_xact_lock(778201143);  -- serialize system_logs chain appends
    SELECT row_hash INTO p FROM public.system_logs ORDER BY id DESC LIMIT 1;
    NEW.prev_hash := p;
    NEW.row_hash := encode(digest(
        coalesce(p, '') || '|' ||
        coalesce(NEW.admin_id::text, '') || '|' ||
        coalesce(NEW.action, '') || '|' ||
        coalesce(NEW.entity_type, '') || '|' ||
        coalesce(NEW.entity_id::text, '') || '|' ||
        coalesce(NEW.details::text, '') || '|' ||
        coalesce(NEW.created_at::text, now()::text), 'sha256'), 'hex');
    RETURN NEW;
END $$;

-- 29-C / 29-D — missing FK indexes used by SurveyService.results and
-- TalentDepthService.getCalibration joins.
CREATE INDEX IF NOT EXISTS idx_survey_resp_question  ON public.survey_responses (question_id);
CREATE INDEX IF NOT EXISTS idx_calib_adj_employee    ON public.calibration_adjustments (employee_id);

-- 29-E — one proficiency anchor per level (per skill, or per category).
CREATE UNIQUE INDEX IF NOT EXISTS uq_prof_desc_skill_level
    ON public.proficiency_descriptors (skill_id, level) WHERE skill_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_prof_desc_cat_level
    ON public.proficiency_descriptors (category, level) WHERE skill_id IS NULL;
