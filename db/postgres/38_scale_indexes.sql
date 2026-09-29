-- 38_scale_indexes.sql — additive indexes for the ~4000-user scale profile.
-- Safe & idempotent. Complements 35_perf_high_concurrency (which indexed the
-- resolved-assessments window) with the join/filters that get hot at scale.

-- Succession candidate scan (BenchmarkModel.getRoleCandidates) CROSS JOINs the
-- required skills against skill_assessments per candidate, probing by skill then
-- employee. The existing indexes are (employee_id,...) and (skill_id) singletons;
-- a (skill_id, employee_id) composite lets that probe be index-only.
CREATE INDEX IF NOT EXISTS idx_skill_assessments_skill_emp
    ON public.skill_assessments (skill_id, employee_id);

-- Self-assessment review queues filter heavily on workflow_state (+ recency).
CREATE INDEX IF NOT EXISTS idx_self_assessments_wf_state
    ON public.self_assessments (workflow_state, updated_at DESC);

-- Failed-login clustering (observability issues panel + lockout logic) scans
-- login_attempts by outcome over a recent window.
CREATE INDEX IF NOT EXISTS idx_login_attempts_recent
    ON public.login_attempts (attempted_at DESC)
    WHERE successful = false;

-- Employee scope resolution (RBAC) filters active employees by org unit.
CREATE INDEX IF NOT EXISTS idx_employees_scope
    ON public.employees (site_id, department_id, service_id)
    WHERE is_active = true;

INSERT INTO public.schema_meta(key, value) VALUES ('38_scale_indexes', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();
