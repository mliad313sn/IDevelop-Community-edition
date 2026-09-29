-- =====================================================================
-- 59_invitation_tracking.sql — invitation state on the employee record.
--
-- The bulk-invitation console (3.22.35) issued credentials without
-- remembering that it had: "invited, never signed in" was inferred and
-- staleness was invisible. These two columns make the invitation a
-- first-class state:
--
--   invited_at — when credentials were last issued via an invitation
--                (reset on every re-invite; NULL = never invited)
--   invited_by — admins.id who sent it (audit convenience; the full trail
--                stays in system_logs)
--
-- They also power INVITATION EXPIRY: when the `invitationExpiryDays`
-- setting is > 0, a temporary credential that was never used (no login
-- since the invite) stops working after N days — login is refused with a
-- "contact your administrator" message and the console shows the
-- invitation as expired, prompting a re-invite. Additive & idempotent.
-- =====================================================================
BEGIN;

ALTER TABLE employees ADD COLUMN IF NOT EXISTS invited_at timestamptz;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS invited_by bigint;

CREATE INDEX IF NOT EXISTS idx_employees_invited
    ON employees(invited_at) WHERE invited_at IS NOT NULL;

INSERT INTO schema_meta(key, value) VALUES ('59_invitation_tracking', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();

COMMIT;
