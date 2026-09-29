-- 83_email_link_base_url.sql
--
-- The address users click in e-mails, configurable from App Settings.
--
-- WHY THIS IS A SETTING AND NOT JUST AN ENV VAR
--   Links in outgoing mail must point at the address people actually browse to.
--   Until now that came from the APP_BASE_URL environment variable, which means
--   editing .env and restarting the service — something an HR administrator
--   cannot do and should not have to ask for. When it was unset the app fell
--   back to the machine's own hostname, so recipients were sent to a name that
--   often does not resolve from where they read their mail (a phone on mobile
--   data, a laptop off the plant network).
--
-- WHY IT IS NOT SIMPLY TAKEN FROM THE REQUEST
--   Because a reset link carries a single-use credential. Deriving it from the
--   caller's own Host header let an attacker request a reset for SOMEONE ELSE's
--   account with `Host: evil.test`: the victim received a genuine e-mail from
--   this platform whose link pointed at attacker infrastructure. The address is
--   therefore always operator-controlled — a setting, an env var, or a strictly
--   allow-listed host. Never whatever the caller asked for.
--
-- Resolution order (see src/utils/emailTemplate.js):
--   1. this setting        appBaseUrl
--   2. env                 APP_BASE_URL, or BASE_URL
--   3. request host        ONLY if listed in TRUSTED_HOSTS, matched exactly
--   4. machine hostname    last resort
--
-- Idempotent — safe to re-run; an existing value is never overwritten.

INSERT INTO public.app_settings (setting_key, setting_value, setting_type, description, category) VALUES
    ('appBaseUrl', '', 'string',
     'Address used for links in outgoing e-mails, e.g. https://rh.masociete.com — leave blank to use APP_BASE_URL, then the server name. Set this to the address your people actually open in a browser.',
     'email')
ON CONFLICT (setting_key) DO NOTHING;
