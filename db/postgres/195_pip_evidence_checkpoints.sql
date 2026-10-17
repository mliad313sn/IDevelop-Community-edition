-- 195 — the evidence of a performance-improvement plan (4.0.0 port, wave 6)
--
-- A PIP is a serious record about a person. This migration lets the plan carry
-- its own proof:
--
--   on pips (all nullable, nothing back-filled):
--     proposed_by_ref                who actually wrote the proposal
--                                    ('employee:<id>' | 'admin:<id>');
--                                    initiated_by stays the system account for
--                                    a manager, as before
--     activated_at, activated_by_ref when the plan started to run, and by whom
--     acknowledged_at                the date the person said they had READ the
--                                    plan — a reading, never an agreement
--     employee_comment, employee_comment_at
--                                    the person's own observations (free text:
--                                    erasure registry, export and redaction in
--                                    the same change)
--     hr_visa_at, hr_visa_by_ref     the optional HR visa before activation
--
--   pip_reviews — one row per checkpoint as held: the date, the manager's note
--   (author_ref), and the person's own response. The note and the response are
--   free text about the person: they are in the erasure registry, the access
--   export and the redaction. The table is ordinary (no append-only trigger):
--   the cleanup and the go-live reset list it before pips, and the restore-point
--   revert takes it back with the plans it belongs to.
--
-- The setting pip.hrVisaRequired (OFF): when ON, a PIP needs an HR visa (a
-- SuperAdmin, or an administrator holding arbitrate_disputes whose clearance
-- covers the person) before it can be activated. Governance-class: a SuperAdmin
-- only changes it (src/utils/securitySettings.js).
--
-- A proposed plan is not shown to the person until it is activated (the
-- application reads activated_at, and for older rows the PIP_ACTIVATED journal
-- line). Nothing in this file changes an existing value.
--
-- Additive and idempotent: safe to re-run. Nothing is deleted.

ALTER TABLE public.pips ADD COLUMN IF NOT EXISTS proposed_by_ref text;
ALTER TABLE public.pips ADD COLUMN IF NOT EXISTS activated_at timestamptz;
ALTER TABLE public.pips ADD COLUMN IF NOT EXISTS activated_by_ref text;
ALTER TABLE public.pips ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz;
ALTER TABLE public.pips ADD COLUMN IF NOT EXISTS employee_comment text;
ALTER TABLE public.pips ADD COLUMN IF NOT EXISTS employee_comment_at timestamptz;
ALTER TABLE public.pips ADD COLUMN IF NOT EXISTS hr_visa_at timestamptz;
ALTER TABLE public.pips ADD COLUMN IF NOT EXISTS hr_visa_by_ref text;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_pips_employee_comment') THEN
        ALTER TABLE public.pips ADD CONSTRAINT chk_pips_employee_comment
            CHECK (employee_comment IS NULL OR length(employee_comment) <= 4000);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_pips_evidence_refs') THEN
        ALTER TABLE public.pips ADD CONSTRAINT chk_pips_evidence_refs
            CHECK ((proposed_by_ref IS NULL OR proposed_by_ref ~ '^(admin|employee):[0-9]{1,12}$')
               AND (activated_by_ref IS NULL OR activated_by_ref ~ '^(admin|employee):[0-9]{1,12}$')
               AND (hr_visa_by_ref IS NULL OR hr_visa_by_ref ~ '^(admin|employee):[0-9]{1,12}$'));
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.pip_reviews (
    id                    bigserial   PRIMARY KEY,
    pip_id                bigint      NOT NULL REFERENCES public.pips(id) ON DELETE CASCADE,
    held_on               date        NOT NULL DEFAULT CURRENT_DATE,
    manager_note          text        NOT NULL,
    author_ref            text        NOT NULL,
    created_at            timestamptz NOT NULL DEFAULT now(),
    employee_response     text,
    employee_response_at  timestamptz,
    CONSTRAINT chk_pip_reviews_note CHECK (length(btrim(manager_note)) BETWEEN 1 AND 4000),
    CONSTRAINT chk_pip_reviews_response CHECK (employee_response IS NULL OR length(employee_response) <= 4000),
    CONSTRAINT chk_pip_reviews_author CHECK (author_ref ~ '^(admin|employee):[0-9]{1,12}$')
);

CREATE INDEX IF NOT EXISTS idx_pip_reviews_pip ON public.pip_reviews (pip_id, held_on, id);

COMMENT ON TABLE public.pip_reviews IS
    'Migration 195: a PIP checkpoint as held — the manager''s note (author_ref) and the person''s own response. Both texts are redacted when the person is erased.';

INSERT INTO public.app_settings (setting_key, setting_value, setting_type, description, category)
VALUES ('pip.hrVisaRequired',
        'false',
        'boolean',
        'When on, a performance-improvement plan needs an HR visa (a SuperAdmin, or an administrator holding the dispute-arbitration permission for the person) before its manager can activate it. Off by default: the manager owns the plan.',
        'security')
ON CONFLICT (setting_key) DO NOTHING;

-- The SQL console reader stays in step with the schema (migration 168).
SELECT public.fn_console_reader_sync();
