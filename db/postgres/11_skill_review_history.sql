-- 11_skill_review_history.sql
-- Capture (a) how a skill level evolves over time and (b) the movement of an
-- assessment between the employee and its reviewer.
--
-- (a) assessment_history already exists (append-only). We enrich it with the
--     SOURCE/ACTOR/CYCLE of each change and auto-populate it from a trigger on
--     skill_assessments, so EVERY level change is recorded no matter which code
--     path made it (self-assessment approval, supervisor review, action uplift,
--     bulk import, manual edit).
-- (b) self_assessment_events already logs every workflow transition (submit,
--     open_review, request_changes, approve, …) with actor + from/to state. We
--     add self_assessments.current_reviewer_id so the row itself records who the
--     assessment is currently with, and index the event timeline.
--
-- Idempotent: safe to re-run.

-- ---------------------------------------------------------------------------
-- (a) Enrich the skill-evolution history
-- ---------------------------------------------------------------------------
ALTER TABLE assessment_history ADD COLUMN IF NOT EXISTS source             TEXT;
ALTER TABLE assessment_history ADD COLUMN IF NOT EXISTS actor_type         TEXT;
ALTER TABLE assessment_history ADD COLUMN IF NOT EXISTS cycle_id           BIGINT;
ALTER TABLE assessment_history ADD COLUMN IF NOT EXISTS self_assessment_id BIGINT;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assessment_history_cycle_fk') THEN
    ALTER TABLE assessment_history
      ADD CONSTRAINT assessment_history_cycle_fk
      FOREIGN KEY (cycle_id) REFERENCES assessment_cycles(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assessment_history_sa_fk') THEN
    ALTER TABLE assessment_history
      ADD CONSTRAINT assessment_history_sa_fk
      FOREIGN KEY (self_assessment_id) REFERENCES self_assessments(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_assessment_history_emp_skill_time
  ON assessment_history (employee_id, skill_id, assessed_at DESC);

-- Classify a change source/actor from the human notes a writer leaves.
CREATE OR REPLACE FUNCTION fn_classify_assessment_source(p_notes TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_notes ILIKE '%approved self-assessment%' THEN 'self_assessment'
    WHEN p_notes ILIKE '%supervisor review%'        THEN 'supervisor_review'
    WHEN p_notes ILIKE '%action close uplift%' OR p_notes ILIKE 'auto:%' THEN 'action_uplift'
    WHEN p_notes ILIKE '%import%'                   THEN 'import'
    ELSE 'manual'
  END;
$$;

-- Backfill source/actor on existing rows (history is append-only → toggle guard).
ALTER TABLE assessment_history DISABLE TRIGGER trg_assessment_history_immutable;
UPDATE assessment_history
   SET source = fn_classify_assessment_source(notes)
 WHERE source IS NULL;
UPDATE assessment_history
   SET actor_type = CASE source
       WHEN 'self_assessment'   THEN 'employee'
       WHEN 'supervisor_review' THEN 'supervisor'
       WHEN 'action_uplift'     THEN 'system'
       WHEN 'import'            THEN 'system'
       ELSE 'admin' END
 WHERE actor_type IS NULL;
ALTER TABLE assessment_history ENABLE TRIGGER trg_assessment_history_immutable;

-- Auto-capture: log every skill-level change into the timeline.
CREATE OR REPLACE FUNCTION fn_log_skill_assessment_change()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_src   TEXT;
  v_actor TEXT;
  v_cycle BIGINT;
BEGIN
  -- Only record an actual level change (or a brand-new assessment).
  IF TG_OP = 'UPDATE' AND NEW.current_level IS NOT DISTINCT FROM OLD.current_level THEN
    RETURN NEW;
  END IF;

  v_src := fn_classify_assessment_source(NEW.notes);
  v_actor := CASE v_src
      WHEN 'self_assessment'   THEN 'employee'
      WHEN 'supervisor_review' THEN 'supervisor'
      WHEN 'action_uplift'     THEN 'system'
      WHEN 'import'            THEN 'system'
      ELSE 'admin' END;
  SELECT id INTO v_cycle
    FROM assessment_cycles
   WHERE status = 'open'
   ORDER BY opened_at DESC NULLS LAST
   LIMIT 1;

  INSERT INTO assessment_history
      (employee_id, skill_id, previous_level, new_level, assessed_by, assessed_at, notes, source, actor_type, cycle_id)
  VALUES
      (NEW.employee_id, NEW.skill_id,
       CASE WHEN TG_OP = 'UPDATE' THEN OLD.current_level ELSE NULL END,
       NEW.current_level, NEW.assessed_by, COALESCE(NEW.assessed_at, now()),
       NEW.notes, v_src, v_actor, v_cycle);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_skill_assessment_history ON skill_assessments;
CREATE TRIGGER trg_skill_assessment_history
  AFTER INSERT OR UPDATE ON skill_assessments
  FOR EACH ROW EXECUTE FUNCTION fn_log_skill_assessment_change();

-- ---------------------------------------------------------------------------
-- (b) Reviewer movement
-- ---------------------------------------------------------------------------
ALTER TABLE self_assessments ADD COLUMN IF NOT EXISTS current_reviewer_id BIGINT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'self_assessments_reviewer_fk') THEN
    ALTER TABLE self_assessments
      ADD CONSTRAINT self_assessments_reviewer_fk
      FOREIGN KEY (current_reviewer_id) REFERENCES employees(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_sa_events_assessment_time
  ON self_assessment_events (self_assessment_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sa_current_reviewer
  ON self_assessments (current_reviewer_id);
