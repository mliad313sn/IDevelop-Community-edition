-- 48_account_linking.sql — account identity linking & privilege promotion.
-- Supports two operator scenarios (see AccountLinkService):
--   1) MERGE a pre-existing LOCAL account with an incoming SSO/Entra identity so a
--      person ends up with ONE account (the SSO identity is attached to the local
--      account via the existing admins/employees.auth_provider+external_id columns
--      from 17_sso_identity.sql — no new column needed for the merge itself).
--   2) PROMOTE an employee to an admin ("grant admin access") — a linked admin
--      account is created for that person. `linked_employee_id` records which
--      employee an admin account was promoted from, so the grant is visible and
--      revocable, and so we never create two admin accounts for one employee.
-- Additive & idempotent. No data is altered.

ALTER TABLE admins ADD COLUMN IF NOT EXISTS linked_employee_id INTEGER
    REFERENCES employees(id) ON DELETE SET NULL;

-- At most one admin account per source employee (partial: only rows that link).
CREATE UNIQUE INDEX IF NOT EXISTS idx_admins_linked_employee
    ON admins(linked_employee_id) WHERE linked_employee_id IS NOT NULL;

INSERT INTO schema_meta(key, value) VALUES ('48_account_linking', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();
