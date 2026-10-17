-- 194 — a rating dispute's first answer is a proposal (4.0.0 port, wave 6)
--
-- Level 0 of a dispute is answered, most of the time, by the very supervisor
-- whose rating is contested. Until now that answer was final and could even
-- lower the rating. From this version on:
--
--   - the L0 rung PROPOSES a rating, between the contested rating and the
--     person's own rating, never below the contested one;
--   - the person accepts it (the dispute is resolved with that rating) or
--     refuses it (it goes to the manager, level 1, at once);
--   - without an answer, the dispute goes to level 1 when the L0 delay has run
--     from the proposal (DisputeServiceV2.escalateOverdueL0).
--
-- Columns on assessment_disputes (all nullable, nothing back-filled):
--   proposed_rating, proposed_at          the proposal and its date
--   proposed_by                           the person who proposed (employees)
--   proposed_by_admin_id                  the administration account, if any
--   proposal_note                         the proposer's written reason (free
--                                         text about the person: erasure
--                                         registry, export and redaction, in
--                                         the same change)
--   employee_response, employee_response_at
--                                         'accepted' | 'refused', and when
--   hr_reminded_at                        HR was reminded two days before the
--                                         level-2 deadline (once per dispute)
--
-- The setting dispute.autoFinalizeOnExpiry (migration 47) is now OFF by
-- default: a contested rating stays provisional until HR decides, and HR is
-- reminded two days before the deadline. This is the ONLY value this migration
-- changes, and only where nobody chose it (updated_by IS NULL, the untouched
-- seed). A value an administrator set is left exactly as it is. On an upgrade
-- where the value was switched off, every active SuperAdmin gets an in-app
-- notice (kind dispute.auto_finalize_off) that links to the App Settings.
--
-- New install vs upgrade, as in migrations 162 and 190: the migrations of a new
-- install are all applied in one run, so the oldest schema_meta row is minutes
-- old; on an upgrade it is the date of the original install (threshold 6 h).
--
-- Additive and idempotent: safe to re-run. Nothing is deleted.

ALTER TABLE public.assessment_disputes ADD COLUMN IF NOT EXISTS proposed_rating smallint;
ALTER TABLE public.assessment_disputes ADD COLUMN IF NOT EXISTS proposed_at timestamptz;
ALTER TABLE public.assessment_disputes ADD COLUMN IF NOT EXISTS proposed_by bigint;
ALTER TABLE public.assessment_disputes ADD COLUMN IF NOT EXISTS proposed_by_admin_id bigint;
ALTER TABLE public.assessment_disputes ADD COLUMN IF NOT EXISTS proposal_note text;
ALTER TABLE public.assessment_disputes ADD COLUMN IF NOT EXISTS employee_response text;
ALTER TABLE public.assessment_disputes ADD COLUMN IF NOT EXISTS employee_response_at timestamptz;
ALTER TABLE public.assessment_disputes ADD COLUMN IF NOT EXISTS hr_reminded_at timestamptz;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'assessment_disputes_proposed_by_fkey'
                      AND conrelid = 'public.assessment_disputes'::regclass) THEN
        ALTER TABLE public.assessment_disputes
            ADD CONSTRAINT assessment_disputes_proposed_by_fkey
            FOREIGN KEY (proposed_by) REFERENCES public.employees(id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'assessment_disputes_proposed_by_admin_id_fkey'
                      AND conrelid = 'public.assessment_disputes'::regclass) THEN
        ALTER TABLE public.assessment_disputes
            ADD CONSTRAINT assessment_disputes_proposed_by_admin_id_fkey
            FOREIGN KEY (proposed_by_admin_id) REFERENCES public.admins(id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_dispute_proposed_rating') THEN
        ALTER TABLE public.assessment_disputes ADD CONSTRAINT chk_dispute_proposed_rating
            CHECK (proposed_rating IS NULL OR proposed_rating BETWEEN 0 AND 4);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_dispute_proposal_complete') THEN
        ALTER TABLE public.assessment_disputes ADD CONSTRAINT chk_dispute_proposal_complete
            CHECK ((proposed_at IS NULL) = (proposed_rating IS NULL));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_dispute_proposal_note') THEN
        ALTER TABLE public.assessment_disputes ADD CONSTRAINT chk_dispute_proposal_note
            CHECK (proposal_note IS NULL OR length(proposal_note) <= 4000);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_dispute_employee_response') THEN
        ALTER TABLE public.assessment_disputes ADD CONSTRAINT chk_dispute_employee_response
            CHECK (employee_response IS NULL OR employee_response IN ('accepted', 'refused'));
    END IF;
END $$;

COMMENT ON COLUMN public.assessment_disputes.proposed_rating IS
    'Migration 194: the level-0 rung proposes a rating (never below the contested one); the person accepts it (resolved) or refuses it (escalated to level 1).';
COMMENT ON COLUMN public.assessment_disputes.proposal_note IS
    'Migration 194: the proposer''s written reason. About the person: redacted on erasure.';

-- Auto-finalise OFF where nobody chose the value; the SuperAdmins are told on
-- an upgrade.
DO $$
DECLARE
    v_upgrade boolean;
    v_changed integer;
BEGIN
    SELECT COALESCE(MIN(applied_at) < now() - interval '6 hours', false)
      INTO v_upgrade
      FROM public.schema_meta
     WHERE applied_at IS NOT NULL;

    UPDATE public.app_settings
       SET setting_value = 'false',
           description = 'When a level-2 dispute passes its deadline with no HR decision, finalise it automatically with the supervisor''s rating. Off by default: the rating stays provisional until HR decides, and HR is reminded two days before the deadline.',
           updated_at = now()
     WHERE setting_key = 'dispute.autoFinalizeOnExpiry'
       AND setting_value = 'true'
       AND updated_by IS NULL;
    GET DIAGNOSTICS v_changed = ROW_COUNT;

    IF v_upgrade AND v_changed > 0 THEN
        INSERT INTO public.notifications (user_type, user_id, channel, kind, locale, payload, state)
        SELECT 'admin',
               a.id,
               'inapp'::public.notif_channel,
               'dispute.auto_finalize_off',
               'fr',
               jsonb_build_object('link', '/app-settings'),
               'queued'::public.notif_state
          FROM public.admins a
         WHERE a.role = 'superadmin'
           AND a.is_active = true
           AND NOT EXISTS (SELECT 1 FROM public.notifications n
                            WHERE n.user_type = 'admin' AND n.user_id = a.id
                              AND n.kind = 'dispute.auto_finalize_off');
    END IF;
END $$;

-- The SQL console reader stays in step with the schema (migration 168).
SELECT public.fn_console_reader_sync();
