-- =====================================================================
-- 58_planned_absences_predicted_coverage.sql — predicted-breach coverage
-- ("next Tuesday, Site X drops below 2 certified first-aiders").
--
-- Extends the safe-shift engine (migration 56) from REACTIVE (is the rule
-- met right now?) to PREDICTIVE: planned absences + certificate expiry are
-- projected over a horizon (default 14 days) so a coverage breach is flagged
-- BEFORE the day it happens. Additive & idempotent.
--
--   planned_absences — admin-recorded leave/training/mission windows per
--     employee. An employee is "absent" on day D when D falls inside any
--     window. (HRIS sync can feed this table later — the shape is the API.)
--
--   coverage_rules.predicted_* — the persisted prediction watermark written
--     by the coverage-check job: the earliest projected breach day inside
--     the horizon and the qualified headcount on that day. Alerts fire only
--     when the prediction APPEARS or moves EARLIER — never repeatedly.
--
--   v_coverage_status — recreated with the prediction columns appended so
--     every consumer (page, digest, Power BI feed) sees them for free.
-- =====================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS planned_absences (
    id          bigserial PRIMARY KEY,
    employee_id bigint NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    starts_on   date NOT NULL,
    ends_on     date NOT NULL,
    kind        text NOT NULL DEFAULT 'leave'
                CHECK (kind IN ('leave', 'training', 'mission', 'medical', 'other')),
    note        text,
    created_by  bigint,                          -- admins.id
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_absence_window CHECK (ends_on >= starts_on)
);

CREATE INDEX IF NOT EXISTS idx_planned_absences_employee ON planned_absences(employee_id, starts_on);
CREATE INDEX IF NOT EXISTS idx_planned_absences_window   ON planned_absences(starts_on, ends_on);

-- Prediction watermark on the rule row (written by coverage-check).
ALTER TABLE coverage_rules ADD COLUMN IF NOT EXISTS predicted_breach_on  date;
ALTER TABLE coverage_rules ADD COLUMN IF NOT EXISTS predicted_qualified  integer;
ALTER TABLE coverage_rules ADD COLUMN IF NOT EXISTS last_predicted_at    timestamptz;

-- Recreate the status view with the prediction columns appended (the LATERAL
-- evaluation is unchanged from migration 56).
DROP VIEW IF EXISTS v_coverage_status CASCADE;
CREATE VIEW v_coverage_status AS
SELECT
    r.id AS rule_id, r.name, r.severity, r.require_valid_cert,
    r.site_id, st.name AS site_name,
    r.department_id, d.name AS department_name,
    r.service_id, sv.name AS service_name,
    r.skill_id, s.name AS skill_name,
    r.min_level, r.min_headcount,
    r.last_satisfied, r.breached_since,
    COALESCE(q.qualified, 0) AS qualified_headcount,
    (COALESCE(q.qualified, 0) >= r.min_headcount) AS satisfied,
    r.predicted_breach_on,
    r.predicted_qualified,
    r.last_predicted_at
FROM coverage_rules r
JOIN skills s ON s.id = r.skill_id
LEFT JOIN sites st       ON st.id = r.site_id
LEFT JOIN departments d  ON d.id  = r.department_id
LEFT JOIN services sv    ON sv.id = r.service_id
LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS qualified
      FROM v_employee_details ed
      JOIN v_resolved_assessments ra
        ON ra.employee_id = ed.employee_id
       AND ra.skill_id = r.skill_id
       AND ra.level >= r.min_level
     WHERE (r.site_id       IS NULL OR ed.site_id       = r.site_id)
       AND (r.department_id IS NULL OR ed.department_id = r.department_id)
       AND (r.service_id    IS NULL OR ed.service_id    = r.service_id)
       AND (NOT r.require_valid_cert OR EXISTS (
                SELECT 1
                  FROM v_certification_current cc
                 WHERE cc.employee_id = ed.employee_id
                   AND cc.skill_id = r.skill_id
                   AND cc.cert_status IN ('valid', 'expiring', 'no_expiry')))
) q ON true
WHERE r.is_active;

INSERT INTO schema_meta(key, value) VALUES ('58_planned_absences_predicted_coverage', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();

COMMIT;
