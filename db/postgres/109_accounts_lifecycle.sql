-- 109_accounts_lifecycle.sql (accounts console & lifecycle), 2026-09-10.
--
-- 1) lifecycle_events carries WHY and WHEN a departure happens (,
--    ): a reason, an effective date executed by the hourly tick when it
--    is in the future, and — for a manager, who may only REQUEST a departure —
--    who asked and which admin decided. A request is a row with requested_by
--    set and decided_at NULL; nothing is executed until an admin holding
--    edit_employees approves it. processed_at keeps its meaning (the cascade
--    ran), so every existing reader (reinstate / revert / the JML page) sees
--    requested and scheduled rows as "not yet processed", which is the truth.
-- 2) employee_movements accepts kind 'account': credentials issued,
--    login disabled / re-enabled, lockout cleared, policy set — the account
--    trail a site admin can read on /movements, which /system-logs refuses them.
-- 3) account_requests: a manager's one-click "unlock / resend" ask,
--    answered by an admin holding reset_employee_password from the console.
--
-- Idempotent: IF NOT EXISTS / DROP IF EXISTS everywhere, schema_meta stamp last.

BEGIN;

ALTER TABLE public.lifecycle_events ADD COLUMN IF NOT EXISTS reason        text;
ALTER TABLE public.lifecycle_events ADD COLUMN IF NOT EXISTS effective_at  timestamptz;
ALTER TABLE public.lifecycle_events ADD COLUMN IF NOT EXISTS requested_by  text;      -- 'employee:136' (a manager) / 'admin:5'
ALTER TABLE public.lifecycle_events ADD COLUMN IF NOT EXISTS decided_by    bigint REFERENCES public.admins(id) ON DELETE SET NULL;
ALTER TABLE public.lifecycle_events ADD COLUMN IF NOT EXISTS decided_at    timestamptz;
ALTER TABLE public.lifecycle_events ADD COLUMN IF NOT EXISTS decision      text;
ALTER TABLE public.lifecycle_events DROP CONSTRAINT IF EXISTS lifecycle_events_decision_check;
ALTER TABLE public.lifecycle_events ADD CONSTRAINT lifecycle_events_decision_check
    CHECK (decision IS NULL OR decision IN ('approved', 'declined'));

-- Due-leaver scan (hourly): scheduled departures not yet executed.
CREATE INDEX IF NOT EXISTS idx_lifecycle_due
    ON public.lifecycle_events (effective_at)
    WHERE processed_at IS NULL AND reverted_at IS NULL;

COMMENT ON COLUMN public.lifecycle_events.reason       IS 'Mandatory for a leaver: why the person leaves / moves.';
COMMENT ON COLUMN public.lifecycle_events.effective_at IS 'When the event takes effect; NULL = immediately. A future leaver is executed by the hourly tick.';
COMMENT ON COLUMN public.lifecycle_events.requested_by IS 'actor ref of a REQUEST (a manager may only request a departure); decided_by/decided_at/decision record the admin decision.';

-- Account stream in the movement feed.
ALTER TABLE public.employee_movements DROP CONSTRAINT IF EXISTS employee_movements_kind_check;
ALTER TABLE public.employee_movements ADD CONSTRAINT employee_movements_kind_check
    CHECK (kind IN ('site', 'department', 'service', 'role', 'manager', 'supervisor', 'status',
                    'plan_cancelled', 'placement_cancelled', 'assessment_cancelled', 'account'));

-- Manager → admin account requests (unlock / resend credentials).
CREATE TABLE IF NOT EXISTS public.account_requests (
    id            bigserial PRIMARY KEY,
    employee_id   bigint NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
    kind          text   NOT NULL CHECK (kind IN ('unlock', 'resend')),
    requested_by  bigint NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
    note          text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    decided_by    bigint REFERENCES public.admins(id) ON DELETE SET NULL,
    decided_at    timestamptz,
    decision      text CHECK (decision IS NULL OR decision IN ('done', 'declined'))
);
CREATE INDEX IF NOT EXISTS idx_account_requests_open
    ON public.account_requests (employee_id) WHERE decided_at IS NULL;

INSERT INTO schema_meta(key, value) VALUES ('109_accounts_lifecycle', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();

COMMIT;
