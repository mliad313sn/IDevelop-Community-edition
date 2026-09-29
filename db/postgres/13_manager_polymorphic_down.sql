-- Rollback for 13_manager_polymorphic.sql. Idempotent.
BEGIN;
-- admin-typed managers cannot satisfy an employee FK → clear them first.
UPDATE employees SET manager_id = NULL WHERE manager_type = 'admin';
ALTER TABLE employees DROP CONSTRAINT IF EXISTS chk_employees_manager_pair;
ALTER TABLE employees DROP CONSTRAINT IF EXISTS chk_employees_manager_type;
ALTER TABLE employees DROP COLUMN IF EXISTS manager_type;
-- restore the employee-only foreign key
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_employees_manager') THEN
    ALTER TABLE employees ADD CONSTRAINT fk_employees_manager
      FOREIGN KEY (manager_id) REFERENCES employees(id) ON DELETE SET NULL;
  END IF;
END $$;
DELETE FROM schema_meta WHERE key='13_manager_polymorphic';
COMMIT;
