-- 22_perf_indexes.sql
-- Performance: index the foreign keys that are JOIN / filter / cascade-check
-- targets but were previously unindexed. PostgreSQL does NOT auto-index FK
-- columns, so a parent-row delete (or a child lookup) does a sequential scan of
-- the child table without these. Audit-only FKs (*_by -> admins, which are never
-- filtered on) are intentionally left unindexed to avoid needless write overhead.
-- All idempotent (IF NOT EXISTS); safe to re-run.

-- Assessment history: shown per self-assessment and filtered by cycle.
CREATE INDEX IF NOT EXISTS idx_assessment_history_self_assessment ON public.assessment_history (self_assessment_id);
CREATE INDEX IF NOT EXISTS idx_assessment_history_cycle           ON public.assessment_history (cycle_id);

-- Self-assessments / supervisor reviews joined & filtered by skill.
CREATE INDEX IF NOT EXISTS idx_self_assessments_skill   ON public.self_assessments (skill_id);
CREATE INDEX IF NOT EXISTS idx_supervisor_reviews_skill ON public.supervisor_reviews (skill_id);

-- Coaching: sessions fetched per plan; plans listed where I am the mentor.
CREATE INDEX IF NOT EXISTS idx_coaching_sessions_plan ON public.coaching_sessions (plan_id);
CREATE INDEX IF NOT EXISTS idx_coaching_plans_mentor  ON public.coaching_plans (mentor_id);

-- IDP: objectives by skill; actions by objective.
CREATE INDEX IF NOT EXISTS idx_idp_objectives_skill   ON public.idp_objectives (skill_id);
CREATE INDEX IF NOT EXISTS idx_idp_actions_objective  ON public.idp_actions (objective_id);

-- PIP milestones fetched per PIP.
CREATE INDEX IF NOT EXISTS idx_pip_milestones_pip ON public.pip_milestones (pip_id);

-- Disputes by employee and by the originating review.
CREATE INDEX IF NOT EXISTS idx_assessment_disputes_employee ON public.assessment_disputes (employee_id);
CREATE INDEX IF NOT EXISTS idx_assessment_disputes_review   ON public.assessment_disputes (supervisor_review_id);

-- Lifecycle events / DSR requests / check-ins / placements filtered by their FK.
CREATE INDEX IF NOT EXISTS idx_lifecycle_events_employee ON public.lifecycle_events (employee_id);
CREATE INDEX IF NOT EXISTS idx_dsr_requests_employee     ON public.dsr_requests (employee_id);
CREATE INDEX IF NOT EXISTS idx_check_ins_manager         ON public.check_ins (manager_id);
CREATE INDEX IF NOT EXISTS idx_talent_placements_cycle   ON public.talent_placements (cycle_id);

-- Maker-checker queue resolved by the assigned checker.
CREATE INDEX IF NOT EXISTS idx_maker_checker_requests_checker ON public.maker_checker_requests (checker_id);

-- Review delegations looked up by grantor.
CREATE INDEX IF NOT EXISTS idx_review_delegations_grantor ON public.review_delegations (grantor_id);
