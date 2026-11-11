-- 162 — Authentication security defaults (two-factor policy, session timeouts)
--
--   mfaRequiredForPrivileged ON: every administrator role (HR-wide viewers
--       included) must enrol in two-factor authentication.
--   mfaRequiredForManagers ON: managers who sign in with a local password too
--       (a manager session opened through SSO satisfies it with the IdP's MFA).
--   Grace on UPGRADE only: mfaGraceStartedAt = the upgrade instant; admins get
--       mfaGraceAdminDays (14), managers mfaGraceManagerDays (30), with a
--       countdown at each sign-in; afterwards enrolment is forced. A NEW
--       install has no start date: enforced from the first sign-in.
--       (SuperAdmins are unchanged: MFA always, no grace.)
--   Session defaults (ASVS 3.3.2): idle 30 min, absolute 12 h. An upgrade moves
--       a value ONLY when it still holds the old default (sessionIdleMinutes 60,
--       sessionTimeout 24); a value an administrator chose is kept.
--
-- New install vs upgrade: the migrations of a new install are all applied in
-- one run, so the oldest schema_meta row is minutes old; on an upgrade it is
-- the date of the original install. The threshold (6 h) is generous for a slow
-- first install.
--
-- Additive and idempotent: the grace-start row is this migration's own marker,
-- so every UPDATE runs only on the first run; a re-run changes nothing and never
-- overrides a value an administrator set afterwards. Nothing is deleted. The
-- values are the strings 'true' / '14', as migration 159 expects.

DO $$
DECLARE
    v_upgrade boolean;
    v_first   boolean;
BEGIN
    SELECT COALESCE(MIN(applied_at) < now() - interval '6 hours', false)
      INTO v_upgrade
      FROM schema_meta
     WHERE applied_at IS NOT NULL;
    -- First run of this migration? (the grace-start row is its own marker)
    v_first := NOT EXISTS (SELECT 1 FROM app_settings WHERE setting_key = 'mfaGraceStartedAt');

    -- ---- Two-factor policy switches --------------------------------------------
    INSERT INTO app_settings (setting_key, setting_value, setting_type, description, category)
    VALUES ('mfaRequiredForPrivileged', 'true', 'boolean',
            'Require two-factor authentication for every administrator role (HR-wide viewers included). Upgrades: grace period of mfaGraceAdminDays from the upgrade, then enrolment is forced.',
            'security')
    ON CONFLICT (setting_key) DO NOTHING;

    INSERT INTO app_settings (setting_key, setting_value, setting_type, description, category)
    VALUES ('mfaRequiredForManagers', 'true', 'boolean',
            'Require two-factor authentication for managers who sign in with a local password (managers signing in through SSO use their organisation''s MFA). Upgrades: grace period of mfaGraceManagerDays.',
            'security')
    ON CONFLICT (setting_key) DO NOTHING;

    INSERT INTO app_settings (setting_key, setting_value, setting_type, description, category)
    VALUES ('mfaGraceAdminDays', '14', 'number',
            'Upgrade grace period (days) before two-factor enrolment is forced for administrators.',
            'security')
    ON CONFLICT (setting_key) DO NOTHING;

    INSERT INTO app_settings (setting_key, setting_value, setting_type, description, category)
    VALUES ('mfaGraceManagerDays', '30', 'number',
            'Upgrade grace period (days) before two-factor enrolment is forced for managers with a local password.',
            'security')
    ON CONFLICT (setting_key) DO NOTHING;

    -- The grace start: the upgrade instant on an upgrade, empty on a new install.
    -- Written once (DO NOTHING on conflict): a re-run never restarts the clock.
    INSERT INTO app_settings (setting_key, setting_value, setting_type, description, category)
    VALUES ('mfaGraceStartedAt',
            CASE WHEN v_upgrade
                 THEN to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
                 ELSE '' END,
            'string',
            'When the two-factor grace period started (set by the upgrade that introduced the policy; empty = no grace, new install).',
            'security')
    ON CONFLICT (setting_key) DO NOTHING;

    IF v_first THEN
        -- The policy switches ON for new installs AND upgrades (migration 14
        -- seeded 'false'). On an upgrade the grace period above is what keeps
        -- sign-ins working while people enrol.
        UPDATE app_settings SET setting_value = 'true', updated_at = now()
         WHERE setting_key = 'mfaRequiredForPrivileged'
           AND lower(COALESCE(setting_value, '')) NOT IN ('true', '1');
    END IF;

    -- ---- Session defaults, only where the old default is untouched -------------
    INSERT INTO app_settings (setting_key, setting_value, setting_type, description, category)
    VALUES ('sessionIdleMinutes', '30', 'number',
            'Sign users out after this many minutes of inactivity (applies to admins and employees; takes effect immediately)',
            'security')
    ON CONFLICT (setting_key) DO NOTHING;
    UPDATE app_settings SET setting_value = '30', updated_at = now()
     WHERE v_first AND setting_key = 'sessionIdleMinutes'
       AND btrim(COALESCE(setting_value, '')) = '60';

    INSERT INTO app_settings (setting_key, setting_value, setting_type, description, category)
    VALUES ('sessionTimeout', '12', 'number',
            'Absolute session lifetime in hours - a session older than this is signed out even while active (applies to new requests immediately; SESSION_MAX_HOURS is the fallback)',
            'security')
    ON CONFLICT (setting_key) DO NOTHING;
    UPDATE app_settings SET setting_value = '12', updated_at = now()
     WHERE v_first AND setting_key = 'sessionTimeout'
       AND btrim(COALESCE(setting_value, '')) = '24';
END
$$;
