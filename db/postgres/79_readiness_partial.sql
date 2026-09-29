-- 79_readiness_partial.sql
-- Stop a PARTIAL assessment from fabricating a deficit.
--
-- NOTE ON THE FILE NUMBER: this change was specified as "migration 74", but
-- 74_lms_learner_loop.sql … 78_certification_validity_qualification.sql already
-- exist. Migrations are applied in numeric order and keyed by file name in
-- schema_meta, so re-using 74 would either collide with an applied key or run
-- BEFORE the migration (78) whose v_employee_skill_gaps definition this file
-- builds on. It is therefore 79 — the next free number.
--
-- PROBLEM
--   v_employee_readiness.total_gap_points was
--       SUM(CASE WHEN g.gap > 0 THEN g.gap ELSE 0 END)
--   over EVERY role requirement. v_employee_skill_gaps COALESCEs a missing
--   assessment to actual_level 0, so an unrated requirement contributes its
--   FULL required_level as "gap points". Somebody assessed on 10 of 47 skills
--   therefore carried the other 37 requirements as complete deficits — a
--   fabricated shortfall nobody ever measured. The column was only ever NULL /
--   empty when the employee had no requirements at all, so partial completion
--   (the normal state of a rollout) was indistinguishable from real weakness,
--   and the "worst gaps" lists ranked the UNMEASURED at the top.
--
-- WHAT CHANGES
--   total_gap_points now sums the gap of the ASSESSED requirements only
--   (g.is_assessed = 1, i.e. a resolved supervisor or approved self rating
--   exists — definitionally the same predicate as
--   v_requirement_provenance.assessment_status <> 'never_assessed'; both derive
--   from `v_resolved_assessments.level IS NOT NULL` over the identical
--   requirement set, and the DO block below refuses to let them drift).
--
-- WHAT DELIBERATELY DOES NOT CHANGE  (HARD CONSTRAINT)
--   * total_required — the department-designed requirement count — stays the
--     FULL count. No requirement is hidden, sampled or filtered away.
--   * points_required / points_gained / readiness / is_role_ready are untouched,
--     so every existing consumer keeps the exact number it had. The
--     coverage-aware parallel (readiness_assessed_only, migration 71) remains
--     the figure the reports display, next to assessed/expected.
--   * skills_met / total_critical / critical_met are counts of what IS met, not
--     invented deficits; unchanged.
--
-- APPENDED COLUMNS (CREATE OR REPLACE only allows appending — and a
-- DROP … CASCADE here would silently delete v_department_matrix_completion and
-- anything else that depends on this view):
--   assessed_required        requirements with a real rating behind them
--   never_assessed_required  requirements nobody has ever rated
--   unassessed_gap_points    the points EXCLUDED from total_gap_points — the
--                            exact size of the old fabrication, kept visible so
--                            the change is auditable rather than invisible.
--
-- Idempotent: CREATE OR REPLACE VIEW + an ON CONFLICT schema_meta stamp.

BEGIN;

CREATE OR REPLACE VIEW v_employee_readiness AS
SELECT
    e.employee_id,
    e.full_name,
    e.site_id, e.site_name,
    e.department_id, e.department_name,
    e.service_id, e.service_name,
    e.role_id, e.role_name,
    -- The department-designed requirement count, WHOLE (never a subset).
    COUNT(g.skill_id) AS total_required,
    SUM(g.is_met)::int AS skills_met,
    -- Gap arithmetic over ASSESSED requirements only: an unrated requirement is
    -- an unknown, not a deficit.
    SUM(CASE WHEN g.is_assessed = 1 AND g.gap > 0 THEN g.gap ELSE 0 END)::int AS total_gap_points,
    SUM(CASE WHEN g.is_critical THEN 1 ELSE 0 END)::int AS total_critical,
    SUM(CASE WHEN g.is_critical AND g.is_met = 1 THEN 1 ELSE 0 END)::int AS critical_met,
    SUM(LEAST(g.actual_level, g.required_level))::int AS points_gained,
    SUM(g.required_level)::int AS points_required,
    CASE WHEN SUM(g.required_level) > 0
        THEN ROUND(100.0 * SUM(LEAST(g.actual_level, g.required_level))::numeric / SUM(g.required_level)::numeric, 1)
        ELSE NULL END AS readiness,
    CASE WHEN (
            SUM(g.required_level) > 0
            AND (100.0 * SUM(LEAST(g.actual_level, g.required_level))::numeric / SUM(g.required_level)::numeric) >= 80
            AND SUM(CASE WHEN g.is_critical THEN 1 ELSE 0 END)
              = SUM(CASE WHEN g.is_critical AND g.is_met = 1 THEN 1 ELSE 0 END)
        )
        THEN 1 ELSE 0 END AS is_role_ready,
    -- ---- appended (migration 79): the denominator of the gap arithmetic ----
    SUM(g.is_assessed)::int AS assessed_required,
    SUM(CASE WHEN g.is_assessed = 0 THEN 1 ELSE 0 END)::int AS never_assessed_required,
    SUM(CASE WHEN g.is_assessed = 0 AND g.gap > 0 THEN g.gap ELSE 0 END)::int AS unassessed_gap_points
FROM v_employee_details e
JOIN v_employee_skill_gaps g ON g.employee_id = e.employee_id
GROUP BY e.employee_id, e.full_name, e.site_id, e.site_name, e.department_id, e.department_name,
         e.service_id, e.service_name, e.role_id, e.role_name;

COMMENT ON VIEW v_employee_readiness IS
    'Per-employee readiness. total_required is the FULL department-designed requirement count. '
    'total_gap_points counts ONLY assessed requirements (migration 79) — an unrated requirement is '
    'unknown, not a deficit; unassessed_gap_points shows what was excluded. readiness here still '
    'spans every requirement: use v_employee_assessment_coverage.readiness_assessed_only together '
    'with assessed/expected when partial coverage must not be read as weakness.';

-- ---------------------------------------------------------------------------
-- Fail LOUDLY if the replace did not take, or if the is_assessed predicate ever
-- stops agreeing with v_requirement_provenance (P0001 is not one of the
-- migration runner's "object already exists" codes, so it cannot be swallowed
-- and silently stamped 'pre-existing').
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    drift bigint;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'v_employee_readiness'
          AND column_name = 'unassessed_gap_points'
    ) THEN
        RAISE EXCEPTION
            'migration 79: v_employee_readiness has no unassessed_gap_points column — the view replace did not take';
    END IF;

    SELECT COUNT(*) INTO drift
      FROM v_employee_skill_gaps g
      FULL JOIN v_requirement_provenance p
        ON p.employee_id = g.employee_id AND p.skill_id = g.skill_id
     WHERE g.employee_id IS NULL
        OR p.employee_id IS NULL
        OR g.is_assessed <> p.is_assessed;

    IF drift > 0 THEN
        RAISE EXCEPTION
            'migration 79: % requirement rows where v_employee_skill_gaps.is_assessed disagrees with v_requirement_provenance — the gap predicate is no longer the provenance predicate', drift;
    END IF;
END $$;

INSERT INTO schema_meta(key, value) VALUES ('79_readiness_partial', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();

COMMIT;
