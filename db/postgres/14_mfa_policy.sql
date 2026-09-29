-- 14: MFA policy switch — when enabled, privileged admin roles (superadmin,
-- regional_admin, country_admin, site_admin, hr_bp) are funnelled into
-- two-factor setup after login until they enrol (same UX as the forced
-- password change). Managed from App Settings → Security.
INSERT INTO app_settings (setting_key, setting_value, setting_type, description, category)
VALUES (
    'mfaRequiredForPrivileged',
    'false',
    'boolean',
    'Require two-factor authentication for privileged admin roles (superadmin, regional/country/site admin, HR BP). They are redirected to MFA setup after login until enrolled.',
    'security'
)
ON CONFLICT (setting_key) DO NOTHING;
