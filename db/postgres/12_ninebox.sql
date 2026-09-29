-- =====================================================================
-- 12_ninebox.sql — Phase 4: 9-Box Talent Management (NEW module)
-- Manager-driven, MANUAL placement (Performance x Potential, Low/Med/High),
-- mirroring nine-box-tool-enhanced.html. NO auto-generation from skills/
-- readiness — fully independent of the Skill-Matrix module (separation of
-- concerns). Status lifecycle + approval-history + clearance + audit.
-- Additive & reversible. Idempotent.
-- =====================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS nine_box_evaluations (
  id               BIGSERIAL PRIMARY KEY,
  employee_id      BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  cycle_id         BIGINT,
  performance      TEXT NOT NULL CHECK (performance IN ('low','medium','high')),
  potential        TEXT NOT NULL CHECK (potential   IN ('low','medium','high')),
  box              SMALLINT NOT NULL CHECK (box BETWEEN 1 AND 9),
  box_label        TEXT,
  comments         TEXT,
  evidence         TEXT,
  calibration_notes TEXT,
  status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','under_review','approved','rejected','archived')),
  clearance        TEXT NOT NULL DEFAULT 'confidential' CHECK (clearance IN ('internal','confidential','restricted')),
  created_by       BIGINT,
  submitted_by     BIGINT,
  approved_by      BIGINT,
  approved_at      TIMESTAMPTZ,
  rejected_by      BIGINT,
  rejected_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ninebox_emp    ON nine_box_evaluations(employee_id);
CREATE INDEX IF NOT EXISTS idx_ninebox_status ON nine_box_evaluations(status);
CREATE INDEX IF NOT EXISTS idx_ninebox_box    ON nine_box_evaluations(box);

-- Audit log incl. views/exports (confidentiality requirement)
CREATE TABLE IF NOT EXISTS nine_box_events (
  id            BIGSERIAL PRIMARY KEY,
  evaluation_id BIGINT REFERENCES nine_box_evaluations(id) ON DELETE CASCADE,
  employee_id   BIGINT,
  actor_id      BIGINT,
  actor_type    TEXT,
  action        TEXT NOT NULL,     -- create|update|submit|approve|reject|archive|view|export|delete
  from_status   TEXT,
  to_status     TEXT,
  detail        JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ninebox_events_eval ON nine_box_events(evaluation_id);

INSERT INTO schema_meta (key, value, applied_at)
VALUES ('12_ninebox','applied', now())
ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, applied_at=EXCLUDED.applied_at;

COMMIT;
