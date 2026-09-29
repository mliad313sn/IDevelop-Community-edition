-- A lapsed certificate still made someone a domain "expert".
--
-- v_domain_capability takes ra.level straight from v_resolved_assessments with
-- no certification-lapse degrade, so a person rated 4 whose certificate has
-- expired still reads as level 4 — and getTeamExperts lists everyone at
-- level >= 4 as an expert, so it would name someone who may not perform that
-- task today. Every sibling view (v_employee_skill_gaps, v_requirement_provenance)
-- degrades a lapse to 0; this one never did. The capability averages the
-- dashboard draws from this view had the same blind spot.
--
-- A lapse degrades the LEVEL to 0 (the person cannot perform the task today),
-- exactly as in the sibling views. 0::smallint, not 0 — `level` is smallint and
-- an untyped 0 promotes the CASE to integer, which CREATE OR REPLACE VIEW then
-- refuses with 42P16 (see migration 136).
--
-- ONE STATEMENT ON PURPOSE (see migration 138).
CREATE OR REPLACE VIEW v_domain_capability AS
SELECT
    ra.employee_id,
    s.id AS skill_id, s.name AS skill_name,
    d.id AS domain_id, d.name AS domain_name,
    COALESCE(s.category, 'Technical') AS category,
    CASE WHEN cl.employee_id IS NOT NULL THEN 0::smallint ELSE ra.level END AS level,
    ed.site_id, ed.site_name,
    ed.department_id, ed.department_name,
    ed.service_id, ed.service_name,
    ed.role_id, ed.role_name
FROM v_resolved_assessments ra
JOIN skills s   ON s.id = ra.skill_id
JOIN domains d  ON d.id = s.domain_id
JOIN v_employee_details ed ON ed.employee_id = ra.employee_id
LEFT JOIN v_certification_lapsed cl
       ON cl.employee_id = ra.employee_id AND cl.skill_id = ra.skill_id;
