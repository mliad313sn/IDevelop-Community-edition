-- 21_email_settings.sql
-- Email-on-action notifications: SMTP server configuration and per-domain
-- trigger toggles, surfaced in the App Settings UI. Idempotent — safe to
-- re-run; existing values are never overwritten.

INSERT INTO public.app_settings (setting_key, setting_value, setting_type, description, category) VALUES
    ('smtpHost',         '',           'string',  'SMTP server hostname (e.g. smtp.office365.com). Leave blank to disable email.', 'email'),
    ('smtpPort',         '587',        'number',  'SMTP server port (587 for STARTTLS, 465 for SSL/TLS, 25 for relay)',            'email'),
    ('smtpSecure',       'false',      'boolean', 'Use implicit SSL/TLS (enable for port 465; leave off for 587 STARTTLS)',        'email'),
    ('smtpUser',         '',           'string',  'SMTP username for authentication (leave blank for unauthenticated relay)',      'email'),
    ('smtpPassword',     '',           'string',  'SMTP password / app password (stored server-side; hidden in this list)',        'email'),
    ('smtpFromName',     'IDevelop',  'string',  'Display name shown on outgoing emails',                                         'email'),
    ('smtpFromAddress',  '',           'string',  'From address for outgoing emails (e.g. no-reply@yourcompany.com)',              'email'),
    ('emailOnWorkflow',     'true',  'boolean', 'Email on workflow events (self-assessment submitted / approved / rejected / changes requested)', 'emailEvents'),
    ('emailOnValidation',   'true',  'boolean', 'Email on validation events (maker-checker submitted / approved / rejected)',                       'emailEvents'),
    ('emailOnTalentActions','true',  'boolean', 'Email on talent actions (PIP, IDP, 9-box placement)',                                              'emailEvents'),
    ('emailOnCoaching',     'true',  'boolean', 'Email on coaching plan events (created / completed)',                                               'emailEvents'),
    ('emailOnLifecycle',    'true',  'boolean', 'Email on lifecycle events (joiner / mover / leaver, cycle open / close)',                           'emailEvents'),
    ('emailOnAuth',         'false', 'boolean', 'Email on account/security events (new admin account, password changes)',                            'emailEvents')
ON CONFLICT (setting_key) DO NOTHING;

-- Clarify the existing master switch now that per-domain toggles exist.
UPDATE public.app_settings
   SET description = 'Master switch — send emails when system actions occur (workflow, validation, talent actions, etc.)'
 WHERE setting_key = 'enableEmailNotifications';
