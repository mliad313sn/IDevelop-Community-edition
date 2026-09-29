-- Provenance must say "certificate lapsed", not "supervisor rated you 0".
--
-- Migration 136 degraded v_requirement_provenance.assessed_level to 0 on a
-- lapsed certificate so the coverage view's readiness matched the gaps view.
-- That is correct for the EFFECTIVE level (the person cannot perform the task
-- today), but it destroyed the distinction the employee profile needs: a
-- genuine supervisor rating of 0 now looks identical to a rating of 4 whose
-- certificate expired. The profile card reads the row as
-- "Assessed and rated 0 — real data" for someone a supervisor rated 1 and whose
-- only fault is an expired certificate (employee 87, skill 318 on the dev set).
--
-- Fix: keep assessed_level as the EFFECTIVE level (0 on lapse — 136's fix and
-- the coverage math depend on it), and ADD two columns so a consumer can tell
-- the two apart:
--   rated_level  — the raw supervisor/self rating, BEFORE the lapse degrade.
--   cert_lapsed  — true when a held certificate for this requirement has lapsed.
-- CREATE OR REPLACE VIEW only permits adding columns at the end, which is what
-- this does; every existing column keeps its name, type and position.
--
-- ONE STATEMENT ON PURPOSE. The runner executes each file in a single
-- transaction and swallows six "already exists" SQLSTATEs, stamping the file as
-- applied even when a later statement never ran; a one-statement file cannot be
-- half-applied.
CREATE OR REPLACE VIEW v_requirement_provenance AS
SELECT e.employee_id,
    e.site_id,
    e.site_name,
    e.department_id,
    e.department_name,
    e.service_id,
    e.service_name,
    e.role_id,
    e.role_name,
    s.id AS skill_id,
    s.name AS skill_name,
    dom.id AS domain_id,
    dom.name AS domain_name,
    rsr.required_level,
    rsr.is_critical,
    -- 0::smallint, not 0. assessed_level is smallint; an untyped 0 promotes the
    -- CASE to integer, which changes the column type, and CREATE OR REPLACE VIEW
    -- then fails with 42P16 (see migration 136).
    CASE
        WHEN cl.employee_id IS NOT NULL THEN 0::smallint
        ELSE ra.level
    END AS assessed_level,
    ra.source,
    ra.assessed_at,
    COALESCE(ra.assessment_status, 'never_assessed'::text) AS assessment_status,
    CASE
        WHEN ra.level IS NOT NULL THEN 1
        ELSE 0
    END AS is_assessed,
    -- The raw rating, unaffected by the lapse. When cert_lapsed is true this is
    -- what the supervisor actually recorded; the profile shows it as the reason
    -- the effective level is 0, rather than pretending the supervisor rated 0.
    ra.level AS rated_level,
    (cl.employee_id IS NOT NULL) AS cert_lapsed
   FROM v_employee_details e
     JOIN role_skill_requirements rsr ON rsr.role_id = e.role_id
     JOIN skills s ON s.id = rsr.skill_id
     JOIN domains dom ON dom.id = s.domain_id
     LEFT JOIN v_certification_lapsed cl
            ON cl.employee_id = e.employee_id AND cl.skill_id = rsr.skill_id
     LEFT JOIN LATERAL ( SELECT c.level,
            c.source,
            c.assessed_at,
            c.assessment_status
           FROM (( SELECT sa.current_level AS level,
                    'supervisor_validated'::text AS source,
                    sa.assessed_at,
                    'assessed'::text AS assessment_status,
                    1 AS branch
                   FROM skill_assessments sa
                  WHERE sa.employee_id = e.employee_id AND sa.skill_id = rsr.skill_id
                  ORDER BY sa.assessed_at DESC
                 LIMIT 1)
                UNION ALL
                ( SELECT sf.self_rated_level,
                    'self_approved'::text,
                    sf.created_at,
                    'self_only'::text,
                    2
                   FROM self_assessments sf
                  WHERE sf.employee_id = e.employee_id AND sf.skill_id = rsr.skill_id AND sf.status = 'approved'::self_assessment_state
                  ORDER BY sf.created_at DESC
                 LIMIT 1)) c
          ORDER BY c.assessed_at DESC, c.branch
         LIMIT 1) ra ON true
  WHERE rsr.required_level > 0;
