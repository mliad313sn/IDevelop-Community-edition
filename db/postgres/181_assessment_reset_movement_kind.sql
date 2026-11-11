-- 181 — A SuperAdmin reset of a self-assessment has its own movement kind.
--
-- MaintenanceService.resetAssessment sends one assessment, or a whole
-- employee × campaign, back to draft so it can be redone. Its row in the
-- person's history must not read "self-assessment cancelled": nothing was
-- cancelled. employee_movements.kind gains 'assessment_reset'.
--
-- The CHECK is recreated with every value it accepted before (migrations 99,
-- 100 and 109) plus the new one. Existing rows are untouched and all satisfy
-- the wider list, so the validation cannot fail. Idempotent: the constraint is
-- only recreated while it does not yet accept 'assessment_reset'. Nothing is
-- deleted, and no table or column is added (no console re-grant needed).

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.employee_movements'::regclass
           AND conname = 'employee_movements_kind_check'
           AND pg_get_constraintdef(oid) LIKE '%assessment_reset%'
    ) THEN
        ALTER TABLE public.employee_movements DROP CONSTRAINT IF EXISTS employee_movements_kind_check;
        ALTER TABLE public.employee_movements ADD CONSTRAINT employee_movements_kind_check
            CHECK (kind IN (
                'site', 'department', 'service', 'role', 'manager', 'supervisor', 'status',
                'plan_cancelled',        -- an IDP or PIP cancelled by maintenance (99)
                'placement_cancelled',   -- a 9-box position cancelled by maintenance (99)
                'assessment_cancelled',  -- a self-assessment cancelled, reopened or review withdrawn (100)
                'account',               -- credentials, lockout, policy (109)
                'assessment_reset'       -- a self-assessment sent back to be redone (181)
            ));
    END IF;
END $$;
