-- Normalize boolean app-settings that were stored with setting_type='string'.
-- Root cause of a real bug: a boolean setting kept as a '0'/'1' STRING is read back as
-- a string, and Boolean('0') === true — so a module toggled OFF ("0") stayed visible,
-- and the Settings UI rendered a raw value instead of an on/off badge. This forces the
-- correct type + a canonical 'true'/'false' value for the known boolean keys.
-- Additive & idempotent.

UPDATE app_settings
   SET setting_type  = 'boolean',
       setting_value = CASE
                          WHEN lower(coalesce(setting_value, '')) IN ('1', 'true', 'on', 'yes') THEN 'true'
                          ELSE 'false'
                       END
 WHERE setting_key IN (
        'featureLocalContent',
        'enableEmailNotifications',
        'smtpSecure',
        'emailOnWorkflow', 'emailOnValidation', 'emailOnTalentActions',
        'emailOnCoaching', 'emailOnLifecycle', 'emailOnAuth',
        'onboarding.enabled', 'onboarding.allowSso', 'onboarding.allowSignup', 'onboarding.allowOpenSignup',
        'mfaRequiredForPrivileged'
       )
   AND (setting_type <> 'boolean' OR setting_value NOT IN ('true', 'false'));

INSERT INTO schema_meta(key, value) VALUES ('51_fix_boolean_setting_types', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();
