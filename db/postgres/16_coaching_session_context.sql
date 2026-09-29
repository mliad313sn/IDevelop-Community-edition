-- =====================================================================
-- 16_coaching_session_context.sql — coaching SESSIONS in context too.
-- Mirrors 15_coaching_context.sql but for the session-based coaching
-- (coaching_sessions, used by /v2/coaching). A session linked to a plan
-- (plan_id) inherits the plan's context, so context_* stays NULL there;
-- a stand-alone session must set a context at the application layer.
-- Additive, idempotent, reversible.
-- =====================================================================
BEGIN;

ALTER TABLE coaching_sessions ADD COLUMN IF NOT EXISTS context_type TEXT;
ALTER TABLE coaching_sessions ADD COLUMN IF NOT EXISTS idp_id   BIGINT REFERENCES idp_plans(id) ON DELETE SET NULL;
ALTER TABLE coaching_sessions ADD COLUMN IF NOT EXISTS pip_id   BIGINT REFERENCES pips(id)      ON DELETE SET NULL;
ALTER TABLE coaching_sessions ADD COLUMN IF NOT EXISTS skill_id BIGINT REFERENCES skills(id)    ON DELETE SET NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_coaching_sessions_context') THEN
    ALTER TABLE coaching_sessions ADD CONSTRAINT chk_coaching_sessions_context CHECK (
      context_type IS NULL OR (
        context_type IN ('idp', 'pip', 'skill_gap')
        AND (context_type <> 'idp'       OR idp_id   IS NOT NULL)
        AND (context_type <> 'pip'       OR pip_id   IS NOT NULL)
        AND (context_type <> 'skill_gap' OR skill_id IS NOT NULL)
      )
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_coaching_sessions_idp   ON coaching_sessions(idp_id);
CREATE INDEX IF NOT EXISTS idx_coaching_sessions_pip   ON coaching_sessions(pip_id);
CREATE INDEX IF NOT EXISTS idx_coaching_sessions_skill ON coaching_sessions(skill_id);

INSERT INTO schema_meta (key, value, applied_at)
VALUES ('16_coaching_session_context', 'applied', now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = EXCLUDED.applied_at;

COMMIT;
