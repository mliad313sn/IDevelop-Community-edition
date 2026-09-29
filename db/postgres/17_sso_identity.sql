-- ============================================================================
-- IDevelop — Wave 2: SSO / external-IdP identity linking.
-- Additive & idempotent. Adds the columns that link a local account to an
-- external identity (OIDC `sub` / SAML nameID) per provider, so SSO becomes a
-- configuration flip rather than a schema change. No data is altered.
-- ============================================================================
ALTER TABLE admins    ADD COLUMN IF NOT EXISTS external_id   TEXT;
ALTER TABLE admins    ADD COLUMN IF NOT EXISTS auth_provider TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS external_id   TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS auth_provider TEXT;

-- One external identity per provider maps to at most one local account.
CREATE UNIQUE INDEX IF NOT EXISTS idx_admins_sso_identity
    ON admins(auth_provider, external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_sso_identity
    ON employees(auth_provider, external_id) WHERE external_id IS NOT NULL;
