-- 65_notification_reminders.sql
-- Generic exactly-once reminder ledger (the nudge_log pattern, but not tied to an
-- assessment cycle) + mobility application decision columns. Idempotent.

CREATE TABLE IF NOT EXISTS public.reminder_log (
    id          bigserial PRIMARY KEY,
    kind        text   NOT NULL,           -- 'idp.signoff' | 'lms.due' | 'survey.respond' | 'access.review'
    target_type text   NOT NULL,           -- 'employee' | 'admin'
    target_id   bigint NOT NULL,
    ref_id      bigint NOT NULL DEFAULT 0,  -- entity id (idp/enrollment/survey); 0 when N/A (NOT NULL so UNIQUE dedupes)
    period      text   NOT NULL,           -- bucket: 'YYYY-MM-DD' | 'YYYY-Www' | 'YYYY-MM' | 'once'
    sent_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (kind, target_type, target_id, ref_id, period)
);
CREATE INDEX IF NOT EXISTS idx_reminder_log_lookup ON public.reminder_log (kind, target_type, target_id);

-- Mobility: model an application DECISION so a poster can accept/decline and the
-- applicant is notified. status already exists ('applied'); add the decision trail.
ALTER TABLE public.opportunity_applications ADD COLUMN IF NOT EXISTS decided_at          timestamptz;
ALTER TABLE public.opportunity_applications ADD COLUMN IF NOT EXISTS decided_by_admin_id bigint;
ALTER TABLE public.opportunity_applications ADD COLUMN IF NOT EXISTS decision_note       text;
