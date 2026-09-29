-- ============================================================================
-- 75 — Quiet hours that genuinely defer + the email-category switches the code
--      already reads but that were never seeded.
--
--   1) notifications.release_at
--      Quiet hours were a promise with no mechanism. A row was written with
--      state='snoozed' but (a) the inbox query never filtered on state, so a
--      "deferred" notification was visible the instant it was written, and
--      (b) the release job joined notification_preferences on p.kind = n.kind
--      while the quiet-hours window actually lives on the WILDCARD row
--      ('__all__','inapp') — the join found nothing, quiet hours read as NULL,
--      and every snoozed row was un-snoozed on the very next 15-minute tick.
--
--      Storing the ABSOLUTE moment the window ends makes deferral real and
--      self-healing: the inbox hides a snoozed row until release_at has passed,
--      so the user still sees it even if the release job never runs, and the
--      release job no longer has to re-derive the window from preferences that
--      may have changed since.
--
--      The same column carries the EMAIL channel: an immediate-tier email that
--      lands inside the quiet window is written as a snoozed 'email' row and
--      actually sent when the window ends, instead of hitting the inbox at
--      03:00. Reusing the existing 'snoozed' enum value deliberately — adding a
--      value to notif_state would need ALTER TYPE, which has bitten this
--      install before (type ownership on the target server).
--
--   2) The eight missing emailOn* settings
--      EmailService.isCategoryEnabled gates on fourteen keys; only six were
--      ever seeded (21_email_settings.sql). The other eight resolved to their
--      hard-coded code default and were INVISIBLE in App Settings, so the
--      admin UI showed six switches for fourteen behaviours. Seeded here with
--      values IDENTICAL to those code defaults — nothing changes behaviour,
--      the switches simply become real and editable.
--
--   Additive & idempotent: safe to re-run.
-- ============================================================================

-- ---- 1) Deferral instant -----------------------------------------------------
ALTER TABLE public.notifications
    ADD COLUMN IF NOT EXISTS release_at timestamptz;

COMMENT ON COLUMN public.notifications.release_at IS
    'When a state=''snoozed'' row becomes deliverable (end of the recipient''s quiet-hours window). NULL on rows that were never deferred.';

-- The release tick and every inbox read filter on exactly this predicate.
CREATE INDEX IF NOT EXISTS idx_notifications_snoozed_release
    ON public.notifications (release_at)
    WHERE state = 'snoozed';

-- ---- 2) The email-category switches the code already reads -------------------
INSERT INTO public.app_settings (setting_key, setting_value, setting_type, description, category) VALUES
    ('emailOnReviews',    'false', 'boolean', 'Email on supervisor-review events (review completed)',                                     'emailEvents'),
    ('emailOnCompliance', 'true',  'boolean', 'Email on compliance events (certification expiry, skills-coverage breach)',                'emailEvents'),
    ('emailOnDisputes',   'true',  'boolean', 'Email on rating-dispute events (opened / escalated / resolved)',                            'emailEvents'),
    ('emailOnAccess',     'true',  'boolean', 'Email on access-governance events (access review to complete)',                             'emailEvents'),
    ('emailOnDigest',     'true',  'boolean', 'Send the daily personal digest — ONE rollup email replacing per-event mail',                'emailEvents'),
    ('emailOnEngagement', 'false', 'boolean', 'Email on engagement events (recognition received) — off by default: kudos never spam',      'emailEvents'),
    ('emailOnMobility',   'false', 'boolean', 'Email on internal-mobility events (opportunity posted, application received)',              'emailEvents'),
    ('emailOnSurvey',     'false', 'boolean', 'Email on survey events (survey published, response reminder)',                              'emailEvents')
ON CONFLICT (setting_key) DO NOTHING;

-- Same normalisation 51_fix_boolean_setting_types.sql applied to the first six:
-- a boolean kept as a '0'/'1' STRING reads back as a string, and Boolean('0')
-- is true — an OFF switch would behave as ON.
UPDATE public.app_settings
   SET setting_type  = 'boolean',
       setting_value = CASE
                          WHEN lower(coalesce(setting_value, '')) IN ('1', 'true', 'on', 'yes') THEN 'true'
                          ELSE 'false'
                       END
 WHERE setting_key IN (
        'emailOnReviews', 'emailOnCompliance', 'emailOnDisputes', 'emailOnAccess',
        'emailOnDigest', 'emailOnEngagement', 'emailOnMobility', 'emailOnSurvey'
       )
   AND (setting_type <> 'boolean' OR setting_value NOT IN ('true', 'false'));
