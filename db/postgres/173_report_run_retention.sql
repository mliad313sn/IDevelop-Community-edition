-- 173_report_run_retention.sql — the in-app copies of scheduled reports do not
-- live for ever (SA-38).
--
-- report_schedule_runs.content (migration 172) is a full CSV extract. From this
-- migration:
--   * the daily retention-purge pass empties the CONTENT of every copy older
--     than the app setting `reportRunRetentionDays` (default 90, 1 to 365):
--     content = NULL, purged_at = now(), purge_reason = 'retention'. The row
--     (date, schedule, row count) stays for the audit;
--   * a GDPR erasure empties the content of every copy whose scope contains the
--     erased person, and of every unrestricted copy (purge_reason 'erasure');
--   * the download of an emptied copy answers 410 « copy expired ».
-- content therefore becomes NULL-able. Nothing is deleted.
--
-- Idempotent: IF NOT EXISTS, a guarded constraint, and the setting is seeded
-- only when absent.

ALTER TABLE report_schedule_runs ALTER COLUMN content DROP NOT NULL;
ALTER TABLE report_schedule_runs ADD COLUMN IF NOT EXISTS purged_at timestamptz;
ALTER TABLE report_schedule_runs ADD COLUMN IF NOT EXISTS purge_reason text;

DO $$
BEGIN
    ALTER TABLE report_schedule_runs
        ADD CONSTRAINT chk_report_schedule_runs_purge_reason
        CHECK (purge_reason IS NULL OR purge_reason IN ('retention', 'erasure'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_report_schedule_runs_unpurged
    ON report_schedule_runs (created_at) WHERE purged_at IS NULL;

-- Retention setting (security class through RetentionDays$ in
-- utils/securitySettings → SuperAdmin only).
INSERT INTO public.app_settings (setting_key, setting_value, setting_type, description, category)
SELECT 'reportRunRetentionDays', '90', 'number',
       'Days the content of a scheduled report copy is kept (1-365, default 90). Past it the copy is emptied; the row (date, schedule, row count) stays and its link answers « copy expired ».',
       'jobs'
 WHERE NOT EXISTS (SELECT 1 FROM public.app_settings WHERE setting_key = 'reportRunRetentionDays');

-- The SQL console reader sees the new columns (migration 168).
SELECT public.fn_console_reader_sync();
