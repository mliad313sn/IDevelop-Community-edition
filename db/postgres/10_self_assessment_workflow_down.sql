-- Rollback for 10_self_assessment_workflow.sql. Idempotent, fully reverses.
BEGIN;
DROP TABLE IF EXISTS self_assessment_events;
DROP TABLE IF EXISTS self_assessment_comments;

ALTER TABLE supervisor_reviews DROP CONSTRAINT IF EXISTS chk_sr_decision;
ALTER TABLE supervisor_reviews DROP COLUMN IF EXISTS decision;
ALTER TABLE supervisor_reviews DROP COLUMN IF EXISTS recommendation;
ALTER TABLE supervisor_reviews DROP COLUMN IF EXISTS decided_at;

ALTER TABLE self_assessments DROP CONSTRAINT IF EXISTS chk_sa_workflow_state;
ALTER TABLE self_assessments DROP COLUMN IF EXISTS workflow_state;
ALTER TABLE self_assessments DROP COLUMN IF EXISTS approved_by;
ALTER TABLE self_assessments DROP COLUMN IF EXISTS approved_at;

DELETE FROM schema_meta WHERE key='10_self_assessment_workflow';
COMMIT;
