-- 157 — Legal hold set BEFORE departure (release 3.23.21, lane L4, finding F11)
--
-- Migration 151 put the legal hold on pii_cleanup_jobs, a row that only exists
-- once a person has LEFT. A hold decided while the person is still employed
-- (litigation, labour inspection, pending claim) had nowhere to live, so the
-- retention clock started unheld on the day of departure.
--
-- The hold is now recorded on the employee (who / when / why) and carried into
-- the retention job when the departure schedules it (LifecycleService.onLeaver),
-- so the retention purge (DSRService.runRetention, which skips a held job)
-- never erases a person who was put on hold before leaving.
--
-- Additive and idempotent. Nothing is deleted.

ALTER TABLE employees ADD COLUMN IF NOT EXISTS legal_hold_at     timestamptz;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS legal_hold_by     text;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS legal_hold_reason text;
