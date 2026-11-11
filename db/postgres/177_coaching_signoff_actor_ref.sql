-- 177 — a coaching signature records the ACCOUNT that was used.
--
-- coaching_signoffs.user_id carried no type: an employee id for the person
-- coached, and for the coach slot whatever account signed, including an ADMIN
-- id when an administrator signed, in an id space that overlaps the
-- employees'. From this release only the two parties sign (the coach named in
-- coaching_sessions.coach_id, through a linked administration account if need
-- be, and the person coached); user_id is always that PERSON (an employee id),
-- and actor_ref records the account actually used: 'employee:<id>' or
-- 'admin:<id>', the same convention as system_logs.actor_ref.
--
-- Additive and idempotent. Existing signatures are left exactly as they are
-- (actor_ref NULL = signed before this release, account type unknown).
-- Nothing is deleted or rewritten.

ALTER TABLE public.coaching_signoffs ADD COLUMN IF NOT EXISTS actor_ref text;

COMMENT ON COLUMN public.coaching_signoffs.actor_ref IS
    'Account that signed: employee:<id> | admin:<id> (migration 177). NULL = signed before migration 177.';

-- The SQL console reader sees the new column (migration 168).
SELECT public.fn_console_reader_sync();
