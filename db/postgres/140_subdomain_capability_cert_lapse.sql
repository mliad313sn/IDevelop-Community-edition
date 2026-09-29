-- Same lapse blind spot as migration 139, on the sub-domain capability view.
--
-- v_subdomain_capability also takes ra.level straight from v_resolved_assessments
-- with no certification-lapse degrade. It feeds the sub-domain capability radars
-- and averages, so a lapsed certificate inflated them exactly as it inflated the
-- domain view. Degrade a lapse to 0, consistent with every sibling.
--
-- 0::smallint, not 0 (see migration 136). ONE STATEMENT ON PURPOSE (see 138).
-- The INNER JOIN on sub_domains is left exactly as it was (re-audit R4 tracks the
-- nullable sub_domain_id separately); this migration changes only the lapse.
CREATE OR REPLACE VIEW v_subdomain_capability AS
SELECT
    ra.employee_id,
    s.id   AS skill_id,   s.name AS skill_name,
    sd.id  AS sub_domain_id, sd.name AS sub_domain_name,
    d.id   AS domain_id,  d.name AS domain_name,
    COALESCE(s.category, 'Technical') AS category,
    CASE WHEN cl.employee_id IS NOT NULL THEN 0::smallint ELSE ra.level END AS level,
    ed.site_id, ed.site_name,
    ed.department_id, ed.department_name,
    ed.service_id, ed.service_name,
    ed.role_id, ed.role_name
FROM v_resolved_assessments ra
JOIN skills s        ON s.id = ra.skill_id
JOIN sub_domains sd  ON sd.id = s.sub_domain_id
JOIN domains d       ON d.id = sd.domain_id
JOIN v_employee_details ed ON ed.employee_id = ra.employee_id
LEFT JOIN v_certification_lapsed cl
       ON cl.employee_id = ra.employee_id AND cl.skill_id = ra.skill_id;
