-- 151 — Retention purge + erasure tombstones (release 3.23.18, lane P-privacy)
--
-- External review S-07 and the data-protection laws of Senegal (2008-12),
-- Côte d'Ivoire (2013-450), Mali (2013-015) and Guinea (L/2016/037): personal
-- data must not be kept beyond its retention period, and an erased person must
-- not come back through a restored backup.
--
--   pii_cleanup_jobs      (existing) gains a LEGAL HOLD (who/when/why) and a
--                         CLAIM stamp, so the retention job acts on a subject at
--                         most once at a time and never on a held one.
--   retention_ledger      one row per decision of the retention job — what it
--                         WOULD do (mode 'report') or DID (mode 'apply').
--   erasure_tombstones    one row per erased subject. NO foreign key on
--                         purpose: a snapshot restore wipes every table that
--                         references `employees`, and the tombstone must survive
--                         it so the erasure can be re-applied afterwards.
--
-- Additive and idempotent. Nothing is deleted. The tombstone and the ledger
-- carry ids and dates only — no personal data.

ALTER TABLE pii_cleanup_jobs ADD COLUMN IF NOT EXISTS legal_hold_at     timestamptz;
ALTER TABLE pii_cleanup_jobs ADD COLUMN IF NOT EXISTS legal_hold_by     text;
ALTER TABLE pii_cleanup_jobs ADD COLUMN IF NOT EXISTS legal_hold_reason text;
ALTER TABLE pii_cleanup_jobs ADD COLUMN IF NOT EXISTS claimed_at        timestamptz;

CREATE TABLE IF NOT EXISTS retention_ledger (
    id            bigserial   PRIMARY KEY,
    run_id        text        NOT NULL,
    category      text        NOT NULL,
    subject_type  text        NOT NULL DEFAULT 'employee',
    subject_id    bigint      NOT NULL,
    mode          text        NOT NULL CHECK (mode IN ('report', 'apply')),
    action        text        NOT NULL,
    detail        text,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_retention_ledger_run     ON retention_ledger (run_id);
CREATE INDEX IF NOT EXISTS idx_retention_ledger_created ON retention_ledger (created_at);
CREATE INDEX IF NOT EXISTS idx_retention_ledger_subject ON retention_ledger (subject_type, subject_id);

CREATE TABLE IF NOT EXISTS erasure_tombstones (
    id            bigserial   PRIMARY KEY,
    subject_type  text        NOT NULL,
    subject_id    bigint      NOT NULL,
    erased_at     timestamptz NOT NULL DEFAULT now(),
    method        text        NOT NULL,
    last_reapplied_at timestamptz,
    UNIQUE (subject_type, subject_id)
);

-- First run after the upgrade REPORTS only: the job lists what it would erase
-- until a SuperAdmin switches this to 'apply'.
INSERT INTO app_settings (setting_key, setting_value, setting_type, description, category)
VALUES ('retentionPurgeMode', 'report', 'string',
        'Retention purge: ''report'' lists the leavers past their retention period without touching them; ''apply'' pseudonymises them through the same path as a GDPR erasure. Any other value is read as ''report''.',
        'jobs')
ON CONFLICT (setting_key) DO NOTHING;
