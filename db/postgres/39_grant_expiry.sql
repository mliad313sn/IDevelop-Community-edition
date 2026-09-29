-- 39_grant_expiry.sql — time-bound admin delegation.
-- Optional expiry on permission grants and org-unit scopes so a delegation can be
-- temporary (cover-for-leave, contractor, audit window). NULL = permanent.
-- Additive & idempotent. Expired rows are ignored at read time (see the models),
-- and can be pruned by the cleanup service.

ALTER TABLE admin_permissions ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE admin_scopes      ADD COLUMN IF NOT EXISTS expires_at timestamptz;

-- Composite indexes so the per-admin lookup filtering on expiry stays cheap.
-- (A partial index can't use now — it isn't IMMUTABLE — so index the column.)
CREATE INDEX IF NOT EXISTS idx_admin_permissions_admin_expiry
    ON admin_permissions(admin_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_admin_scopes_admin_expiry
    ON admin_scopes(admin_id, expires_at);

INSERT INTO schema_meta(key, value) VALUES ('39_grant_expiry', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();
