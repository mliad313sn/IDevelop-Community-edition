-- 43_report_schedules.sql — scheduled email delivery of saved report templates.
-- A schedule binds a report_template to recipients + a cadence; the scheduler tick
-- (src/jobs/report-scheduler.js) runs due schedules headlessly with the creator's
-- RBAC scope and emails the CSV. Additive & idempotent.

CREATE TABLE IF NOT EXISTS report_schedules (
    id            serial PRIMARY KEY,
    template_id   integer NOT NULL REFERENCES report_templates(id) ON DELETE CASCADE,
    recipients    text    NOT NULL,                      -- comma-separated emails
    frequency     text    NOT NULL DEFAULT 'weekly'
                  CHECK (frequency IN ('daily','weekly','monthly')),
    day_of_week   integer CHECK (day_of_week BETWEEN 0 AND 6),  -- weekly only (0=Sunday)
    hour          integer NOT NULL DEFAULT 6 CHECK (hour BETWEEN 0 AND 23),
    is_active     boolean NOT NULL DEFAULT true,
    created_by    integer NOT NULL,                      -- admins.id or employees.id
    creator_role  text    NOT NULL DEFAULT 'localadmin', -- RBAC role snapshot for headless scoping
    last_run_at   timestamptz,
    last_status   text,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_report_schedules_active
    ON report_schedules(is_active, last_run_at);

INSERT INTO schema_meta(key, value) VALUES ('43_report_schedules', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();
