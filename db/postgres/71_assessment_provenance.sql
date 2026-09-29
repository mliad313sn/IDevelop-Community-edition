-- 71_assessment_provenance.sql
-- Make partial completion impossible to misread.
--
-- PROBLEM
--   v_resolved_assessments stamped a CONSTANT 'assessment' AS source on BOTH
--   union branches, so no consumer could tell a supervisor-validated level from
--   an auto-approved self-rating. Worse, every downstream gap/readiness view
--   COALESCEs a missing assessment to level 0 — so "never assessed" is rendered
--   as an honest, earned zero. A director reading "40 % readiness" cannot tell
--   whether that is 40 % of everyone or 40 % of the 12 % who were ever assessed.
--
-- WHAT THIS MIGRATION DOES
--   1. v_resolved_assessments keeps EVERY existing column and name and gains a
--      real per-branch `source` ('supervisor_validated' | 'self_approved') plus
--      a derived `assessment_status` ('assessed' | 'self_only'). ADD, never
--      remove: no downstream consumer breaks.
--   2. v_requirement_provenance — one row per (employee, REQUIRED skill), with
--      assessment_status IN ('never_assessed','assessed','self_only') and an
--      `assessed_level` that stays NULL when nothing was ever assessed (it is
--      deliberately NOT coalesced to 0).
--   3. v_employee_assessment_coverage — per-employee assessed/expected counts
--      plus `readiness_assessed_only`, a PARALLEL readiness computed over the
--      assessed requirements only. Nothing here replaces or recomputes the
--      existing v_employee_readiness numbers; they are untouched.
--
-- HARD CONSTRAINT RESPECTED: nothing here reduces the number of skills anyone
-- is asked to assess. `expected_skills` is the FULL requirement count.
--
-- WHY CREATE OR REPLACE (and not DROP ... CASCADE) FOR v_resolved_assessments:
--   seven views across 07/33/56/58 depend on it. DROP ... CASCADE would silently
--   delete all of them and force this file to re-declare definitions it does not
--   own. The column list and types are unchanged and the new column is appended
--   last, which is exactly the case CREATE OR REPLACE VIEW supports — and it is
--   idempotent. The DO block at the bottom fails LOUDLY (P0001, not one of the
--   runner's "object already exists" codes) if the replace did not take, so the
--   migration can never be silently marked pre-existing.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Real provenance on the resolved-assessment view
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_resolved_assessments AS
SELECT employee_id, skill_id, level, source, assessed_at, assessment_status
FROM (
    SELECT employee_id, skill_id, current_level AS level, source, assessed_at,
           (CASE WHEN source = 'supervisor_validated' THEN 'assessed' ELSE 'self_only' END)::text
               AS assessment_status,
           -- Tie-break left exactly as it was (assessed_at DESC only) so no
           -- already-resolved level can shift under an existing consumer.
           ROW_NUMBER() OVER (PARTITION BY employee_id, skill_id ORDER BY assessed_at DESC) AS rn
    FROM (
        SELECT employee_id, skill_id, current_level, assessed_at,
               'supervisor_validated'::text AS source
        FROM skill_assessments
        UNION ALL
        SELECT employee_id, skill_id, self_rated_level AS current_level, created_at AS assessed_at,
               'self_approved'::text AS source
        FROM self_assessments WHERE status = 'approved'
    ) combined
) latest
WHERE rn = 1;

COMMENT ON VIEW v_resolved_assessments IS
    'Latest level per (employee, skill). source = supervisor_validated | self_approved; '
    'assessment_status = assessed | self_only. A skill with NO row here is never_assessed — '
    'see v_requirement_provenance; do not read a missing row as level 0.';

-- ---------------------------------------------------------------------------
-- 2. Requirement-level provenance: never_assessed is a first-class state
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS v_employee_assessment_coverage;
DROP VIEW IF EXISTS v_requirement_provenance;

CREATE VIEW v_requirement_provenance AS
SELECT
    e.employee_id,
    e.site_id, e.site_name,
    e.department_id, e.department_name,
    e.service_id, e.service_name,
    e.role_id, e.role_name,
    s.id AS skill_id, s.name AS skill_name,
    dom.id AS domain_id, dom.name AS domain_name,
    rsr.required_level,
    rsr.is_critical,
    -- NOT coalesced: NULL means "nobody has ever rated this", which is a very
    -- different fact from a rated level of 0.
    ra.level AS assessed_level,
    ra.source,
    ra.assessed_at,
    COALESCE(ra.assessment_status, 'never_assessed') AS assessment_status,
    CASE WHEN ra.level IS NOT NULL THEN 1 ELSE 0 END AS is_assessed
FROM v_employee_details e
JOIN role_skill_requirements rsr ON rsr.role_id = e.role_id
JOIN skills s                    ON s.id  = rsr.skill_id
JOIN domains dom                 ON dom.id = s.domain_id
LEFT JOIN v_resolved_assessments ra ON ra.employee_id = e.employee_id AND ra.skill_id = rsr.skill_id
WHERE rsr.required_level > 0;

COMMENT ON VIEW v_requirement_provenance IS
    'One row per (employee, required skill). assessment_status = never_assessed | self_only | assessed. '
    'assessed_level is NULL for never_assessed on purpose.';

-- ---------------------------------------------------------------------------
-- 3. Per-employee coverage + a PARALLEL assessed-only readiness
--    (v_employee_readiness is deliberately left untouched)
-- ---------------------------------------------------------------------------
CREATE VIEW v_employee_assessment_coverage AS
SELECT
    p.employee_id,
    p.site_id, p.site_name,
    p.department_id, p.department_name,
    p.service_id, p.service_name,
    p.role_id, p.role_name,
    COUNT(*)::int AS expected_skills,
    SUM(p.is_assessed)::int AS assessed_skills,
    SUM(CASE WHEN p.assessment_status = 'never_assessed' THEN 1 ELSE 0 END)::int AS never_assessed_skills,
    SUM(CASE WHEN p.assessment_status = 'self_only'      THEN 1 ELSE 0 END)::int AS self_only_skills,
    SUM(CASE WHEN p.assessment_status = 'assessed'       THEN 1 ELSE 0 END)::int AS validated_skills,
    SUM(CASE WHEN p.is_assessed = 1 AND p.is_critical THEN 1 ELSE 0 END)::int AS critical_assessed,
    SUM(CASE WHEN p.is_critical THEN 1 ELSE 0 END)::int AS critical_expected,
    CASE WHEN COUNT(*) > 0
        THEN ROUND(100.0 * SUM(p.is_assessed)::numeric / COUNT(*)::numeric, 1)
        ELSE NULL END AS coverage,
    -- Readiness over the ASSESSED requirements only. NULL (not 0) when nothing
    -- was ever assessed, so an empty record can never render as a real score.
    CASE WHEN SUM(CASE WHEN p.is_assessed = 1 THEN p.required_level ELSE 0 END) > 0
        THEN ROUND(
            100.0 * SUM(CASE WHEN p.is_assessed = 1 THEN LEAST(p.assessed_level, p.required_level) ELSE 0 END)::numeric
                  / SUM(CASE WHEN p.is_assessed = 1 THEN p.required_level ELSE 0 END)::numeric, 1)
        ELSE NULL END AS readiness_assessed_only
FROM v_requirement_provenance p
GROUP BY p.employee_id, p.site_id, p.site_name, p.department_id, p.department_name,
         p.service_id, p.service_name, p.role_id, p.role_name;

COMMENT ON VIEW v_employee_assessment_coverage IS
    'Per employee: assessed / expected requirement counts and readiness_assessed_only. '
    'expected_skills is the FULL department-designed requirement count — never a subset.';

-- ---------------------------------------------------------------------------
-- 4. Fail loudly if the view replace did not take (P0001 is NOT one of the
--    migration runner''s "already exists" codes, so this cannot be swallowed).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'v_resolved_assessments'
          AND column_name = 'assessment_status'
    ) THEN
        RAISE EXCEPTION
            'migration 71: v_resolved_assessments has no assessment_status column — the view replace did not take';
    END IF;
END $$;

INSERT INTO schema_meta(key, value) VALUES ('71_assessment_provenance', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();

COMMIT;
