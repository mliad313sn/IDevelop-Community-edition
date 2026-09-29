-- 49_user_identities.sql — multiple authentication methods per user + password
-- deactivation, and the audit surface for JIT privilege elevation.
--
-- WHY: the inline admins/employees.auth_provider+external_id columns (migration 17)
-- hold ONE external identity per account. This normalized table lets a single
-- person accumulate SEVERAL enterprise identities (e.g. O365 today, Okta later)
-- without schema churn, and keeps credentials decoupled from the profile. Reads
-- consult this table first, then fall back to the inline columns, so nothing
-- breaks during/after the transition. Additive & idempotent; no data lost.

-- 1) Decoupled identity mappings → the preserved internal account id.
CREATE TABLE IF NOT EXISTS user_identities (
    id            bigserial PRIMARY KEY,
    subject_type  text NOT NULL CHECK (subject_type IN ('admin','employee')),
    subject_id    bigint NOT NULL,
    sso_provider  text NOT NULL,                 -- 'entra' | 'oidc' | 'saml' | 'google' | …
    sso_uid       text NOT NULL,                 -- OIDC sub / Entra oid / SAML nameID
    email         text,                          -- email asserted at link time (audit)
    is_primary    boolean NOT NULL DEFAULT false,
    linked_by     bigint,                        -- admin id who executed the link (NULL = self/auto)
    linked_at     timestamptz NOT NULL DEFAULT now(),
    -- One external identity maps to at most one local account, globally.
    UNIQUE (sso_provider, sso_uid)
);
CREATE INDEX IF NOT EXISTS idx_user_identities_subject
    ON user_identities(subject_type, subject_id);

-- 2) Password deactivation: after a merge, route sign-in through the IdP by
--    disabling local password auth (the hash is retained but refused).
ALTER TABLE admins    ADD COLUMN IF NOT EXISTS password_disabled boolean NOT NULL DEFAULT false;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS password_disabled boolean NOT NULL DEFAULT false;

-- 3) Backfill from the inline columns so existing SSO links appear as identities.
INSERT INTO user_identities (subject_type, subject_id, sso_provider, sso_uid, is_primary)
SELECT 'admin', id, auth_provider, external_id, true
  FROM admins
 WHERE auth_provider IS NOT NULL AND external_id IS NOT NULL
ON CONFLICT (sso_provider, sso_uid) DO NOTHING;

INSERT INTO user_identities (subject_type, subject_id, sso_provider, sso_uid, is_primary)
SELECT 'employee', id, auth_provider, external_id, true
  FROM employees
 WHERE auth_provider IS NOT NULL AND external_id IS NOT NULL
ON CONFLICT (sso_provider, sso_uid) DO NOTHING;

INSERT INTO schema_meta(key, value) VALUES ('49_user_identities', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();
