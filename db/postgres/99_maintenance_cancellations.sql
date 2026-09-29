-- SuperAdmin maintenance cancellations.
--
-- A record raised in error — an IDP against the wrong person, a PIP opened on a
-- duplicate, a 9-box position approved from bad data, an employee created twice —
-- had no one-step way back. The IDP/PIP cancellation queue deliberately enforces
-- a two-person rule (requester can never be the approver), which is right for the
-- normal path and useless when a SuperAdmin is fixing data at 22:00 and there is
-- no second pair of eyes to route it through.
--
-- What this migration adds is the AUDIT surface for that maintenance path, not
-- the permission: nothing here loosens a guard.
--
--   1. Two new movement kinds, so a cancellation shows up in the movement feed
--      next to the site/role/manager changes instead of only in system_logs.
--      The feed is where "what happened to this person" is read.
--   2. Three columns on `employees`, so a voided record says WHO voided it, WHEN
--      and WHY. `is_active = false` alone cannot distinguish "left the company"
--      from "should never have existed" — and a leaver must not be silently
--      reclassified as a data-entry error.
--
-- Nothing is deleted anywhere in this feature; a void is a state plus a reason.
-- Idempotent: safe to re-run.

-- 1) Movement kinds -----------------------------------------------------------
-- The CHECK is dropped and recreated rather than altered (PostgreSQL has no
-- ALTER CONSTRAINT for CHECK). Existing rows all carry one of the original seven
-- kinds, so the recreated constraint validates without touching data.
ALTER TABLE employee_movements DROP CONSTRAINT IF EXISTS employee_movements_kind_check;
ALTER TABLE employee_movements ADD CONSTRAINT employee_movements_kind_check
    CHECK (kind = ANY (ARRAY[
        'site', 'department', 'service', 'role', 'manager', 'supervisor', 'status',
        'plan_cancelled',        -- an IDP or PIP cancelled by maintenance
        'placement_cancelled'    -- a 9-box position cancelled by maintenance
    ]));

-- 2) Why an employee record is inactive ---------------------------------------
ALTER TABLE employees ADD COLUMN IF NOT EXISTS cancelled_at  timestamptz;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS cancelled_by  bigint REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS cancel_reason text;

COMMENT ON COLUMN employees.cancelled_at IS
    'Set when a SuperAdmin voids the record as created-in-error. NULL for a normal leaver: is_active=false means "gone", cancelled_at means "never should have existed".';
COMMENT ON COLUMN employees.cancel_reason IS
    'Mandatory justification captured at void time; preserved on restore so the round trip stays auditable.';

-- A voided record must carry its reason and its author — all three together or
-- none. This is what stops a later UPDATE from half-voiding a row.
ALTER TABLE employees DROP CONSTRAINT IF EXISTS chk_employee_cancel_complete;
ALTER TABLE employees ADD CONSTRAINT chk_employee_cancel_complete
    CHECK (
        (cancelled_at IS NULL AND cancel_reason IS NULL)
        OR (cancelled_at IS NOT NULL AND length(btrim(cancel_reason)) > 0)
    );

-- Voided records are a small minority and are always queried as "show me the
-- voided ones", so a partial index is the right shape.
CREATE INDEX IF NOT EXISTS idx_employees_cancelled
    ON employees (cancelled_at DESC) WHERE cancelled_at IS NOT NULL;
