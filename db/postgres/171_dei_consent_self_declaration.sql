-- ============================================================================
-- 171 — Diversity (DEI) data: self-declaration with explicit consent only.
--
-- Before this migration the only writer of employee_demographics was a
-- manager/admin endpoint, and `self_declared` defaulted to TRUE whenever the
-- caller omitted it: no stored row can be trusted as self-declared, and no
-- consent was ever recorded. From now on:
--
--   employee_demographics  gains its PROVENANCE and an HR-review flag. Every row
--                          that exists when this migration runs gets
--                          provenance 'legacy_unknown' + needs_review = true
--                          (the column defaults do it, once, at ADD COLUMN
--                          time): such values are excluded from every analytic,
--                          hidden from managers, and wait for the person to
--                          confirm them (re-declaration with consent) or for HR
--                          to clear them. The defaults stay: a row written by
--                          any path other than the self-declaration flow is
--                          flagged too (fail closed). self_declared no longer
--                          defaults to true.
--   dei_consents           the consent ledger: who, when, which fields, which
--                          consent-text version, and when it ended (withdrawn /
--                          superseded / cleared by HR). Withdrawal nulls the
--                          declared values at once; the ledger row is kept
--                          (field NAMES only, never values). Erasure: see
--                          src/services/erasureRegistry.js.
--
-- The ethnicity switch (app setting deiEthnicityEnabled, OFF unless written by
-- the SuperAdmin flow with a typed legal sign-off) needs no row: absent = off.
--
-- Additive and idempotent. Nothing is deleted.
-- ============================================================================

CREATE TABLE IF NOT EXISTS dei_consents (
    id             bigserial   PRIMARY KEY,
    employee_id    bigint      NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    fields         text[]      NOT NULL,
    text_version   text        NOT NULL,
    locale         text,
    granted_at     timestamptz NOT NULL DEFAULT now(),
    withdrawn_at   timestamptz,
    end_reason     text,
    CONSTRAINT chk_dei_consent_end
        CHECK ((withdrawn_at IS NULL AND end_reason IS NULL)
            OR (withdrawn_at IS NOT NULL
                AND end_reason IN ('withdrawn', 'superseded', 'hr_cleared')))
);
-- At most ONE consent in force per person.
CREATE UNIQUE INDEX IF NOT EXISTS uq_dei_consent_open
    ON dei_consents (employee_id) WHERE withdrawn_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_dei_consents_employee ON dei_consents (employee_id);

ALTER TABLE employee_demographics ALTER COLUMN self_declared SET DEFAULT false;
ALTER TABLE employee_demographics
    ADD COLUMN IF NOT EXISTS provenance text NOT NULL DEFAULT 'legacy_unknown';
ALTER TABLE employee_demographics
    ADD COLUMN IF NOT EXISTS needs_review boolean NOT NULL DEFAULT true;
ALTER TABLE employee_demographics
    ADD COLUMN IF NOT EXISTS consent_id bigint REFERENCES dei_consents(id) ON DELETE SET NULL;
ALTER TABLE employee_demographics ADD COLUMN IF NOT EXISTS hr_reviewed_at timestamptz;
ALTER TABLE employee_demographics ADD COLUMN IF NOT EXISTS hr_reviewed_by text;
ALTER TABLE employee_demographics ADD COLUMN IF NOT EXISTS hr_review_note text;

DO $$
BEGIN
    ALTER TABLE employee_demographics
        ADD CONSTRAINT chk_demographics_provenance
        CHECK (provenance IN ('self', 'legacy_unknown', 'withdrawn', 'hr_cleared'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_demographics_needs_review
    ON employee_demographics (employee_id) WHERE needs_review;

-- The SQL console reader sees the new table and columns (migration 168).
SELECT public.fn_console_reader_sync();
