-- V1 dashboard views ported to PostgreSQL.
-- Mirrors src/database/database_views.sql but in snake_case.

BEGIN;

-- v_resolved_assessments: latest per (employee, skill), WITH real provenance.
-- `source` used to be the constant 'assessment' on both branches, which made a
-- supervisor-validated level indistinguishable from an auto-approved self-rating.
-- It now carries the branch it came from, and `assessment_status` derives from it.
-- A skill with NO row here is never_assessed — see v_requirement_provenance
-- (migration 71); a missing row must never be read as level 0.
DROP VIEW IF EXISTS v_resolved_assessments CASCADE;
CREATE VIEW v_resolved_assessments AS
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
        FROM self_assessments WHERE status = 'approved'
    ) combined
) latest
WHERE rn = 1;

-- v_employee_details
DROP VIEW IF EXISTS v_employee_details CASCADE;
CREATE VIEW v_employee_details AS
SELECT
    e.id AS employee_id,
    e.employee_number,
    e.first_name,
    e.last_name,
    e.first_name || ' ' || e.last_name AS full_name,
    e.email,
    e.is_active,
    e.supervisor_id,
    s.id AS site_id, s.name AS site_name,
    d.id AS department_id, d.name AS department_name,
    sv.id AS service_id, sv.name AS service_name,
    r.id AS role_id, r.name AS role_name
FROM employees e
LEFT JOIN sites s        ON s.id  = e.site_id
LEFT JOIN departments d  ON d.id  = e.department_id
LEFT JOIN services sv    ON sv.id = e.service_id
LEFT JOIN roles r        ON r.id  = e.role_id
WHERE e.is_active = true;

-- v_employee_skill_gaps
DROP VIEW IF EXISTS v_employee_skill_gaps CASCADE;
CREATE VIEW v_employee_skill_gaps AS
SELECT
    e.employee_id,
    e.site_id, e.site_name,
    e.department_id, e.department_name,
    e.service_id, e.service_name,
    e.role_id, e.role_name,
    s.id AS skill_id, s.name AS skill_name,
    dom.id AS domain_id, dom.name AS domain_name,
    rsr.required_level,
    COALESCE(ra.level, 0) AS actual_level,
    (rsr.required_level - COALESCE(ra.level, 0)) AS gap,
    rsr.is_critical,
    CASE WHEN ra.level IS NOT NULL THEN 1 ELSE 0 END AS is_assessed,
    CASE WHEN COALESCE(ra.level, 0) >= rsr.required_level THEN 1 ELSE 0 END AS is_met
FROM v_employee_details e
JOIN role_skill_requirements rsr ON rsr.role_id = e.role_id
JOIN skills s                    ON s.id  = rsr.skill_id
JOIN domains dom                 ON dom.id = s.domain_id
LEFT JOIN v_resolved_assessments ra ON ra.employee_id = e.employee_id AND ra.skill_id = rsr.skill_id
WHERE rsr.required_level > 0;

-- v_employee_readiness
DROP VIEW IF EXISTS v_employee_readiness CASCADE;
CREATE VIEW v_employee_readiness AS
SELECT
    e.employee_id,
    e.full_name,
    e.site_id, e.site_name,
    e.department_id, e.department_name,
    e.service_id, e.service_name,
    e.role_id, e.role_name,
    COUNT(g.skill_id) AS total_required,
    SUM(g.is_met)::int AS skills_met,
    SUM(CASE WHEN g.gap > 0 THEN g.gap ELSE 0 END)::int AS total_gap_points,
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
        THEN 1 ELSE 0 END AS is_role_ready
FROM v_employee_details e
JOIN v_employee_skill_gaps g ON g.employee_id = e.employee_id
GROUP BY e.employee_id, e.full_name, e.site_id, e.site_name, e.department_id, e.department_name,
         e.service_id, e.service_name, e.role_id, e.role_name;

-- v_domain_capability (includes org dimensions for the report builder)
DROP VIEW IF EXISTS v_domain_capability CASCADE;
CREATE VIEW v_domain_capability AS
SELECT
    ra.employee_id,
    s.id AS skill_id, s.name AS skill_name,
    d.id AS domain_id, d.name AS domain_name,
    COALESCE(s.category, 'Technical') AS category,
    ra.level,
    ed.site_id, ed.site_name,
    ed.department_id, ed.department_name,
    ed.service_id, ed.service_name,
    ed.role_id, ed.role_name
FROM v_resolved_assessments ra
JOIN skills s   ON s.id = ra.skill_id
JOIN domains d  ON d.id = s.domain_id
JOIN v_employee_details ed ON ed.employee_id = ra.employee_id;

INSERT INTO schema_meta(key, value) VALUES ('07_dashboard_views', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();

COMMIT;
