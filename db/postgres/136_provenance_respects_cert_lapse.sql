-- A lapsed certificate was still credited by v_requirement_provenance.
--
-- v_employee_skill_gaps joins v_certification_lapsed and degrades the effective
-- level to 0 when a held certificate has expired or been revoked — the person
-- may not perform that task today. Its sibling v_requirement_provenance, which
-- v_employee_assessment_coverage reads, never got the same join, so the two
-- disagreed about the same person on the same day:
--
--   employee 87, skill 318 (certificate expired 2026-09-14)
--     v_employee_skill_gaps        actual_level 0, is_met 0   (correct)
--     v_requirement_provenance     assessed_level 1           (credits the lapse)
--     ReadinessService             57.8 %                     (reads the gaps view)
--     coverage view                58.8 %                     (reads provenance)
--
-- A lapse degrades the LEVEL, never the fact of measurement: is_assessed stays
-- 1, exactly as in the sibling view and as ContinuityService documents, so
-- coverage and the department-designed requirement count are unchanged.
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
    -- 0::smallint, not 0. assessed_level is smallint; an untyped 0 promotes
    -- the CASE to integer, which changes the column type, and CREATE OR REPLACE
    -- VIEW then fails with 42P16 -- which the migration runner SWALLOWS and
    -- stamps as 'pre-existing', so the file is never retried and the view is
    -- silently left unchanged. That happened on the first attempt at this file.
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
    END AS is_assessed
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
