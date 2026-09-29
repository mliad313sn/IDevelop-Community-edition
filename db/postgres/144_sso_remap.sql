-- 144 — SSO migration: bulk remap of existing accounts onto SSO identities
--
-- When an organisation moves to single sign-on, every existing employee must
-- land on THEIR account at their first SSO sign-in — not in the onboarding
-- queue, and never as a duplicate. The IdP's stable id (Entra objectId, or the
-- per-app OIDC `sub`) is either unknown in advance or not what an admin holds,
-- so the console does not write identities directly: it records a PENDING
-- mapping (employee <- expected objectId / UPN / employeeId) that is CLAIMED
-- by the first SIGNED sign-in presenting a matching claim. Only then does a
-- user_identities row exist.
--
--   sso_remap_batches  one row per uploaded file (dry run or apply), with its
--                      sha256 so an apply can only follow the preview it matches
--   sso_remap_rows     per-row outcome with its reason — nothing is skipped
--                      silently, and the counts always add up to the file
--   sso_pending_links  the mapping itself; one open mapping per employee and
--                      per key; consumed (bound) exactly once, or cancelled
--
-- EMPLOYEES ONLY: administrators sign in with password + MFA by policy
-- (SsoController refuses SSO for an admin), so no mapping may target one.
-- Additive and idempotent.

CREATE TABLE IF NOT EXISTS sso_remap_batches (
    id             bigserial PRIMARY KEY,
    provider       text        NOT NULL,
    mode           text        NOT NULL,
    status         text        NOT NULL,
    dry_run_of     bigint      REFERENCES sso_remap_batches(id),
    source_name    text,
    source_sha256  text        NOT NULL,
    row_count      integer     NOT NULL DEFAULT 0,
    summary        jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_by     bigint      NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    applied_at     timestamptz,
    reverted_at    timestamptz,
    reverted_by    bigint,
    revert_reason  text,
    CONSTRAINT chk_sso_remap_batch_mode   CHECK (mode IN ('dry_run', 'apply')),
    CONSTRAINT chk_sso_remap_batch_status CHECK (status IN ('previewed', 'applied', 'reverted'))
);

CREATE TABLE IF NOT EXISTS sso_remap_rows (
    id            bigserial PRIMARY KEY,
    batch_id      bigint  NOT NULL REFERENCES sso_remap_batches(id) ON DELETE CASCADE,
    row_no        integer NOT NULL,
    input         jsonb   NOT NULL DEFAULT '{}'::jsonb,
    match_key     text,
    employee_id   bigint,
    outcome       text    NOT NULL,
    reason        text,
    pending_id    bigint,
    CONSTRAINT uq_sso_remap_row UNIQUE (batch_id, row_no),
    CONSTRAINT chk_sso_remap_row_key CHECK (match_key IS NULL OR match_key IN ('employee_number', 'email', 'upn', 'manual'))
);
CREATE INDEX IF NOT EXISTS idx_sso_remap_rows_batch ON sso_remap_rows (batch_id);

CREATE TABLE IF NOT EXISTS sso_pending_links (
    id                 bigserial PRIMARY KEY,
    provider           text        NOT NULL,
    employee_id        bigint      NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    match_object_id    text,
    match_upn          text,
    match_employee_id  text,
    batch_id           bigint      REFERENCES sso_remap_batches(id),
    status             text        NOT NULL DEFAULT 'pending',
    bound_uid          text,
    bound_at           timestamptz,
    cancelled_at       timestamptz,
    cancelled_by       bigint,
    created_by         bigint      NOT NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_sso_pending_status CHECK (status IN ('pending', 'bound', 'cancelled')),
    -- A mapping must carry at least one key a sign-in can present.
    CONSTRAINT chk_sso_pending_has_key CHECK (
        match_object_id IS NOT NULL OR match_upn IS NOT NULL OR match_employee_id IS NOT NULL),
    -- Keys are stored normalised (trimmed, lower-case) so a lookup is exact.
    CONSTRAINT chk_sso_pending_norm CHECK (
        (match_object_id IS NULL OR match_object_id = lower(btrim(match_object_id)))
        AND (match_upn IS NULL OR match_upn = lower(btrim(match_upn)))
        AND (match_employee_id IS NULL OR match_employee_id = lower(btrim(match_employee_id))))
);

-- One OPEN mapping per employee per provider, and no key open on two people.
CREATE UNIQUE INDEX IF NOT EXISTS ux_sso_pending_employee
    ON sso_pending_links (provider, employee_id) WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS ux_sso_pending_oid
    ON sso_pending_links (provider, match_object_id) WHERE status = 'pending' AND match_object_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_sso_pending_upn
    ON sso_pending_links (provider, match_upn) WHERE status = 'pending' AND match_upn IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_sso_pending_empid
    ON sso_pending_links (provider, match_employee_id) WHERE status = 'pending' AND match_employee_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sso_pending_batch ON sso_pending_links (batch_id);

-- "Signed in via SSO" must be MEASURED, not inferred from "has a link": the
-- readiness view reads this, stamped by the SSO sign-in path only.
ALTER TABLE user_identities ADD COLUMN IF NOT EXISTS last_used_at timestamptz;
