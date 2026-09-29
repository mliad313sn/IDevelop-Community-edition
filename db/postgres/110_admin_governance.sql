-- 110_admin_governance.sql — Admin accounts & access governance.
--
-- Rule 3 of the programme: a deactivation is a STATE plus a REASON, never a
-- delete. "Supprimer" on an admin used to hard-delete its grant and scope rows
--: reactivating the person restored a login with no capability
-- and no perimeter — exactly the "scoped but powerless" defect the triage screen
-- exists to catch. Four additive, idempotent changes:
--
--   1. admin_permissions / admin_scopes gain `revoked_at` + `revoke_reason`.
--      A row with revoked_at set confers NOTHING (every authority read filters
--      it out) but stays on the account so "Réactiver" restores the previous
--      perimeter instead of asking the operator to rebuild it from memory.
--   2. admins gain `deactivated_at / deactivated_by / deactivation_reason`, so
--      is_active = false can say WHO, WHEN and WHY (mirrors employees.cancelled_*
--      from migration 99). deactivated_by carries no FK on purpose: the record
--      must outlive the account that performed the action.
--   3. admin_access_events gains `source` ('ledger' = written live, 'backfill' =
--      reconstructed below) and a one-off PROVENANCE BACKFILL: every live
--      grant predating the ledger gets one `grant` event derived from the
--      ADMIN_CREATED / ADMIN_UPDATED / ADMIN_REACTIVATED system_logs entry that
--      names the slug in its details ("… perms: a, b, c …"). Where no such entry
--      exists the grant stays without an event and the UI labels it
--      "origine inconnue (avant journal)" rather than inventing an author.
--   4. The two lockout tunables become App Settings: `maxLoginAttempts`
--      (already seeded by the model) and `loginLockoutMinutes`. The rows are
--      seeded here; the Settings screen renders them; the login guard
--      reads them with the env variables as fallback.

-- 1) Revocation flags on the grant tables ----------------------------------------
ALTER TABLE public.admin_permissions ADD COLUMN IF NOT EXISTS revoked_at    timestamptz;
ALTER TABLE public.admin_permissions ADD COLUMN IF NOT EXISTS revoke_reason text;
ALTER TABLE public.admin_scopes      ADD COLUMN IF NOT EXISTS revoked_at    timestamptz;
ALTER TABLE public.admin_scopes      ADD COLUMN IF NOT EXISTS revoke_reason text;

-- A revoked row must carry its reason — both or neither.
ALTER TABLE public.admin_permissions DROP CONSTRAINT IF EXISTS chk_admin_permissions_revoke_complete;
ALTER TABLE public.admin_permissions ADD CONSTRAINT chk_admin_permissions_revoke_complete
    CHECK ((revoked_at IS NULL AND revoke_reason IS NULL)
        OR (revoked_at IS NOT NULL AND length(btrim(revoke_reason)) > 0));
ALTER TABLE public.admin_scopes DROP CONSTRAINT IF EXISTS chk_admin_scopes_revoke_complete;
ALTER TABLE public.admin_scopes ADD CONSTRAINT chk_admin_scopes_revoke_complete
    CHECK ((revoked_at IS NULL AND revoke_reason IS NULL)
        OR (revoked_at IS NOT NULL AND length(btrim(revoke_reason)) > 0));

-- Revoked rows are the minority and are only ever queried as "show me the
-- revoked ones" (reactivation, review), so partial indexes are the right shape.
CREATE INDEX IF NOT EXISTS idx_admin_permissions_revoked ON public.admin_permissions (admin_id) WHERE revoked_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_admin_scopes_revoked      ON public.admin_scopes (admin_id)      WHERE revoked_at IS NOT NULL;

COMMENT ON COLUMN public.admin_permissions.revoked_at IS
    'Set by "Désactiver": the grant confers nothing while set, and is restored (NULL) by "Réactiver". Never deleted.';
COMMENT ON COLUMN public.admin_scopes.revoked_at IS
    'Set by "Désactiver": the scope confers nothing while set, and is restored (NULL) by "Réactiver". Never deleted.';

-- 2) Why an admin account is inactive --------------------------------------------
ALTER TABLE public.admins ADD COLUMN IF NOT EXISTS deactivated_at      timestamptz;
ALTER TABLE public.admins ADD COLUMN IF NOT EXISTS deactivated_by      bigint;
ALTER TABLE public.admins ADD COLUMN IF NOT EXISTS deactivation_reason text;

ALTER TABLE public.admins DROP CONSTRAINT IF EXISTS chk_admins_deactivation_complete;
ALTER TABLE public.admins ADD CONSTRAINT chk_admins_deactivation_complete
    CHECK ((deactivated_at IS NULL AND deactivation_reason IS NULL)
        OR (deactivated_at IS NOT NULL AND length(btrim(deactivation_reason)) > 0));

COMMENT ON COLUMN public.admins.deactivation_reason IS
    'Mandatory justification captured by "Désactiver"; cleared by "Réactiver" (the ledger keeps the history).';

-- 3) Ledger provenance: source column + one-off backfill ---------------------------
ALTER TABLE public.admin_access_events ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'ledger';
CREATE INDEX IF NOT EXISTS idx_admin_access_events_slug
    ON public.admin_access_events (admin_id, slug, created_at DESC);

-- One `grant` event per live grant row that has none, derived from the MOST
-- RECENT admin-management log line naming that slug. details is jsonb (a JSON
-- string for these actions), so it is read as text; the regexp isolates the
-- "perms: a, b, c" list and the slug must be one of its members. Re-runnable:
-- the NOT EXISTS makes a second pass insert nothing.
INSERT INTO public.admin_access_events
    (admin_id, change_type, slug, effective_from, effective_to, actor_admin_id, reason, created_at, source)
SELECT ap.admin_id,
       'grant',
       ap.permission,
       sl.created_at,
       ap.expires_at,
       sl.admin_id,
       'backfill: system_logs #' || sl.id || ' (' || sl.action || ') — migration 110',
       sl.created_at,
       'backfill'
  FROM public.admin_permissions ap
  JOIN LATERAL (
        SELECT s.id, s.admin_id, s.action, s.created_at
          FROM public.system_logs s
         WHERE s.entity_type = 'admin'
           AND s.entity_id::text = ap.admin_id::text
           AND s.action IN ('ADMIN_CREATED', 'ADMIN_UPDATED', 'ADMIN_REACTIVATED', 'ADMIN_REACTIVATED_AFTER_ERROR')
           AND COALESCE(s.details::text, '') ~ 'perms: '
           AND ap.permission = ANY (string_to_array(
                   regexp_replace(s.details::text, '^.*perms: ([a-z0-9_, ]+).*$', '\1'), ', '))
         ORDER BY s.created_at DESC
         LIMIT 1
       ) sl ON true
 WHERE NOT EXISTS (
        SELECT 1 FROM public.admin_access_events ev
         WHERE ev.admin_id = ap.admin_id AND ev.slug = ap.permission AND ev.change_type = 'grant');

-- 4) Lockout tunables as App Settings (rows only; the UI is the settings screen) --
INSERT INTO public.app_settings (setting_key, setting_value, setting_type, description, category)
SELECT 'maxLoginAttempts', '5', 'number',
       'Failed sign-in attempts (per account, within the lockout window) before the account is locked. Env fallback: LOGIN_RATE_LIMIT.',
       'security'
 WHERE NOT EXISTS (SELECT 1 FROM public.app_settings WHERE setting_key = 'maxLoginAttempts');

INSERT INTO public.app_settings (setting_key, setting_value, setting_type, description, category)
SELECT 'loginLockoutMinutes', '30', 'number',
       'Minutes an account stays locked after too many failed sign-ins (also the window in which failures are counted). Env fallback: LOGIN_LOCKOUT_DURATION. Takes effect without restart.',
       'security'
 WHERE NOT EXISTS (SELECT 1 FROM public.app_settings WHERE setting_key = 'loginLockoutMinutes');

INSERT INTO schema_meta(key, value) VALUES ('110_admin_governance', 'applied')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();
