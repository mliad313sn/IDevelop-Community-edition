-- 102_report_schedules_creator_type.sql — who really owns a report schedule.
--
-- report_schedules.created_by is polymorphic: an admins.id when an admin
-- scheduled the report, an employees.id when a manager did (the two are
-- separate sequences). Nothing recorded WHICH, so src/jobs/report-scheduler.js
-- replayed every schedule as userType 'admin'. For a manager that meant the
-- headless RBAC scope resolved against admin_scopes for an admin id that is
-- really an employee id: no scope rows → fail-closed `1=0` → an EMPTY CSV
-- e-mailed with last_status 'ok'; and where an admin happened to share the id,
-- the manager's report ran under that unrelated admin's clearance.
--
-- report_templates solved the same problem in migration 67 with creator_type;
-- this file does the identical thing for schedules. Additive & idempotent.
--
-- BACKFILL RULE (applied once, to rows that predate the column):
--   1. creator_role IN ('superadmin', 'viewer')          → 'admin'
--      Only an admin session carries these roles; a manager's fallback role
--      was 'localadmin', so that value alone proves nothing.
--   2. else created_by matches an admins.id AND NO employees.id → 'admin'
--   3. else                                                     → 'employee'
--      This covers: an employees.id match (a manager), an id present in BOTH
--      sequences (the collision case — the manager's governed span is the
--      narrower, safer scope; an admin whose schedule is mis-typed here gets a
--      manager-scoped, i.e. empty, report rather than a wider one), and an id
--      in NEITHER (an orphan → scopes to nothing → fail closed).
--   Every rule errs towards the NARROWER clearance: a wrongly-typed row can
--   under-deliver a report, never over-deliver one.

ALTER TABLE report_schedules ADD COLUMN IF NOT EXISTS creator_type text;

UPDATE report_schedules s
   SET creator_type = CASE
        WHEN s.creator_role IN ('superadmin', 'viewer') THEN 'admin'
        WHEN EXISTS (SELECT 1 FROM admins a WHERE a.id = s.created_by)
         AND NOT EXISTS (SELECT 1 FROM employees e WHERE e.id = s.created_by) THEN 'admin'
        ELSE 'employee'
       END
 WHERE s.creator_type IS NULL;

ALTER TABLE report_schedules ALTER COLUMN creator_type SET DEFAULT 'admin';
ALTER TABLE report_schedules ALTER COLUMN creator_type SET NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_report_schedules_creator_type') THEN
    ALTER TABLE report_schedules ADD CONSTRAINT chk_report_schedules_creator_type
        CHECK (creator_type IN ('admin', 'employee'));
  END IF;
END $$;

COMMENT ON COLUMN report_schedules.creator_type IS
    'admin → created_by is admins.id; employee → created_by is employees.id (a manager). The scheduler replays the schedule under THIS identity type, so the recipients only ever receive what the creator could see.';

INSERT INTO schema_meta(key, value) VALUES ('102_report_schedules_creator_type', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();
