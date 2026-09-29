-- Rollback for 11_coaching_plans.sql. Idempotent.
BEGIN;
ALTER TABLE coaching_sessions DROP COLUMN IF EXISTS plan_id;
DROP TABLE IF EXISTS coaching_plan_actions;
DROP TABLE IF EXISTS coaching_plans;
DELETE FROM schema_meta WHERE key='11_coaching_plans';
COMMIT;
