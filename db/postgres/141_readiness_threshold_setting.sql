-- 141 — is_role_ready reads the configured readinessThreshold (re-audit A1)
--
-- ReadinessService (JS) bands "role ready" at the admin setting readinessThreshold
-- (AppSettingsModel, default 80), but v_employee_readiness.is_role_ready hard-coded
-- >= 80. At a threshold of 60 the report (JS) and the dashboard (is_role_ready)
-- disagreed on who is ready. The two are otherwise the SAME rule — all-requirement
-- readiness >= threshold AND every critical requirement met — so the only drift is
-- the constant. This routes the view through a function that reads the same setting,
-- so a change to readinessThreshold moves both surfaces at once.
--
-- The view body is migration 81 verbatim (the scope-pushdown joins included);
-- the ONLY change is `>= 80` -> `>= app_readiness_threshold`. CREATE OR REPLACE,
-- so the column list/types are unchanged (is_role_ready stays integer 1/0).

-- ---------------------------------------------------------------------------
-- 0. The single source of the readiness threshold, mirroring
--    AppSettingsModel.getValue('readinessThreshold', 80): the stored value when
--    it is a well-formed number, else 80. STABLE — one lookup per statement, and
--    a malformed value can never crash a readiness query (it falls back to 80).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_readiness_threshold() RETURNS numeric
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(
        (SELECT btrim(setting_value)::numeric
           FROM app_settings
          WHERE setting_key = 'readinessThreshold'
            AND btrim(setting_value) ~ '^[0-9]+(\.[0-9]+)?$'),
        80
    );
$$;

-- ---------------------------------------------------------------------------
-- 1. The view, threshold read from the setting.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_employee_readiness AS
SELECT
    e.employee_id,
    e.full_name,
    e.site_id, e.site_name,
    e.department_id, e.department_name,
    e.service_id, e.service_name,
    e.role_id, e.role_name,
    COUNT(g.skill_id) AS total_required,
    SUM(g.is_met)::int AS skills_met,
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
            AND (100.0 * SUM(LEAST(g.actual_level, g.required_level))::numeric / SUM(g.required_level)::numeric) >= app_readiness_threshold()
            AND SUM(CASE WHEN g.is_critical THEN 1 ELSE 0 END)
              = SUM(CASE WHEN g.is_critical AND g.is_met = 1 THEN 1 ELSE 0 END)
        )
        THEN 1 ELSE 0 END AS is_role_ready,
    SUM(g.is_assessed)::int AS assessed_required,
    SUM(CASE WHEN g.is_assessed = 0 THEN 1 ELSE 0 END)::int AS never_assessed_required,
    SUM(CASE WHEN g.is_assessed = 0 AND g.gap > 0 THEN g.gap ELSE 0 END)::int AS unassessed_gap_points
FROM v_employee_details e
JOIN v_employee_skill_gaps g
  ON  g.employee_id = e.employee_id
  AND g.site_id       = e.site_id
  AND g.department_id = e.department_id
  AND g.service_id    = e.service_id
  AND g.role_id       = e.role_id
  AND g.site_name       = e.site_name
  AND g.department_name = e.department_name
  AND g.service_name    = e.service_name
  AND g.role_name       = e.role_name
GROUP BY e.employee_id, e.full_name, e.site_id, e.site_name, e.department_id, e.department_name,
         e.service_id, e.service_name, e.role_id, e.role_name;
