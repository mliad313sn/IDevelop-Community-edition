-- Phase 5 — Talent (9-box folded in), Bias, PIP, Coaching / Mentoring.
BEGIN;

CREATE TYPE perf_pot_level     AS ENUM ('low', 'medium', 'high');
CREATE TYPE reviewer_role      AS ENUM ('manager', 'peer', 'direct_report', 'hr');
CREATE TYPE placement_source   AS ENUM ('auto', 'override');
CREATE TYPE talent_tier        AS ENUM ('up', 'mid', 'low');
CREATE TYPE bias_alert_state   AS ENUM ('open', 'reviewed', 'dismissed');
CREATE TYPE pip_state          AS ENUM ('proposed', 'approved', 'active', 'closed_success', 'closed_failure', 'cancelled');
CREATE TYPE coach_kind         AS ENUM ('coach', 'mentor');
CREATE TYPE coach_signoff_role AS ENUM ('employee', 'manager', 'coach', 'hr');

-- ---------------------------------------------------------------------------
-- 9-Box talent
-- ---------------------------------------------------------------------------

CREATE TABLE talent_ratings (
    id            BIGSERIAL PRIMARY KEY,
    employee_id   BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    reviewer_id   BIGINT NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
    reviewer_role reviewer_role NOT NULL,
    performance   perf_pot_level NOT NULL,
    potential     perf_pot_level NOT NULL,
    cycle_id      BIGINT REFERENCES assessment_cycles(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_talent_ratings_employee ON talent_ratings (employee_id);
CREATE INDEX idx_talent_ratings_cycle    ON talent_ratings (cycle_id);

CREATE TABLE talent_placements (
    employee_id     BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    cycle_id        BIGINT NOT NULL REFERENCES assessment_cycles(id) ON DELETE CASCADE,
    box             TEXT NOT NULL,           -- 'high-high', 'medium-low', etc.
    tier            talent_tier NOT NULL,
    confidence      NUMERIC(4,3),
    source          placement_source NOT NULL,
    override_reason TEXT,
    placed_by       BIGINT REFERENCES admins(id) ON DELETE SET NULL,
    placed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (employee_id, cycle_id)
);

CREATE TABLE bias_alerts (
    id          BIGSERIAL PRIMARY KEY,
    cycle_id    BIGINT NOT NULL REFERENCES assessment_cycles(id) ON DELETE CASCADE,
    group_dim   TEXT NOT NULL,                -- 'site' | 'department' | 'gender' | ...
    group_value TEXT NOT NULL,
    z_score     NUMERIC(5,3) NOT NULL,
    raised_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    state       bias_alert_state NOT NULL DEFAULT 'open',
    notes       TEXT
);
CREATE INDEX idx_bias_alerts_state ON bias_alerts (state);

-- ---------------------------------------------------------------------------
-- PIP (Performance Improvement Plan)
-- ---------------------------------------------------------------------------

CREATE TABLE pips (
    id          BIGSERIAL PRIMARY KEY,
    employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    initiated_by BIGINT NOT NULL REFERENCES admins(id) ON DELETE RESTRICT,
    approved_by BIGINT REFERENCES admins(id) ON DELETE RESTRICT,    -- HR-BP
    state       pip_state NOT NULL DEFAULT 'proposed',
    starts_on   DATE,
    ends_on     DATE,
    summary     TEXT NOT NULL,
    outcome     TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_pips_employee ON pips (employee_id);
CREATE TRIGGER trg_pips_updated_at BEFORE UPDATE ON pips FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE pip_milestones (
    id          BIGSERIAL PRIMARY KEY,
    pip_id      BIGINT NOT NULL REFERENCES pips(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    due_on      DATE NOT NULL,
    met         BOOLEAN,
    notes       TEXT
);

-- ---------------------------------------------------------------------------
-- Coaching / Mentoring
-- ---------------------------------------------------------------------------

CREATE TABLE coaching_sessions (
    id          BIGSERIAL PRIMARY KEY,
    employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    coach_id    BIGINT NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
    kind        coach_kind NOT NULL,
    session_at  TIMESTAMPTZ NOT NULL,
    agenda      TEXT,
    notes_uri   TEXT,           -- optional file ref
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_coaching_sessions_employee ON coaching_sessions (employee_id);

CREATE TABLE coaching_grow (
    session_id  BIGINT PRIMARY KEY REFERENCES coaching_sessions(id) ON DELETE CASCADE,
    goal        TEXT,
    reality     TEXT,
    options     TEXT,
    way_forward TEXT
);

CREATE TABLE coaching_objectives (
    id                BIGSERIAL PRIMARY KEY,
    session_id        BIGINT NOT NULL REFERENCES coaching_sessions(id) ON DELETE CASCADE,
    smart_text        TEXT NOT NULL,
    due_on            DATE,
    state             idp_objective_state NOT NULL DEFAULT 'pending',
    carry_forward_of  BIGINT REFERENCES coaching_objectives(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_coaching_objectives_session ON coaching_objectives (session_id);

CREATE TABLE coaching_signoffs (
    session_id  BIGINT NOT NULL REFERENCES coaching_sessions(id) ON DELETE CASCADE,
    role        coach_signoff_role NOT NULL,
    user_id     BIGINT NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
    ip          INET NOT NULL,
    ua          TEXT,
    signed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, role)
);

INSERT INTO schema_meta(key, value) VALUES ('05_talent_coaching_pip', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();

COMMIT;
