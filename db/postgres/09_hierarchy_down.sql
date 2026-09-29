-- =====================================================================
-- 09_hierarchy_down.sql  —  Rollback for 09_hierarchy.sql
-- Removes the manager/hierarchy additions. Idempotent. Non-destructive to
-- pre-existing employee data (only drops the columns/constraints we added).
-- =====================================================================
BEGIN;

DROP INDEX IF EXISTS idx_employees_manager_id;

ALTER TABLE employees DROP CONSTRAINT IF EXISTS chk_employees_not_self_manager;
ALTER TABLE employees DROP CONSTRAINT IF EXISTS chk_employees_not_self_supervisor;
ALTER TABLE employees DROP CONSTRAINT IF EXISTS fk_employees_manager;

ALTER TABLE employees DROP COLUMN IF EXISTS manager_id;
ALTER TABLE employees DROP COLUMN IF EXISTS is_org_root;

DELETE FROM schema_meta WHERE key = '09_hierarchy';

COMMIT;
