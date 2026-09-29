-- =====================================================================
-- 09_hierarchy.sql  —  Explicit supervisor + manager hierarchy foundation
-- Project: IDevelop, Sub-phase 1B
-- Safe / additive / non-breaking. Idempotent.
--
-- Adds an explicit two-level reporting model (supervisor + manager) on top
-- of the existing supervisor_id self-FK, plus integrity guards and an index.
--
-- IMPORTANT: the "every non-root employee must have a supervisor AND a
-- manager" completeness rule is intentionally NOT enforced here. The live
-- data currently has NO hierarchy populated (all supervisor_id are NULL), so
-- adding a hard CHECK/NOT NULL now would break existing employee editing
-- (regression). Completeness will be activated by a later migration
-- (10_hierarchy_enforce.sql) AFTER the org hierarchy is populated.
-- =====================================================================
BEGIN;

-- 1. Columns -----------------------------------------------------------
ALTER TABLE employees ADD COLUMN IF NOT EXISTS manager_id  BIGINT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS is_org_root BOOLEAN NOT NULL DEFAULT false;

-- 2. Foreign key: manager_id -> employees(id) -------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_employees_manager') THEN
    ALTER TABLE employees
      ADD CONSTRAINT fk_employees_manager
      FOREIGN KEY (manager_id) REFERENCES employees(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 3. Integrity guards (safe: no current row violates these) -----------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_employees_not_self_manager') THEN
    ALTER TABLE employees
      ADD CONSTRAINT chk_employees_not_self_manager
      CHECK (manager_id IS NULL OR manager_id <> id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_employees_not_self_supervisor') THEN
    ALTER TABLE employees
      ADD CONSTRAINT chk_employees_not_self_supervisor
      CHECK (supervisor_id IS NULL OR supervisor_id <> id);
  END IF;
END $$;

-- 4. Index -------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_employees_manager_id ON employees(manager_id);

-- 5. Record migration --------------------------------------------------
INSERT INTO schema_meta (key, value, applied_at)
VALUES ('09_hierarchy', 'applied', now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = EXCLUDED.applied_at;

COMMIT;
