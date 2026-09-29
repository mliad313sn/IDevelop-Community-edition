-- Reverse 16_coaching_session_context.sql
BEGIN;
ALTER TABLE coaching_sessions DROP CONSTRAINT IF EXISTS chk_coaching_sessions_context;
DROP INDEX IF EXISTS idx_coaching_sessions_idp;
DROP INDEX IF EXISTS idx_coaching_sessions_pip;
DROP INDEX IF EXISTS idx_coaching_sessions_skill;
ALTER TABLE coaching_sessions DROP COLUMN IF EXISTS context_type;
ALTER TABLE coaching_sessions DROP COLUMN IF EXISTS idp_id;
ALTER TABLE coaching_sessions DROP COLUMN IF EXISTS pip_id;
ALTER TABLE coaching_sessions DROP COLUMN IF EXISTS skill_id;
DELETE FROM schema_meta WHERE key = '16_coaching_session_context';
COMMIT;
