-- ============================================================================
-- Lifecycle event revert (super admin). A joiner/mover/leaver recorded by
-- mistake can be reverted: the event row is kept for the audit trail and
-- stamped with who reverted it and when, while the service undoes the
-- side effects (reactivate account, drop pending PII cleanup, remove the
-- pristine provisional assessments a joiner created, cancel the auto
-- handover plan).
-- Additive & idempotent.
-- ============================================================================

ALTER TABLE lifecycle_events ADD COLUMN IF NOT EXISTS reverted_at timestamptz;
ALTER TABLE lifecycle_events ADD COLUMN IF NOT EXISTS reverted_by bigint REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE lifecycle_events ADD COLUMN IF NOT EXISTS revert_note text;

CREATE INDEX IF NOT EXISTS idx_lifecycle_reverted ON lifecycle_events (reverted_at) WHERE reverted_at IS NOT NULL;
