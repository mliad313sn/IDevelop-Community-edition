-- =====================================================================
-- 11_coaching_plans.sql — Phase 3: Coaching & Mentoring PLAN layer
-- Adds a plan-centric workflow on top of the existing session-centric
-- coaching_* tables. Additive & fully reversible. Idempotent.
--
-- Workflow: supervisor creates plan -> employee executes/updates progress
--           -> supervisor validates completion -> manager monitors.
-- =====================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS coaching_plans (
  id               BIGSERIAL PRIMARY KEY,
  employee_id      BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  created_by       BIGINT,                                  -- supervisor/admin who created it
  mentor_id        BIGINT REFERENCES employees(id) ON DELETE SET NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('coaching','mentoring')),
  title            TEXT NOT NULL,
  objective        TEXT,
  expected_outcome TEXT,
  target_date      DATE,
  state            TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','active','completed','cancelled')),
  progress         SMALLINT NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  validated_by     BIGINT,
  validated_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_coaching_plans_emp   ON coaching_plans(employee_id);
CREATE INDEX IF NOT EXISTS idx_coaching_plans_state ON coaching_plans(state);
CREATE INDEX IF NOT EXISTS idx_coaching_plans_due   ON coaching_plans(target_date);

CREATE TABLE IF NOT EXISTS coaching_plan_actions (
  id              BIGSERIAL PRIMARY KEY,
  plan_id         BIGINT NOT NULL REFERENCES coaching_plans(id) ON DELETE CASCADE,
  description     TEXT NOT NULL,
  due_on          DATE,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','done')),
  progress_note   TEXT,
  acknowledged_at TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_coaching_plan_actions_plan ON coaching_plan_actions(plan_id);

-- session notes against a plan (reuse coaching_sessions by linking)
ALTER TABLE coaching_sessions ADD COLUMN IF NOT EXISTS plan_id BIGINT REFERENCES coaching_plans(id) ON DELETE SET NULL;

INSERT INTO schema_meta (key, value, applied_at)
VALUES ('11_coaching_plans','applied', now())
ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, applied_at=EXCLUDED.applied_at;

COMMIT;
