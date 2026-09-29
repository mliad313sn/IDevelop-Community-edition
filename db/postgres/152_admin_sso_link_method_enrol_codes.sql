-- 152 — Admin SSO hardening
--
--   user_identities.link_method   HOW an identity came to be linked. Admin
--                                 access through SSO (the identity on the
--                                 admin itself, or the linked person's) is
--                                 offered only for 'superadmin_link' and
--                                 'onboarding_merge' — never for an identity
--                                 that was matched by e-mail or claimed from a
--                                 migration mapping, and not for rows whose
--                                 origin is unknown until a SuperAdmin confirms
--                                 them (« Confirmer cette identité … »).
--       values: superadmin_link | delegated_link | onboarding_merge | sso_email
--               | migration_mapping | legacy | unknown
--   admin_mfa_enrol_codes         ONE-TIME enrolment codes a SuperAdmin issues so
--                                 an administrator with no second factor may
--                                 sign in by SSO once and enrol TOTP. Stored as
--                                 a SHA-256 hash, 24 h expiry, single use,
--                                 5 wrong attempts max. Rows are never deleted
--                                 (used_at / revoked_at are the states).
--   app_settings 'sso.mfaAcrValues'  optional comma list of acr /
--                                 AuthnContextClassRef values the operator's IdP
--                                 uses for multi-factor sign-in.
--
-- Additive and idempotent. Nothing is deleted.

ALTER TABLE user_identities ADD COLUMN IF NOT EXISTS link_method text NOT NULL DEFAULT 'unknown';

-- Rows written by a claimed SSO-migration mapping (migration 144) are known.
UPDATE user_identities ui
   SET link_method = 'migration_mapping'
 WHERE ui.link_method = 'unknown'
   AND EXISTS (SELECT 1 FROM sso_pending_links pl
                WHERE pl.status = 'bound'
                  AND pl.provider = ui.sso_provider
                  AND pl.bound_uid = ui.sso_uid);

CREATE TABLE IF NOT EXISTS admin_mfa_enrol_codes (
    id           bigserial   PRIMARY KEY,
    admin_id     integer     NOT NULL REFERENCES admins(id),
    code_hash    text        NOT NULL,
    expires_at   timestamptz NOT NULL,
    used_at      timestamptz,
    revoked_at   timestamptz,
    attempts     integer     NOT NULL DEFAULT 0,
    created_by   integer,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_admin_mfa_enrol_codes_live
    ON admin_mfa_enrol_codes (admin_id) WHERE used_at IS NULL AND revoked_at IS NULL;

INSERT INTO app_settings (setting_key, setting_value, setting_type, description, category)
VALUES ('sso.mfaAcrValues', '', 'string',
        'Optional comma-separated acr / AuthnContextClassRef values that your identity provider uses for a multi-factor sign-in (in addition to the built-in Entra multipleauthn and SAML MultiFactor values).',
        'sso')
ON CONFLICT (setting_key) DO NOTHING;
