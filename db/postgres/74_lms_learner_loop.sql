-- ============================================================================
-- 74_lms_learner_loop.sql — close the LMS loop at both ends.
--
-- (1) CRITICAL — the supervisor-decision classifier had a blind spot.
--     `assessment_history.source` is DERIVED from the notes text by
--     fn_classify_assessment_source. The PRIMARY approval path
--     (SelfAssessmentWorkflowService._promoteToSkillAssessment) writes the
--     notes 'Set from supervisor-validated rating' — which matched NONE of the
--     patterns and therefore landed as source = 'manual'.
--
--     LmsService._applyToSkills refuses to overwrite a rating whose last
--     history row is source = 'supervisor_review'. Because the primary path
--     never produced that value, an e-learning completion could silently
--     restore a level a supervisor had deliberately downgraded (after an
--     incident, a failed VOC…), erasing their decision with no trace beyond a
--     'lms_completion' row.
--
--     The classifier now recognises the supervisor-validated wording. Existing
--     history rows are NOT rewritten: assessment_history is append-only by
--     design (trg_assessment_history_immutable), and an audit trail is not
--     something a migration should edit. LmsService carries a matching
--     notes-level fallback so pre-migration rows are protected too.
--
-- (2) Enrollments gained the columns the learner loop actually needs: a due
--     date, real transition timestamps, and the outcome of the outbound push
--     to the provider (which used to be caught and thrown away).
--
-- Additive and idempotent.
-- ============================================================================
BEGIN;

-- ---- (1) Supervisor-decision classification -------------------------------
CREATE OR REPLACE FUNCTION public.fn_classify_assessment_source(p_notes TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_notes ILIKE '%lms completion%'           THEN 'lms_completion'
    -- Every wording the supervisor/manager decision paths write. Checked
    -- BEFORE the self-assessment pattern: an approval that carries the
    -- reviewer's own rating is a supervisor decision, not a self-rating.
    WHEN p_notes ILIKE '%supervisor review%'
      OR p_notes ILIKE '%supervisor-validated%'
      OR p_notes ILIKE '%supervisor validated%'     THEN 'supervisor_review'
    WHEN p_notes ILIKE '%approved self-assessment%' THEN 'self_assessment'
    WHEN p_notes ILIKE '%action close uplift%' OR p_notes ILIKE 'auto:%' THEN 'action_uplift'
    WHEN p_notes ILIKE '%import%'                   THEN 'import'
    ELSE 'manual'
  END;
$$;

-- ---- (2) Enrollment lifecycle + push outcome ------------------------------
ALTER TABLE public.lms_enrollments ADD COLUMN IF NOT EXISTS due_at            timestamptz;
ALTER TABLE public.lms_enrollments ADD COLUMN IF NOT EXISTS started_at        timestamptz;
ALTER TABLE public.lms_enrollments ADD COLUMN IF NOT EXISTS completed_at      timestamptz;
-- Outbound push to the provider: 'pending' (not attempted yet) | 'pushed'
-- (accepted) | 'unsupported' (connector has no assignment API) | 'failed'
-- (attempted and rejected — push_error carries the reason instead of it being
-- swallowed by a bare catch).
ALTER TABLE public.lms_enrollments ADD COLUMN IF NOT EXISTS push_state        text NOT NULL DEFAULT 'pending';
ALTER TABLE public.lms_enrollments ADD COLUMN IF NOT EXISTS push_error        text;
ALTER TABLE public.lms_enrollments ADD COLUMN IF NOT EXISTS push_attempted_at timestamptz;

DO $$ BEGIN
    ALTER TABLE public.lms_enrollments
        ADD CONSTRAINT chk_lms_push_state
        CHECK (push_state IN ('pending', 'pushed', 'unsupported', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The learner page reads "my enrolments, soonest due first"; the reminder job
-- reads "assigned and stale". Both are (employee_id, status) scans.
CREATE INDEX IF NOT EXISTS idx_lms_enroll_emp_status ON public.lms_enrollments (employee_id, status);

COMMENT ON COLUMN public.lms_enrollments.due_at IS
    'When the assignment is due. Shown to the learner on /employee/my-learning.';
COMMENT ON COLUMN public.lms_enrollments.push_state IS
    'Outcome of the outbound assignment push: pending|pushed|unsupported|failed.';

COMMIT;
