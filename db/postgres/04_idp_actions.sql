-- Phase 4 — IDP, Actions, Effectiveness, Readiness Snapshot.
BEGIN;

CREATE TYPE idp_status        AS ENUM ('draft', 'active', 'completed', 'archived');
CREATE TYPE idp_priority      AS ENUM ('low', 'medium', 'high', 'critical');
CREATE TYPE idp_objective_state AS ENUM ('pending', 'in_progress', 'completed', 'cancelled');
CREATE TYPE idp_action_type   AS ENUM (
    'training', 'coaching', 'mentoring', 'on_the_job',
    'self_study', 'certification', 'stretch'
);
CREATE TYPE idp_signoff_role  AS ENUM ('employee', 'supervisor');

CREATE TABLE idp_plans (
    id           BIGSERIAL PRIMARY KEY,
    employee_id  BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    cycle_id     BIGINT REFERENCES assessment_cycles(id) ON DELETE SET NULL,
    status       idp_status NOT NULL DEFAULT 'draft',
    priority     idp_priority NOT NULL DEFAULT 'medium',
    starts_on    DATE,
    ends_on      DATE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_idp_plans_employee ON idp_plans (employee_id);
CREATE INDEX idx_idp_plans_status   ON idp_plans (status);
CREATE TRIGGER trg_idp_plans_updated_at BEFORE UPDATE ON idp_plans FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE idp_objectives (
    id             BIGSERIAL PRIMARY KEY,
    idp_id         BIGINT NOT NULL REFERENCES idp_plans(id) ON DELETE CASCADE,
    skill_id       BIGINT REFERENCES skills(id) ON DELETE SET NULL,
    smart_text     TEXT NOT NULL,
    due_on         DATE,
    priority       idp_priority NOT NULL DEFAULT 'medium',
    state          idp_objective_state NOT NULL DEFAULT 'pending',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_idp_objectives_idp ON idp_objectives (idp_id);
CREATE TRIGGER trg_idp_objectives_updated_at BEFORE UPDATE ON idp_objectives FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE idp_actions (
    id              BIGSERIAL PRIMARY KEY,
    idp_id          BIGINT NOT NULL REFERENCES idp_plans(id) ON DELETE CASCADE,
    objective_id    BIGINT REFERENCES idp_objectives(id) ON DELETE SET NULL,
    type            idp_action_type NOT NULL,
    title           TEXT NOT NULL,
    description     TEXT,
    status          idp_objective_state NOT NULL DEFAULT 'pending',
    estimated_hours INTEGER,
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    completion_notes TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_idp_actions_idp ON idp_actions (idp_id);
CREATE TRIGGER trg_idp_actions_updated_at BEFORE UPDATE ON idp_actions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- gating: every action MUST link to ≥ 1 skill gap (enforced via FK; UI must
-- prevent saving an action without at least one row in action_skill_links).
CREATE TABLE action_skill_links (
    action_id   BIGINT NOT NULL REFERENCES idp_actions(id) ON DELETE CASCADE,
    skill_id    BIGINT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    PRIMARY KEY (action_id, skill_id)
);

CREATE TABLE action_evidence (
    id          BIGSERIAL PRIMARY KEY,
    action_id   BIGINT NOT NULL REFERENCES idp_actions(id) ON DELETE CASCADE,
    file_uri    TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime        TEXT NOT NULL,
    size_bytes  BIGINT NOT NULL,
    av_status   av_status NOT NULL DEFAULT 'pending',
    av_signature TEXT,
    scanned_at  TIMESTAMPTZ,
    quarantine_uri TEXT,
    uploaded_by BIGINT NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_action_evidence_action ON action_evidence (action_id);

CREATE TABLE action_effectiveness (
    action_id    BIGINT PRIMARY KEY REFERENCES idp_actions(id) ON DELETE CASCADE,
    rating_pre   SMALLINT NOT NULL CHECK (rating_pre BETWEEN 0 AND 4),
    rating_post  SMALLINT NOT NULL CHECK (rating_post BETWEEN 0 AND 4),
    uplift       SMALLINT NOT NULL,
    computed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE idp_signoffs (
    id          BIGSERIAL PRIMARY KEY,
    idp_id      BIGINT NOT NULL REFERENCES idp_plans(id) ON DELETE CASCADE,
    role        idp_signoff_role NOT NULL,
    user_id     BIGINT NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
    ip          INET NOT NULL,
    ua          TEXT,
    signed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (idp_id, role)
);

-- Readiness snapshot — written on cycle-close + on demand.
CREATE TABLE readiness_snapshots (
    id             BIGSERIAL PRIMARY KEY,
    employee_id    BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    cycle_id       BIGINT REFERENCES assessment_cycles(id) ON DELETE SET NULL,
    pct            NUMERIC(5,2) NOT NULL,
    is_ready       BOOLEAN NOT NULL,
    critical_met   INTEGER NOT NULL,
    critical_total INTEGER NOT NULL,
    computed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_readiness_snapshots_employee ON readiness_snapshots (employee_id);
CREATE INDEX idx_readiness_snapshots_cycle    ON readiness_snapshots (cycle_id);

INSERT INTO schema_meta(key, value) VALUES ('04_idp_actions', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();

COMMIT;
