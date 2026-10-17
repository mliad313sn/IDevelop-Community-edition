-- 178 — erasure tombstones for the people erased before migration 151.
--
-- Migration 151 created `erasure_tombstones` (one row per erased subject, no
-- foreign key, so it survives a snapshot restore) but did not backfill it. A
-- person erased BEFORE 151 (employees.erased_at set) therefore has no
-- tombstone, and restoring an older backup could bring them back: exactly the
-- risk the tombstone exists to remove.
--
-- One row per employee whose `erased_at` is set, with the real erasure instant
-- and the method 'backfill_151', so the register says where the row came from.
-- Additive and idempotent: ON CONFLICT on the (subject_type, subject_id) UNIQUE
-- of migration 151, so a tombstone already written by DSRService is never
-- overwritten. The tombstone carries ids and dates only, no personal data.
-- Nothing is deleted.

INSERT INTO erasure_tombstones (subject_type, subject_id, erased_at, method)
SELECT 'employee', e.id, e.erased_at, 'backfill_151'
  FROM employees e
 WHERE e.erased_at IS NOT NULL
ON CONFLICT (subject_type, subject_id) DO NOTHING;

COMMENT ON TABLE erasure_tombstones IS
    'One row per erased subject (ids and dates only), re-applied after a snapshot restore (DSRService.reapplyTombstones). Migration 178 backfilled the erasures made before migration 151 from employees.erased_at (method backfill_151).';
