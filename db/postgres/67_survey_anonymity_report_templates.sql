-- 67_survey_anonymity_report_templates.sql
-- (a) Real survey anonymity: an "anonymous" survey previously stored
--     employee_id on every response row, so anonymity was only an
--     aggregation-time promise (anyone with DB/SQL-console access could read
--     who said what). Responses now carry a respondent_key — the plain
--     employee id for named surveys, an HMAC pseudonym for anonymous ones —
--     and employee_id stays NULL for anonymous responses. The dedup unique
--     moves onto respondent_key so idempotent re-answers still work.
-- (b) Report-template ownership: created_by referenced admins.id but manager
--     saves fell back to the default admin's id (their private templates
--     vanished from their list, and employee-id/admin-id collisions could
--     expose other admins' private templates). Add a creator-type
--     discriminator so (type, id) is unambiguous.
-- Idempotent.

ALTER TABLE public.survey_responses ADD COLUMN IF NOT EXISTS respondent_key text;
UPDATE public.survey_responses SET respondent_key = employee_id::text WHERE respondent_key IS NULL AND employee_id IS NOT NULL;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_survey_resp') THEN
    ALTER TABLE public.survey_responses DROP CONSTRAINT uq_survey_resp;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_survey_resp_key') THEN
    ALTER TABLE public.survey_responses ADD CONSTRAINT uq_survey_resp_key UNIQUE (survey_id, question_id, respondent_key);
  END IF;
END $$;

-- creator_type: 'admin' (created_by = admins.id) | 'employee' (created_by = employees.id).
-- The FK to admins(id) is what forced manager saves to impersonate an admin —
-- created_by becomes polymorphic on creator_type, so the FK must go.
ALTER TABLE public.report_templates ADD COLUMN IF NOT EXISTS creator_type text NOT NULL DEFAULT 'admin';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_templates_created_by_fkey') THEN
    ALTER TABLE public.report_templates DROP CONSTRAINT report_templates_created_by_fkey;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_report_templates_creator_type') THEN
    ALTER TABLE public.report_templates ADD CONSTRAINT chk_report_templates_creator_type CHECK (creator_type IN ('admin','employee'));
  END IF;
END $$;
