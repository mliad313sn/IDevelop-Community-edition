-- 68_capability_actor_employee.sql
-- Audit attribution for capability writes made by MANAGERS. A manager is an
-- employee row, not an admin, so these routes used to fall back to the built-in
-- superadmin's id for *_admin_id — disputes then pointed at the wrong person and
-- the "an applicant applied" notification went to the superadmin instead of the
-- manager who posted. Add a nullable actor_employee_id alongside the *_admin_id
-- columns so a manager's action records the real actor; admins keep using the
-- admin id. Idempotent.

ALTER TABLE public.opportunities            ADD COLUMN IF NOT EXISTS actor_employee_id bigint REFERENCES public.employees(id) ON DELETE SET NULL;
ALTER TABLE public.opportunity_applications ADD COLUMN IF NOT EXISTS actor_employee_id bigint REFERENCES public.employees(id) ON DELETE SET NULL;
ALTER TABLE public.calibration_sessions     ADD COLUMN IF NOT EXISTS actor_employee_id bigint REFERENCES public.employees(id) ON DELETE SET NULL;
ALTER TABLE public.calibration_adjustments  ADD COLUMN IF NOT EXISTS actor_employee_id bigint REFERENCES public.employees(id) ON DELETE SET NULL;
ALTER TABLE public.surveys                  ADD COLUMN IF NOT EXISTS actor_employee_id bigint REFERENCES public.employees(id) ON DELETE SET NULL;
ALTER TABLE public.org_objectives           ADD COLUMN IF NOT EXISTS actor_employee_id bigint REFERENCES public.employees(id) ON DELETE SET NULL;
