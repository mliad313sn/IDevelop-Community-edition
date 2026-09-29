-- ============================================================================
-- IDevelop — Wave 3: OKR / Goals (continuous performance).
-- Objectives + measurable key results (self-referential parent_id). Additive &
-- idempotent. Reuses the existing set_updated_at trigger function.
-- ============================================================================
CREATE TABLE IF NOT EXISTS goals (
    id            BIGSERIAL PRIMARY KEY,
    employee_id   BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    parent_id     BIGINT REFERENCES goals(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL DEFAULT 'objective' CHECK (kind IN ('objective', 'key_result')),
    title         TEXT NOT NULL,
    description   TEXT,
    metric_unit   TEXT,
    target_value  NUMERIC,
    current_value NUMERIC NOT NULL DEFAULT 0,
    status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'at_risk', 'done', 'cancelled')),
    period        TEXT,        -- e.g. '2026-Q3'
    due_date      DATE,
    created_by    BIGINT,      -- admin or employee id (polymorphic; not FK)
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_goals_employee ON goals(employee_id);
CREATE INDEX IF NOT EXISTS idx_goals_parent   ON goals(parent_id);
CREATE INDEX IF NOT EXISTS idx_goals_status   ON goals(status);

-- PG14+ CREATE OR REPLACE TRIGGER → idempotent (target server is PG 17).
CREATE OR REPLACE TRIGGER trg_goals_updated_at
    BEFORE UPDATE ON goals FOR EACH ROW EXECUTE FUNCTION set_updated_at();
