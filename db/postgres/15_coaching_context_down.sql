-- Reverse 15_coaching_context.sql
BEGIN;
ALTER TABLE coaching_plans DROP CONSTRAINT IF EXISTS chk_coaching_plans_context;
DROP INDEX IF EXISTS idx_coaching_plans_idp;
DROP INDEX IF EXISTS idx_coaching_plans_pip;
DROP INDEX IF EXISTS idx_coaching_plans_skill;
ALTER TABLE coaching_plans DROP COLUMN IF EXISTS context_type;
ALTER TABLE coaching_plans DROP COLUMN IF EXISTS idp_id;
ALTER TABLE coaching_plans DROP COLUMN IF EXISTS pip_id;
ALTER TABLE coaching_plans DROP COLUMN IF EXISTS skill_id;
DELETE FROM schema_meta WHERE key = '15_coaching_context';
COMMIT;
