-- 142 — an APPROVED self-assessment must carry a self-rated level (re-audit R3)
--
-- The resolved-assessment / readiness / provenance views union supervisor
-- validations with APPROVED self-assessments and keep the latest per
-- (employee, skill). A self_assessments row with status='approved' but a NULL
-- self_rated_level produces a NULL-level "self_approved" row that, being the most
-- recent, can WIN the tie-break and SUPPRESS a real supervisor-validated level —
-- turning a measured skill into "not measured", and breaking the coverage-view
-- identity (assessed = supervisor + approved-self). It cannot arise from the app
-- (approval always carries a level) but a bulk import or the super-admin SQL
-- Console could write it.
--
-- Root-cause guard: a CHECK so the bad row can never exist — which makes every
-- one of those views safe without touching them. As belt-and-suspenders the
-- primary view (v_resolved_assessments) also filters the self branch.

-- 1. The constraint on the real table (self_assessments is a compat VIEW over
--    self_assessment_rounds). Guarded so a re-run cannot duplicate it.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'self_assessment_rounds_approved_has_level'
    ) THEN
        ALTER TABLE self_assessment_rounds
            ADD CONSTRAINT self_assessment_rounds_approved_has_level
            CHECK (status <> 'approved'::self_assessment_state OR self_rated_level IS NOT NULL);
    END IF;
END $$;

-- 2. Belt on the primary consumer: the self branch ignores an approved row with
--    no level even if one somehow existed (migration 71 body, one added predicate).
CREATE OR REPLACE VIEW v_resolved_assessments AS
SELECT employee_id, skill_id, level, source, assessed_at, assessment_status
FROM (
    SELECT employee_id, skill_id, current_level AS level, source, assessed_at,
           (CASE WHEN source = 'supervisor_validated' THEN 'assessed' ELSE 'self_only' END)::text
               AS assessment_status,
           ROW_NUMBER() OVER (PARTITION BY employee_id, skill_id ORDER BY assessed_at DESC) AS rn
    FROM (
        SELECT employee_id, skill_id, current_level, assessed_at,
               'supervisor_validated'::text AS source
        FROM skill_assessments
        UNION ALL
        SELECT employee_id, skill_id, self_rated_level AS current_level, created_at AS assessed_at,
               'self_approved'::text AS source
        FROM self_assessments
        WHERE status = 'approved' AND self_rated_level IS NOT NULL
    ) combined
) latest
WHERE rn = 1;
