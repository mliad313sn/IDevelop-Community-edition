-- ============================================================================
-- Per-profile API keys: bind a key to an OWNER admin so the Power BI / API
-- feeds it powers return only the data that owner's clearance (RBAC scope)
-- allows. owner_admin_id NULL = legacy full-org (system/superadmin) behaviour.
-- Additive & idempotent.
-- ============================================================================
ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS owner_admin_id bigint
    REFERENCES public.admins(id) ON DELETE CASCADE;
ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS expires_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_api_keys_owner ON public.api_keys (owner_admin_id);
