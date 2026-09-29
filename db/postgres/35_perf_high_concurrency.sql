-- ============================================================================
-- High-concurrency performance indexes. Additive & idempotent.
--
-- v_resolved_assessments runs ROW_NUMBER OVER (PARTITION BY employee_id, skill_id
-- ORDER BY assessed_at DESC) over skill_assessments on EVERY dashboard query.
-- skill_assessments had UNIQUE(employee_id, skill_id) + singleton FK indexes but
-- nothing carrying assessed_at, so the window did a full Sort that spills as the
-- assessment volume grows. This index lets the planner satisfy the window order
-- with an index scan instead of a sort (assessment_history already has the twin).
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_skill_assessments_emp_skill_time
    ON public.skill_assessments (employee_id, skill_id, assessed_at DESC);

-- Approved self-assessments feed the same resolved-assessments UNION (filtered on
-- status='approved', ordered by created_at — see v_resolved_assessments). Support
-- that branch with a partial index on the approved rows only.
CREATE INDEX IF NOT EXISTS idx_self_assessments_emp_skill_created
    ON public.self_assessments (employee_id, skill_id, created_at DESC)
    WHERE status = 'approved';

INSERT INTO public.schema_meta(key, value) VALUES ('35_perf_high_concurrency', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();
