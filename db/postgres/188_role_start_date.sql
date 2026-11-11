-- 188 — The date a person started in their current role (K14 « Time to reach
-- the role »).
--
-- employees.role_start_date = the effective date of the person's CURRENT role
-- assignment. It is captured GOING FORWARD only:
--   * a role CHANGE on an existing person (the employee form, a move, an
--     import update, the HRIS sync, any path that updates employees.role_id)
--     stamps CURRENT_DATE through the trigger below, unless the same
--     statement sets the date itself;
--   * a JOINER stamps it when the joiner event is processed
--     (LifecycleService.onJoiner): a new person's first role.
-- No back-fill and no guess: people already in post keep NULL, and K14 only
-- counts people whose start date was captured. A plain INSERT (an initial load
-- or an import of people already in post) never stamps a date: an import date
-- is not a start date. Clearing a role leaves the previous date untouched (no
-- role, no requirement: the date is simply not read).
--
-- employees is granted column by column to the SQL console reader, so the
-- migration ends with the re-grant.
--
-- Additive and idempotent: safe to re-run. Nothing is deleted or rewritten.

ALTER TABLE public.employees ADD COLUMN IF NOT EXISTS role_start_date date;

COMMENT ON COLUMN public.employees.role_start_date IS
    'Effective date of the current role assignment (migration 188, K14). Captured going forward on a role change or a joiner; never back-filled.';

CREATE OR REPLACE FUNCTION public.fn_employee_role_start_date()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
    IF NEW.role_id IS NOT NULL
       AND NEW.role_id IS DISTINCT FROM OLD.role_id
       AND NEW.role_start_date IS NOT DISTINCT FROM OLD.role_start_date THEN
        NEW.role_start_date := CURRENT_DATE;
    END IF;
    RETURN NEW;
END;
$fn$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgname = 'trg_employee_role_start_date'
           AND tgrelid = 'public.employees'::regclass
    ) THEN
        CREATE TRIGGER trg_employee_role_start_date
            BEFORE UPDATE OF role_id ON public.employees
            FOR EACH ROW EXECUTE FUNCTION public.fn_employee_role_start_date();
    END IF;
END $$;

SELECT public.fn_console_reader_sync();
