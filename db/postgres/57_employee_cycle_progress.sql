-- =====================================================================
-- 57_employee_cycle_progress.sql — per-employee assessment-cycle history
-- and progression over time. Purely additive: two read views over data the
-- workflow already records (self_assessments, assessment_history,
-- readiness_snapshots) — no new writes, nothing to backfill.
--
--   v_employee_cycle_progress — one row per (employee, cycle) the employee
--     participated in: participation counts by workflow state, average
--     self-rated vs approved level, level movement recorded during the
--     cycle (assessment_history), and the readiness % snapshotted for that
--     cycle when one exists. Ordered by cycle open date, this is the
--     employee's progression curve.
--
--   v_employee_level_timeline — average CONFIRMED skill level per employee
--     per month (assessment_history), independent of cycles — the
--     continuous trend line between campaigns.
--
-- Both join v_employee_details (active employees only) so RBAC callers can
-- scope by employee_id BEFORE aggregating, and deactivated employees drop
-- out everywhere at once.
-- =====================================================================
BEGIN;

DROP VIEW IF EXISTS v_employee_cycle_progress CASCADE;
CREATE VIEW v_employee_cycle_progress AS
SELECT
    ed.employee_id, ed.full_name,
    ed.site_id, ed.site_name, ed.department_id, ed.department_name,
    ed.service_id, ed.service_name,
    c.id AS cycle_id, c.code AS cycle_code, c.label AS cycle_label,
    c.opened_at, c.closes_at, c.status AS cycle_status,
    -- participation in the campaign
    COUNT(sa.id)::int                                                          AS skills_in_cycle,
    COUNT(*) FILTER (WHERE sa.workflow_state = 'approved')::int                AS approved,
    COUNT(*) FILTER (WHERE sa.workflow_state IN ('submitted','under_review','reviewed','arbitration'))::int AS in_review,
    COUNT(*) FILTER (WHERE sa.workflow_state IN ('draft','changes_requested'))::int AS unsubmitted,
    COUNT(*) FILTER (WHERE sa.workflow_state = 'rejected')::int                AS rejected,
    ROUND(AVG(sa.self_rated_level)::numeric, 2)                                AS avg_self_rated,
    -- what actually got confirmed during the cycle + net movement
    h.avg_confirmed, h.moves, h.net_movement,
    -- readiness snapshotted for this cycle (fit-history / cycle close)
    rs.pct AS readiness_pct, rs.is_ready
FROM assessment_cycles c
JOIN self_assessments sa ON sa.cycle_id = c.id
JOIN v_employee_details ed ON ed.employee_id = sa.employee_id
LEFT JOIN LATERAL (
    SELECT ROUND(AVG(ah.new_level)::numeric, 2) AS avg_confirmed,
           COUNT(*)::int                        AS moves,
           COALESCE(SUM(ah.new_level - COALESCE(ah.previous_level, 0)), 0)::int AS net_movement
      FROM assessment_history ah
     WHERE ah.employee_id = ed.employee_id AND ah.cycle_id = c.id
) h ON true
LEFT JOIN LATERAL (
    SELECT pct, is_ready
      FROM readiness_snapshots r
     WHERE r.employee_id = ed.employee_id AND r.cycle_id = c.id
     ORDER BY r.computed_at DESC LIMIT 1
) rs ON true
GROUP BY ed.employee_id, ed.full_name, ed.site_id, ed.site_name, ed.department_id, ed.department_name,
         ed.service_id, ed.service_name, c.id, c.code, c.label, c.opened_at, c.closes_at, c.status,
         h.avg_confirmed, h.moves, h.net_movement, rs.pct, rs.is_ready;

DROP VIEW IF EXISTS v_employee_level_timeline CASCADE;
CREATE VIEW v_employee_level_timeline AS
SELECT
    ed.employee_id,
    to_char(date_trunc('month', ah.assessed_at), 'YYYY-MM') AS month,
    ROUND(AVG(ah.new_level)::numeric, 2) AS avg_level,
    COUNT(*)::int AS assessments
FROM assessment_history ah
JOIN v_employee_details ed ON ed.employee_id = ah.employee_id
GROUP BY ed.employee_id, date_trunc('month', ah.assessed_at);

INSERT INTO schema_meta(key, value) VALUES ('57_employee_cycle_progress', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();

COMMIT;
