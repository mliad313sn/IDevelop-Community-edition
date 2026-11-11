-- 172_report_schedule_recipients.sql — scheduled reports go to ACCOUNTS only,
-- and the mail carries a link, never the data (SA-38).
--
-- Before: report_schedules.recipients was free text; the scheduler e-mailed the
-- CSV as an attachment to any address that looked like one. Nobody checked that
-- the reader was cleared for the report, and every run left a copy of HR data in
-- mailboxes outside the application.
--
-- From this migration:
--   * recipients are ACCOUNTS (report_schedule_recipients: an admin or an
--     employee id). Each one must hold a clearance covering the report's scope
--     (the creator's scope, under which the report runs) when the schedule is
--     written AND at every run;
--   * each run stores ONE in-app copy (report_schedule_runs); the mail and the
--     in-app notice only link to it, and its download re-checks the reader;
--   * the system can switch a schedule off with a reason (enabled = false,
--     disabled_reason), distinct from the owner's own pause (is_active).
--
-- EXISTING SCHEDULES that send to typed addresses:
--   * when EVERY address of a schedule matches exactly one active account
--     (admins.email or employees.email, case-insensitive), those accounts become
--     its recipients. The run-time clearance check still applies to them;
--   * otherwise the schedule is suspended (enabled = false, disabled_reason
--     'legacy_outside_address') and its owner gets one in-app notice that links
--     to the schedules page, where choosing accounts re-enables it.
--   Nothing is deleted: the old `recipients` text stays on the row so the owner
--   can see what it used to be.
--
-- Idempotent: IF NOT EXISTS everywhere, ON CONFLICT DO NOTHING, and a schedule
-- is only processed while it has no account recipient and no disabled_reason,
-- so a second run changes nothing and notifies nobody twice.

ALTER TABLE report_schedules ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
ALTER TABLE report_schedules ADD COLUMN IF NOT EXISTS disabled_reason text;
ALTER TABLE report_schedules ADD COLUMN IF NOT EXISTS disabled_at timestamptz;

CREATE TABLE IF NOT EXISTS report_schedule_recipients (
    id              serial PRIMARY KEY,
    schedule_id     integer NOT NULL REFERENCES report_schedules(id) ON DELETE CASCADE,
    recipient_type  text    NOT NULL CHECK (recipient_type IN ('admin', 'employee')),
    recipient_id    integer NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    -- A recipient taken off the list keeps its row, with the date.
    removed_at      timestamptz,
    UNIQUE (schedule_id, recipient_type, recipient_id)
);
CREATE INDEX IF NOT EXISTS idx_report_schedule_recipients_account
    ON report_schedule_recipients (recipient_type, recipient_id);

COMMENT ON TABLE report_schedule_recipients IS
    'Accounts a report schedule is delivered to (admin or employee id). Each is re-checked at every run against the scope the report is produced under. An erased employee''s rows are deleted (erasureRegistry).';

-- The in-app copy of each run. `scope_ids` is the clearance the report was
-- produced under (JSON array of employee ids; JSON null = unrestricted): a
-- download is served only to a reader whose CURRENT scope covers it.
CREATE TABLE IF NOT EXISTS report_schedule_runs (
    id           bigserial PRIMARY KEY,
    schedule_id  integer NOT NULL REFERENCES report_schedules(id) ON DELETE CASCADE,
    created_at   timestamptz NOT NULL DEFAULT now(),
    row_count    integer,
    scope_ids    jsonb,
    filename     text NOT NULL,
    content      text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_report_schedule_runs_schedule
    ON report_schedule_runs (schedule_id, created_at DESC);

COMMENT ON TABLE report_schedule_runs IS
    'In-app copy (CSV) of each scheduled report run; the mail only links to it. Emptied after reportRunRetentionDays and when a person in its scope is erased (migration 173).';

-- ---- Existing schedules -------------------------------------------------------
-- One row per (schedule, address), with the number of accounts that address matches.
WITH legacy AS (
    SELECT s.id, s.recipients
      FROM report_schedules s
     WHERE s.disabled_reason IS NULL
       AND btrim(COALESCE(s.recipients, '')) <> ''
       AND NOT EXISTS (SELECT 1 FROM report_schedule_recipients r WHERE r.schedule_id = s.id)
),
addr AS (
    SELECT l.id AS schedule_id, lower(btrim(a.addr)) AS addr
      FROM legacy l
     CROSS JOIN LATERAL unnest(string_to_array(l.recipients, ',')) AS a(addr)
     WHERE btrim(a.addr) <> ''
),
accounts AS (
    SELECT 'admin'::text AS t, a.id, lower(btrim(a.email)) AS addr
      FROM admins a
     WHERE COALESCE(a.is_active, true) AND a.email IS NOT NULL AND btrim(a.email) <> ''
    UNION ALL
    SELECT 'employee'::text, e.id, lower(btrim(e.email))
      FROM employees e
     WHERE e.is_active AND e.cancelled_at IS NULL AND e.erased_at IS NULL
       AND e.email IS NOT NULL AND btrim(e.email) <> ''
),
matched AS (
    SELECT d.schedule_id, d.addr, count(ac.id) AS n,
           min(ac.t) AS t, min(ac.id) AS account_id
      FROM addr d
      LEFT JOIN accounts ac ON ac.addr = d.addr
     GROUP BY d.schedule_id, d.addr
),
mappable AS (
    SELECT schedule_id FROM matched GROUP BY schedule_id HAVING bool_and(n = 1)
)
INSERT INTO report_schedule_recipients (schedule_id, recipient_type, recipient_id)
SELECT m.schedule_id, m.t, m.account_id
  FROM matched m
  JOIN mappable p ON p.schedule_id = m.schedule_id
ON CONFLICT (schedule_id, recipient_type, recipient_id) DO NOTHING;

-- What could not be mapped is suspended with its reason, and its owner gets an
-- in-app notice (the title and text are localised from the kind when shown).
WITH suspended AS (
    UPDATE report_schedules s
       SET enabled = false,
           disabled_reason = 'legacy_outside_address',
           disabled_at = now()
     WHERE s.disabled_reason IS NULL
       AND btrim(COALESCE(s.recipients, '')) <> ''
       AND NOT EXISTS (SELECT 1 FROM report_schedule_recipients r WHERE r.schedule_id = s.id)
    RETURNING s.id, s.created_by, s.creator_type
)
INSERT INTO notifications (user_type, user_id, channel, kind, locale, payload, state)
SELECT CASE WHEN x.creator_type = 'admin' THEN 'admin' ELSE 'employee' END,
       x.created_by,
       'inapp'::notif_channel,
       'report.schedule_suspended',
       'fr',
       jsonb_build_object('scheduleId', x.id, 'link', '/reports/schedules'),
       'queued'::notif_state
  FROM suspended x
 WHERE x.created_by IS NOT NULL;

-- The SQL console reader sees the new tables and columns (migration 168).
SELECT public.fn_console_reader_sync();
