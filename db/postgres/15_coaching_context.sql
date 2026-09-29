-- =====================================================================
-- 15_coaching_context.sql — Coaching/Mentoring must be done IN CONTEXT.
-- Links a coaching_plan to exactly one of: an IDP, a PIP, or a skill gap
-- (the skill the plan is meant to close). Additive, idempotent, reversible.
--
-- Existing rows keep context_type = NULL (legacy, allowed). New plans are
-- required to set a context by the application layer (CoachingPlanService).
-- =====================================================================
BEGIN;

ALTER TABLE coaching_plans ADD COLUMN IF NOT EXISTS context_type TEXT;
ALTER TABLE coaching_plans ADD COLUMN IF NOT EXISTS idp_id   BIGINT REFERENCES idp_plans(id) ON DELETE SET NULL;
ALTER TABLE coaching_plans ADD COLUMN IF NOT EXISTS pip_id   BIGINT REFERENCES pips(id)      ON DELETE SET NULL;
ALTER TABLE coaching_plans ADD COLUMN IF NOT EXISTS skill_id BIGINT REFERENCES skills(id)    ON DELETE SET NULL;

-- value + linkage integrity. Legacy NULL rows pass the first branch.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_coaching_plans_context') THEN
    ALTER TABLE coaching_plans ADD CONSTRAINT chk_coaching_plans_context CHECK (
      context_type IS NULL OR (
        context_type IN ('idp', 'pip', 'skill_gap')
        AND (context_type <> 'idp'       OR idp_id   IS NOT NULL)
        AND (context_type <> 'pip'       OR pip_id   IS NOT NULL)
        AND (context_type <> 'skill_gap' OR skill_id IS NOT NULL)
      )
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_coaching_plans_idp   ON coaching_plans(idp_id);
CREATE INDEX IF NOT EXISTS idx_coaching_plans_pip   ON coaching_plans(pip_id);
CREATE INDEX IF NOT EXISTS idx_coaching_plans_skill ON coaching_plans(skill_id);

INSERT INTO schema_meta (key, value, applied_at)
VALUES ('15_coaching_context', 'applied', now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = EXCLUDED.applied_at;

COMMIT;
