-- ============================================================================
-- IDevelop — Wave 3: Check-ins / 1-on-1s + continuous feedback.
-- A lightweight, recurring conversation record between a report (employee_id)
-- and their manager (manager_id), with optional agenda/action items and a
-- pulse sentiment (1..5). Additive & idempotent. Reuses set_updated_at.
-- ============================================================================
CREATE TABLE IF NOT EXISTS check_ins (
    id            BIGSERIAL PRIMARY KEY,
    employee_id   BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,  -- the report (subject)
    manager_id    BIGINT REFERENCES employees(id) ON DELETE SET NULL,          -- the other party
    kind          TEXT NOT NULL DEFAULT 'one_on_one' CHECK (kind IN ('one_on_one', 'feedback', 'pulse')),
    title         TEXT,
    scheduled_at  TIMESTAMPTZ,
    occurred_at   TIMESTAMPTZ,
    status        TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled')),
    shared_notes  TEXT,                                  -- visible to both parties
    sentiment     SMALLINT CHECK (sentiment BETWEEN 1 AND 5),  -- pulse / mood, optional
    created_by    BIGINT,                                -- admin or employee id (polymorphic; not FK)
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_check_ins_employee  ON check_ins(employee_id);
CREATE INDEX IF NOT EXISTS idx_check_ins_status    ON check_ins(status);
CREATE INDEX IF NOT EXISTS idx_check_ins_scheduled ON check_ins(scheduled_at);

-- Agenda / talking points / action items for a check-in.
CREATE TABLE IF NOT EXISTS check_in_items (
    id           BIGSERIAL PRIMARY KEY,
    check_in_id  BIGINT NOT NULL REFERENCES check_ins(id) ON DELETE CASCADE,
    body         TEXT NOT NULL,
    is_action    BOOLEAN NOT NULL DEFAULT false,         -- talking point vs. action item
    done         BOOLEAN NOT NULL DEFAULT false,
    position     INTEGER NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_check_in_items_parent ON check_in_items(check_in_id);

-- PG14+ CREATE OR REPLACE TRIGGER → idempotent (target server is PG 17).
CREATE OR REPLACE TRIGGER trg_check_ins_updated_at
    BEFORE UPDATE ON check_ins FOR EACH ROW EXECUTE FUNCTION set_updated_at();
