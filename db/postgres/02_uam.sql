-- Phase 2 — UAM: Regions, Countries, MFA, Maker-Checker, extended admin roles & scopes.
-- IMPORTANT: ALTER TYPE … ADD VALUE must commit BEFORE the new value is used.
-- The enum-extension statements below run outside the main transaction.

ALTER TYPE admin_role ADD VALUE IF NOT EXISTS 'regional_admin';
ALTER TYPE admin_role ADD VALUE IF NOT EXISTS 'country_admin';
ALTER TYPE admin_role ADD VALUE IF NOT EXISTS 'site_admin';
ALTER TYPE admin_role ADD VALUE IF NOT EXISTS 'hr_bp';

-- Legacy localadmin → site_admin is a data-migration concern handled in
--   scripts/phase2-rename-localadmin.sql (kept manual to avoid surprises).

ALTER TYPE admin_scope_type ADD VALUE IF NOT EXISTS 'region';
ALTER TYPE admin_scope_type ADD VALUE IF NOT EXISTS 'country';

-- ↑ enum additions outside any transaction (each statement auto-commits).
BEGIN;

-- ---------------------------------------------------------------------------
-- Region / Country hierarchy
-- ---------------------------------------------------------------------------

CREATE TABLE regions (
    id          BIGSERIAL PRIMARY KEY,
    code        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    is_active   BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE countries (
    id          BIGSERIAL PRIMARY KEY,
    region_id   BIGINT NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
    code        TEXT NOT NULL UNIQUE,  -- ISO-3166 alpha-2 or alpha-3
    name        TEXT NOT NULL,
    is_active   BOOLEAN NOT NULL DEFAULT true,
    -- per-country DSR SLA in days (defaults to 30 per WA statutes)
    dsr_sla_days INTEGER NOT NULL DEFAULT 30,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_regions_updated_at   BEFORE UPDATE ON regions   FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_countries_updated_at BEFORE UPDATE ON countries FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE sites ADD COLUMN country_id BIGINT REFERENCES countries(id) ON DELETE RESTRICT;
CREATE INDEX idx_sites_country_id ON sites (country_id);

ALTER TABLE admin_scopes ADD COLUMN region_id  BIGINT REFERENCES regions(id)   ON DELETE CASCADE;
ALTER TABLE admin_scopes ADD COLUMN country_id BIGINT REFERENCES countries(id) ON DELETE CASCADE;

-- Replace the V1 CHECK that only covered site/dept/service with one that
-- also accepts region / country.
-- NB: scope_type is compared as ::text on purpose. The runner applies each
-- migration file inside one transaction, and PostgreSQL forbids USING a value
-- added by ALTER TYPE ... ADD VALUE (region/country, just above) within that
-- same transaction ("unsafe use of new value"). Comparing the column cast to
-- text never references the enum value, so the constraint is valid even on a
-- fresh single-transaction migration run.
ALTER TABLE admin_scopes DROP CONSTRAINT IF EXISTS admin_scopes_check;
ALTER TABLE admin_scopes ADD CONSTRAINT admin_scopes_check CHECK (
    (scope_type::text = 'region'     AND region_id     IS NOT NULL AND country_id IS NULL AND site_id IS NULL AND department_id IS NULL AND service_id IS NULL) OR
    (scope_type::text = 'country'    AND country_id    IS NOT NULL AND region_id  IS NULL AND site_id IS NULL AND department_id IS NULL AND service_id IS NULL) OR
    (scope_type::text = 'site'       AND site_id       IS NOT NULL AND region_id  IS NULL AND country_id IS NULL AND department_id IS NULL AND service_id IS NULL) OR
    (scope_type::text = 'department' AND department_id IS NOT NULL AND region_id  IS NULL AND country_id IS NULL AND site_id IS NULL AND service_id IS NULL) OR
    (scope_type::text = 'service'    AND service_id    IS NOT NULL AND region_id  IS NULL AND country_id IS NULL AND site_id IS NULL AND department_id IS NULL)
);

CREATE INDEX idx_admin_scopes_region_id  ON admin_scopes (region_id);
CREATE INDEX idx_admin_scopes_country_id ON admin_scopes (country_id);

-- ---------------------------------------------------------------------------
-- MFA / TOTP
-- ---------------------------------------------------------------------------

CREATE TYPE mfa_user_type AS ENUM ('admin', 'employee');

CREATE TABLE mfa_secrets (
    id            BIGSERIAL PRIMARY KEY,
    user_type     mfa_user_type NOT NULL,
    user_id       BIGINT NOT NULL,            -- admins.id OR employees.id
    secret_enc    BYTEA NOT NULL,             -- encrypted with app-level key
    algo          TEXT NOT NULL DEFAULT 'SHA1',
    digits        SMALLINT NOT NULL DEFAULT 6,
    period_sec    SMALLINT NOT NULL DEFAULT 30,
    confirmed_at  TIMESTAMPTZ,                -- becomes NOT NULL after first valid verify
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_type, user_id)
);

CREATE TABLE mfa_backup_codes (
    id          BIGSERIAL PRIMARY KEY,
    user_type   mfa_user_type NOT NULL,
    user_id     BIGINT NOT NULL,
    code_hash   TEXT NOT NULL,                -- bcrypt of a one-time code
    used_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_mfa_backup_codes_user ON mfa_backup_codes (user_type, user_id);

-- ---------------------------------------------------------------------------
-- Maker-Checker queue
-- ---------------------------------------------------------------------------

CREATE TYPE mc_state AS ENUM ('pending', 'approved', 'rejected', 'applied', 'failed', 'cancelled');

CREATE TABLE maker_checker_requests (
    id            BIGSERIAL PRIMARY KEY,
    kind          TEXT NOT NULL,                       -- 'admin.reset_password', 'scope.assign', 'catalog.apply', 'pip.create', ...
    payload       JSONB NOT NULL,
    maker_id      BIGINT NOT NULL REFERENCES admins(id) ON DELETE RESTRICT,
    checker_id    BIGINT REFERENCES admins(id) ON DELETE RESTRICT,
    state         mc_state NOT NULL DEFAULT 'pending',
    reason        TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at    TIMESTAMPTZ,
    applied_at    TIMESTAMPTZ,
    error         TEXT,
    CHECK (maker_id <> checker_id)
);

CREATE INDEX idx_mc_state ON maker_checker_requests (state);
CREATE INDEX idx_mc_kind  ON maker_checker_requests (kind);
CREATE INDEX idx_mc_maker ON maker_checker_requests (maker_id);

-- ---------------------------------------------------------------------------
-- Schema metadata bump
-- ---------------------------------------------------------------------------

INSERT INTO schema_meta(key, value) VALUES ('02_uam', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();

COMMIT;
