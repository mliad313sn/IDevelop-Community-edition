-- 196 — who issued a certificate (4.0.0 port, wave 8)
--
-- The certification register holds the number, the dates, the evidence file
-- and the field sign-off (VOC) of a certificate, but not the body that issued
-- it: a training centre, a certifying body, an internal assessor. An auditor
-- asks for it first, and the certificate record quality indicator (K44) could
-- not say whether it is recorded.
--
--   employee_certifications.issuer   text, NULLABLE
--       NULL means « not recorded ». The rows recorded before this migration
--       stay NULL: nothing is guessed or back-filled, and the record quality
--       indicator shows them as not recorded, never as a value.
--       When present it is trimmed and 1 to 200 characters long (an empty or
--       blank string is not an issuer).
--
-- The issuer names an organisation, not the person: the erasure keeps it with
-- the other facts of the certificate (skill, dates, state), and the person's
-- access export lists it.
--
-- Additive and idempotent: one nullable column and one CHECK. Nothing is
-- rewritten or deleted.

ALTER TABLE public.employee_certifications ADD COLUMN IF NOT EXISTS issuer text;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'chk_employee_certifications_issuer'
           AND conrelid = 'public.employee_certifications'::regclass
    ) THEN
        ALTER TABLE public.employee_certifications
            ADD CONSTRAINT chk_employee_certifications_issuer
            CHECK (issuer IS NULL
                   OR (issuer = btrim(issuer) AND char_length(issuer) BETWEEN 1 AND 200));
    END IF;
END $$;

COMMENT ON COLUMN public.employee_certifications.issuer IS
    'Body that issued the certificate (migration 196). NULL = not recorded; rows recorded before 196 are never back-filled.';

-- The SQL console reader stays in step with the schema (migration 168).
SELECT public.fn_console_reader_sync();
