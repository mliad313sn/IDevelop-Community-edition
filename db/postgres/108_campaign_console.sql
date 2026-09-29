-- 108_campaign_console.sql
-- Campaign console upgrade:
--
--   * cycle_participants — WHO excused a person, WHEN, in which CATEGORY, until
--     WHEN (optional automatic re-inclusion), and the history kept when the person
--     is put back. `reviewer_admin_id` snapshots an ADMIN
--     manager for the people who have no employee supervisor, so a
--     "Sans responsable" participant still has a named reviewer to chase.
--   * assessment_cycles — a 'cancelled' state for a draft raised in error, with a
--     mandatory reason, and the reopen trail
--     of a locked campaign given "one more week".
--   * App Settings — cycleAutoLock / cycleAutoCloseGraceDays, read by
--     jobs/cycle-deadline.js since FMEA A5 but never exposed.
--   * employees.erased_at backfill for subjects erased BEFORE migration 104 added the
--     stamp (a development database holds one: first_name 'Erased', number 'ERASED-<id>').
--     The stamp is what every campaign query now uses to keep erased subjects out of
--     rosters and counts.
--
-- CONSTRAINT (unchanged from 70): expected_skills is the FULL department-designed
-- requirement count; nothing here subsets skills. Exclusions stay PERSON-level.
--
-- Idempotent: ADD COLUMN / ADD VALUE IF NOT EXISTS, guarded constraint, ON CONFLICT
-- seeds, stamp. The new enum value is never USED here (PostgreSQL forbids that in
-- the transaction that adds it).

BEGIN;

-- Draft cancelled with a reason (state, not delete).
ALTER TYPE cycle_status ADD VALUE IF NOT EXISTS 'cancelled';

ALTER TABLE assessment_cycles ADD COLUMN IF NOT EXISTS cancelled_at          timestamptz;
ALTER TABLE assessment_cycles ADD COLUMN IF NOT EXISTS cancel_reason         text;
ALTER TABLE assessment_cycles ADD COLUMN IF NOT EXISTS cancelled_by_admin_id bigint REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE assessment_cycles ADD COLUMN IF NOT EXISTS reopened_at           timestamptz;
ALTER TABLE assessment_cycles ADD COLUMN IF NOT EXISTS reopen_count          int NOT NULL DEFAULT 0;

-- Exclusion provenance + category + time box.
ALTER TABLE cycle_participants ADD COLUMN IF NOT EXISTS exclusion_category   text;
ALTER TABLE cycle_participants ADD COLUMN IF NOT EXISTS excluded_by_admin_id bigint REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE cycle_participants ADD COLUMN IF NOT EXISTS excluded_until       date;
-- Re-inclusion trail: the last exclusion survives a re-include.
ALTER TABLE cycle_participants ADD COLUMN IF NOT EXISTS included_at               timestamptz;
ALTER TABLE cycle_participants ADD COLUMN IF NOT EXISTS included_by_admin_id      bigint REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE cycle_participants ADD COLUMN IF NOT EXISTS last_excluded_at          timestamptz;
ALTER TABLE cycle_participants ADD COLUMN IF NOT EXISTS last_exclusion_reason     text;
ALTER TABLE cycle_participants ADD COLUMN IF NOT EXISTS last_exclusion_category   text;
ALTER TABLE cycle_participants ADD COLUMN IF NOT EXISTS last_excluded_by_admin_id bigint;
-- Admin reviewer snapshot (manager_type = 'admin' at enrolment, or assigned later).
ALTER TABLE cycle_participants ADD COLUMN IF NOT EXISTS reviewer_admin_id    bigint REFERENCES admins(id) ON DELETE SET NULL;

-- Category vocabulary: four operator categories + two SYSTEM ones the reconcile
-- job writes. Rendered through locale keys (admin:cyc_cat_<category>).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cycle_participants_exclusion_category_check') THEN
        ALTER TABLE cycle_participants ADD CONSTRAINT cycle_participants_exclusion_category_check
            CHECK (exclusion_category IS NULL OR exclusion_category IN
                   ('long_leave', 'departure', 'transfer', 'other', 'deactivated', 'erased'));
    END IF;
END $$;

-- Existing system exclusions written by reconcileParticipants carried only the
-- French text; give them their category so the UI can translate them.
UPDATE cycle_participants
   SET exclusion_category = 'deactivated'
 WHERE excluded_at IS NOT NULL AND exclusion_category IS NULL
   AND exclusion_reason = 'compte désactivé';

-- Hourly re-inclusion scan (cycle-nudge.tick) touches only time-boxed exclusions.
CREATE INDEX IF NOT EXISTS idx_cycle_participants_excluded_until
    ON cycle_participants (cycle_id, excluded_until) WHERE excluded_until IS NOT NULL;

-- Erased-subject stamp backfill (pre-104 erasures: pseudonymised name + number,
-- no erased_at). Uses the row's last update as the best available date.
UPDATE employees
   SET erased_at = COALESCE(erased_at, updated_at, now())
 WHERE erased_at IS NULL
   AND first_name = 'Erased'
   AND employee_number ILIKE 'erased-%';

-- Campaign governance settings (category 'jobs', with the other schedulers).
INSERT INTO app_settings (setting_key, setting_value, setting_type, category, description) VALUES
    ('cycleAutoLock', 'true', 'boolean', 'jobs',
     'Lock an open assessment campaign automatically once its closing date has passed (no new self-assessments; reviews continue).'),
    ('cycleAutoCloseGraceDays', '-1', 'number', 'jobs',
     'Days after the closing date before a locked campaign is closed automatically (finalises rows, generates IDP drafts). -1 = never close automatically; the console stays in charge.')
ON CONFLICT (setting_key) DO NOTHING;

INSERT INTO schema_meta(key, value) VALUES ('108_campaign_console', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();

COMMIT;
