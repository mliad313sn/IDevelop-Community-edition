-- 41_fk_integrity.sql — referential integrity + join-perf hardening.
-- (A) Indexes on hot FK columns that had real row volume but no index (join cost
--     at 4000-user scale). (B) FK constraints on genuine single-target foreign
--     keys that had none — verified 0 orphans on prod the production database before adding, so
--     these validate cleanly. All additive & idempotent.

-- (A) Hot FK indexes (rows today: assessed_by 2854 / 383, reviewed_by+approved_by 179).
CREATE INDEX IF NOT EXISTS idx_skill_assessments_assessed_by  ON skill_assessments(assessed_by);
CREATE INDEX IF NOT EXISTS idx_assessment_history_assessed_by ON assessment_history(assessed_by);
CREATE INDEX IF NOT EXISTS idx_self_assessments_reviewed_by   ON self_assessments(reviewed_by);
CREATE INDEX IF NOT EXISTS idx_self_assessments_approved_by   ON self_assessments(approved_by);
CREATE INDEX IF NOT EXISTS idx_supervisor_reviews_reviewed_by ON supervisor_reviews(reviewed_by);
CREATE INDEX IF NOT EXISTS idx_coaching_sessions_coach_id     ON coaching_sessions(coach_id);

-- (B) Missing FK constraints on genuine single-target FKs (data verified clean).
-- Guarded with DO blocks so re-running (or a pre-existing constraint) is a no-op.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_coaching_sessions_coach') THEN
        ALTER TABLE coaching_sessions ADD CONSTRAINT fk_coaching_sessions_coach
            FOREIGN KEY (coach_id) REFERENCES employees(id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_supervisor_reviews_reviewed_by') THEN
        ALTER TABLE supervisor_reviews ADD CONSTRAINT fk_supervisor_reviews_reviewed_by
            FOREIGN KEY (reviewed_by) REFERENCES employees(id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_assessment_evidence_uploaded_by') THEN
        ALTER TABLE assessment_evidence ADD CONSTRAINT fk_assessment_evidence_uploaded_by
            FOREIGN KEY (uploaded_by) REFERENCES employees(id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_talent_ratings_reviewer') THEN
        ALTER TABLE talent_ratings ADD CONSTRAINT fk_talent_ratings_reviewer
            FOREIGN KEY (reviewer_id) REFERENCES employees(id);
    END IF;
END $$;

INSERT INTO schema_meta(key, value) VALUES ('41_fk_integrity', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();
