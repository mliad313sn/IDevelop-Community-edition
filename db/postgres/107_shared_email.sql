-- 107_shared_email.sql
-- One e-mail address may belong to SEVERAL accounts.
--
-- PRODUCT RULE (user, 2026-09-09): a person can legitimately hold two or more
-- accounts — an employee record and an admin account, two employee records
-- across entities, a shared departmental mailbox — so an e-mail address is
-- contact information, NOT an identity key. Creating or editing an account
-- whose address is already in use is ALLOWED; the screen simply ADVISES that
-- the address exists on other accounts (EmailAccountsService), so a genuine
-- duplicate person is still noticed by whoever is typing.
--
-- WHAT CHANGES
--   * admins_email_key (UNIQUE (email), base schema) is dropped. employees.email
--     never carried a unique constraint — the rule was enforced in code only.
--   * Non-unique lower(email) indexes on both tables: every lookup by address
--     (login by e-mail, password reset, SSO first-time match, invitations,
--     LMS completions) now has to consider several rows, and does so through
--     an index rather than a scan.
--
-- WHAT DOES NOT CHANGE
--   * Usernames stay unique across employees AND admins (the login key).
--   * Flows that identify a person BY e-mail refuse ambiguity rather than
--     guessing: login by address, SSO auto-link and LMS completion matching
--     require exactly one account; the self-service password reset sends one
--     link per account instead.
--   * onboarding_requests keeps "one PENDING request per address".
--
-- Idempotent: DROP CONSTRAINT IF EXISTS + CREATE INDEX IF NOT EXISTS + stamp.

BEGIN;

ALTER TABLE public.admins DROP CONSTRAINT IF EXISTS admins_email_key;

CREATE INDEX IF NOT EXISTS idx_admins_email_lower    ON public.admins    (lower(email));
CREATE INDEX IF NOT EXISTS idx_employees_email_lower ON public.employees (lower(email));

COMMENT ON COLUMN public.admins.email IS
    'Contact address — NOT unique since migration 107: a person may hold several accounts. Identity keys are username / external_id.';
COMMENT ON COLUMN public.employees.email IS
    'Contact address — NOT unique (a person may hold several accounts, migration 107). Identity keys are username / employee_number / external_id.';

INSERT INTO schema_meta(key, value) VALUES ('107_shared_email', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();

COMMIT;
