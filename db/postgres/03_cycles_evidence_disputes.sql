-- Phase 3 — Cycles, evidence (ClamAV), L0/L1 disputes, partial lock, signatures, delegations.
BEGIN;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

CREATE TYPE cycle_status   AS ENUM ('draft', 'open', 'locked', 'closed');
CREATE TYPE av_status      AS ENUM ('pending', 'clean', 'infected', 'quarantined', 'scan_error');
CREATE TYPE locked_state   AS ENUM ('provisional', 'finalized');
CREATE TYPE dispute_level  AS ENUM ('L0', 'L1');
CREATE TYPE dispute_state  AS ENUM ('open', 'resolved', 'escalated');

-- ---------------------------------------------------------------------------
-- Assessment cycles
-- ---------------------------------------------------------------------------

CREATE TABLE assessment_cycles (
    id          BIGSERIAL PRIMARY KEY,
    code        TEXT NOT NULL UNIQUE,
    label       TEXT NOT NULL,
    opened_at   TIMESTAMPTZ NOT NULL,
    closes_at   TIMESTAMPTZ NOT NULL,
    status      cycle_status NOT NULL DEFAULT 'draft',
    created_by  BIGINT NOT NULL REFERENCES admins(id) ON DELETE RESTRICT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_assessment_cycles_updated_at BEFORE UPDATE ON assessment_cycles
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE self_assessments ADD COLUMN cycle_id BIGINT REFERENCES assessment_cycles(id) ON DELETE RESTRICT;
ALTER TABLE self_assessments ADD COLUMN justification TEXT;
ALTER TABLE self_assessments ADD COLUMN locked_state locked_state NOT NULL DEFAULT 'provisional';
CREATE INDEX idx_self_assessments_cycle ON self_assessments (cycle_id);

ALTER TABLE supervisor_reviews ADD COLUMN priority_index NUMERIC(10,4) DEFAULT 0;
CREATE INDEX idx_supervisor_reviews_priority ON supervisor_reviews (priority_index DESC);

-- ---------------------------------------------------------------------------
-- Evidence
-- ---------------------------------------------------------------------------

CREATE TABLE assessment_evidence (
    id                  BIGSERIAL PRIMARY KEY,
    self_assessment_id  BIGINT NOT NULL REFERENCES self_assessments(id) ON DELETE CASCADE,
    file_uri            TEXT NOT NULL,         -- relative path under uploads/, or s3:// URL
    original_name       TEXT NOT NULL,
    mime                TEXT NOT NULL,
    size_bytes          BIGINT NOT NULL,
    av_status           av_status NOT NULL DEFAULT 'pending',
    av_signature        TEXT,                  -- e.g. EICAR-Test-File
    scanned_at          TIMESTAMPTZ,
    quarantine_uri      TEXT,
    submit_locked_at    TIMESTAMPTZ,           -- set when infected → blocks submit
    uploaded_by         BIGINT NOT NULL,       -- employees.id
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_evidence_self_assessment ON assessment_evidence (self_assessment_id);
CREATE INDEX idx_evidence_av_status       ON assessment_evidence (av_status);

-- Per-skill max 3 enforced in app code (CHECK requires a window/aggregate).

-- ---------------------------------------------------------------------------
-- Disputes
-- ---------------------------------------------------------------------------

CREATE TABLE assessment_disputes (
    id                    BIGSERIAL PRIMARY KEY,
    supervisor_review_id  BIGINT NOT NULL REFERENCES supervisor_reviews(id) ON DELETE CASCADE,
    employee_id           BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    level                 dispute_level NOT NULL DEFAULT 'L0',
    state                 dispute_state NOT NULL DEFAULT 'open',
    opened_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    escalated_at          TIMESTAMPTZ,
    resolved_at           TIMESTAMPTZ,
    final_level           dispute_level,
    decided_by            BIGINT REFERENCES employees(id) ON DELETE RESTRICT,
    decided_rating        SMALLINT CHECK (decided_rating IS NULL OR decided_rating BETWEEN 0 AND 4),
    reason                TEXT NOT NULL
);
CREATE INDEX idx_disputes_state ON assessment_disputes (state);
CREATE INDEX idx_disputes_level ON assessment_disputes (level);
CREATE INDEX idx_disputes_opened_at ON assessment_disputes (opened_at);

-- ---------------------------------------------------------------------------
-- Digital signatures + delegations
-- ---------------------------------------------------------------------------

CREATE TABLE review_signatures (
    id          BIGSERIAL PRIMARY KEY,
    review_id   BIGINT NOT NULL REFERENCES supervisor_reviews(id) ON DELETE CASCADE,
    user_id     BIGINT NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
    ip          INET NOT NULL,
    ua          TEXT,
    signed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_review_signatures_review ON review_signatures (review_id);

CREATE TRIGGER trg_review_signatures_immutable
BEFORE UPDATE OR DELETE ON review_signatures
FOR EACH ROW EXECUTE FUNCTION block_mutation();

CREATE TABLE review_delegations (
    id          BIGSERIAL PRIMARY KEY,
    grantor_id  BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    grantee_id  BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    starts_at   TIMESTAMPTZ NOT NULL,
    ends_at     TIMESTAMPTZ NOT NULL,
    reason      TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (grantor_id <> grantee_id),
    CHECK (ends_at > starts_at)
);
CREATE INDEX idx_review_delegations_grantee ON review_delegations (grantee_id);

INSERT INTO schema_meta(key, value) VALUES ('03_cycles_evidence_disputes', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();

COMMIT;
