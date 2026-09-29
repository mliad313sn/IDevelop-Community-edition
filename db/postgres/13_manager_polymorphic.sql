-- =====================================================================
-- 13_manager_polymorphic.sql
-- Allow an employee's MANAGER to be either another employee OR an admin
-- account. Adds manager_type and relaxes the employee-only FK on manager_id.
-- Additive & reversible. Idempotent.
-- =====================================================================
BEGIN;

-- 1. column
ALTER TABLE employees ADD COLUMN IF NOT EXISTS manager_type TEXT;

-- 2. drop the employee-only FK so manager_id may reference admins too
ALTER TABLE employees DROP CONSTRAINT IF EXISTS fk_employees_manager;

-- 3. backfill existing (employee) managers BEFORE adding the pairing check
UPDATE employees SET manager_type = 'employee'
  WHERE manager_id IS NOT NULL AND manager_type IS NULL;

-- 4. constraints (data now satisfies them)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_employees_manager_type') THEN
    ALTER TABLE employees ADD CONSTRAINT chk_employees_manager_type
      CHECK (manager_type IS NULL OR manager_type IN ('employee','admin'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_employees_manager_pair') THEN
    ALTER TABLE employees ADD CONSTRAINT chk_employees_manager_pair
      CHECK (manager_id IS NULL OR manager_type IS NOT NULL);
  END IF;
END $$;

INSERT INTO schema_meta (key, value, applied_at)
VALUES ('13_manager_polymorphic','applied', now())
ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, applied_at=EXCLUDED.applied_at;

COMMIT;
