-- 159 — Boolean settings seeded ON by mistake
--
-- AppSettingsModel.setValue stored a boolean as `value ? 'true' : 'false'`.
-- The defaults are strings, and 'false' / '0' are truthy strings, so every
-- boolean setting whose default is OFF was written as 'true' on a fresh
-- install: public self-signup open to any domain, named-person ranking by the
-- AI copilot, email notifications, skill anonymisation.
--
-- The model is fixed. This repairs rows that no person ever changed
-- (updated_by IS NULL): they still hold the mis-seeded value, so they go back
-- to the documented default. A value an administrator chose is left alone.
--
-- Idempotent.

UPDATE app_settings
   SET setting_value = 'false', updated_at = now()
 WHERE setting_type = 'boolean'
   AND setting_value = 'true'
   AND updated_by IS NULL
   AND setting_key IN (
        'enableEmailNotifications',
        'onboarding.enabled',
        'onboarding.allowSso',
        'onboarding.allowSignup',
        'onboarding.allowOpenSignup',
        'copilotAnonymizeSkills',
        'copilot.allow_named_person_ranking'
   );
