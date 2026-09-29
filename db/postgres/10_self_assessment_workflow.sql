-- =====================================================================
-- 10_self_assessment_workflow.sql
-- Project: IDevelop, Phase 2 — Self-Assessment workflow
-- EXTENDS the existing self_assessments / supervisor_reviews tables.
-- Fully additive & reversible (NO enum mutation — PG enum ADD VALUE is
-- irreversible, which would break the paired rollback). New lifecycle is
-- modelled with a text `workflow_state` + CHECK, plus comments & audit tables.
-- Idempotent.
-- =====================================================================
BEGIN;

-- 1. Lifecycle state on the self-assessment ---------------------------
--    draft -> submitted -> under_review -> {changes_requested -> submitted}*
--          -> reviewed -> {arbitration} -> approved | rejected
ALTER TABLE self_assessments
  ADD COLUMN IF NOT EXISTS workflow_state TEXT NOT NULL DEFAULT 'draft';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_sa_workflow_state') THEN
    ALTER TABLE self_assessments ADD CONSTRAINT chk_sa_workflow_state
      CHECK (workflow_state IN ('draft','submitted','under_review','changes_requested','reviewed','arbitration','approved','rejected'));
  END IF;
END $$;
-- final approval attribution
ALTER TABLE self_assessments ADD COLUMN IF NOT EXISTS approved_by BIGINT REFERENCES employees(id) ON DELETE SET NULL;
ALTER TABLE self_assessments ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

-- 2. Supervisor decision detail ---------------------------------------
ALTER TABLE supervisor_reviews ADD COLUMN IF NOT EXISTS decision TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_sr_decision') THEN
    ALTER TABLE supervisor_reviews ADD CONSTRAINT chk_sr_decision
      CHECK (decision IS NULL OR decision IN ('approve','reject','request_changes'));
  END IF;
END $$;
ALTER TABLE supervisor_reviews ADD COLUMN IF NOT EXISTS recommendation TEXT;
ALTER TABLE supervisor_reviews ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ;

-- 3. Threaded comments (employee <-> supervisor <-> manager) ----------
CREATE TABLE IF NOT EXISTS self_assessment_comments (
  id                 BIGSERIAL PRIMARY KEY,
  self_assessment_id BIGINT NOT NULL REFERENCES self_assessments(id) ON DELETE CASCADE,
  author_id          BIGINT,                          -- employees.id or admins.id (see author_type)
  author_type        TEXT NOT NULL CHECK (author_type IN ('employee','supervisor','manager','admin')),
  body               TEXT NOT NULL,
  in_reply_to        BIGINT REFERENCES self_assessment_comments(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sa_comments_sa ON self_assessment_comments(self_assessment_id);

-- 4. Immutable audit/event log for the workflow -----------------------
CREATE TABLE IF NOT EXISTS self_assessment_events (
  id                 BIGSERIAL PRIMARY KEY,
  self_assessment_id BIGINT NOT NULL REFERENCES self_assessments(id) ON DELETE CASCADE,
  actor_id           BIGINT,
  actor_type         TEXT,                            -- employee|supervisor|manager|admin
  action             TEXT NOT NULL,                   -- submit|open_review|request_changes|approve|reject|comment|arbitrate|validate
  from_state         TEXT,
  to_state           TEXT,
  detail             JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sa_events_sa ON self_assessment_events(self_assessment_id);

-- 5. Record migration --------------------------------------------------
INSERT INTO schema_meta (key, value, applied_at)
VALUES ('10_self_assessment_workflow','applied', now())
ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, applied_at=EXCLUDED.applied_at;

COMMIT;
