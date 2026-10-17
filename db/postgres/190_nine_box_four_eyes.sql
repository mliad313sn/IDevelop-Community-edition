-- 190 — 9-box four eyes and the authority ladder mode (4.0.0 port, wave 2)
--
--   nineBoxFourEyes    whoever drafted a 9-box placement cannot approve it
--                      (NineBoxService._assertFourEyes); a SuperAdmin may approve
--                      their own draft with a written reason, audited.
--                        NEW install: 'true'.
--                        UPGRADE:     'false', so that no single-manager team
--                                     finds its approvals blocked overnight, and
--                                     every active SuperAdmin gets an in-app
--                                     notice (kind ninebox.four_eyes_off) that
--                                     links to the App Settings.
--   authority.ladder   who may act on a person's record (AuthorityService):
--                      'strict' (today's reach) on new installs and upgrades
--                      alike; 'extended' is a SuperAdmin choice.
--
-- Both are governance-class: editable by a SuperAdmin only
-- (src/utils/securitySettings.js).
--
-- New install vs upgrade, as in migration 162: the migrations of a new install
-- are all applied in one run, so the oldest schema_meta row is minutes old; on
-- an upgrade it is the date of the original install (threshold 6 h).
--
-- Additive and idempotent. A value an administrator chose (updated_by set) is
-- never changed; on an upgrade, a row the application's defaults wrote before
-- this migration ran (updated_by NULL) is set to 'false'. The notice is written
-- once per SuperAdmin. Nothing is deleted.

DO $$
DECLARE
    v_upgrade boolean;
BEGIN
    SELECT COALESCE(MIN(applied_at) < now() - interval '6 hours', false)
      INTO v_upgrade
      FROM schema_meta
     WHERE applied_at IS NOT NULL;

    INSERT INTO app_settings (setting_key, setting_value, setting_type, description, category)
    VALUES ('nineBoxFourEyes',
            CASE WHEN v_upgrade THEN 'false' ELSE 'true' END,
            'boolean',
            'Four eyes on a 9-box placement: whoever drafted it cannot approve it. A SuperAdmin may approve their own draft with a written reason, kept in the audit log.',
            'security')
    ON CONFLICT (setting_key) DO NOTHING;

    IF v_upgrade THEN
        UPDATE app_settings
           SET setting_value = 'false', updated_at = now()
         WHERE setting_key = 'nineBoxFourEyes'
           AND updated_by IS NULL
           AND setting_value <> 'false';

        -- The notice, to every active SuperAdmin, once (title and text are
        -- localised from the kind when shown).
        INSERT INTO notifications (user_type, user_id, channel, kind, locale, payload, state)
        SELECT 'admin',
               a.id,
               'inapp'::notif_channel,
               'ninebox.four_eyes_off',
               'fr',
               jsonb_build_object('link', '/app-settings'),
               'queued'::notif_state
          FROM admins a
         WHERE a.role = 'superadmin'
           AND a.is_active = true
           AND EXISTS (SELECT 1 FROM app_settings s
                        WHERE s.setting_key = 'nineBoxFourEyes' AND s.setting_value = 'false')
           AND NOT EXISTS (SELECT 1 FROM notifications n
                            WHERE n.user_type = 'admin' AND n.user_id = a.id
                              AND n.kind = 'ninebox.four_eyes_off');
    END IF;

    INSERT INTO app_settings (setting_key, setting_value, setting_type, description, category)
    VALUES ('authority.ladder',
            'strict',
            'string',
            'Who may act on a person''s record. strict (default): the direct supervisor and manager, a local administrator in clearance (with the feature permission where one is required) and a SuperAdmin; the line above reads. extended: also the line above, and a local administrator in clearance without the feature permission.',
            'security')
    ON CONFLICT (setting_key) DO NOTHING;
END $$;

-- The SQL console reader stays in step with the schema (migration 168).
SELECT public.fn_console_reader_sync();
