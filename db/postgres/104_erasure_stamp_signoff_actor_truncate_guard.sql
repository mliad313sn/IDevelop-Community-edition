-- (security / id-space / deactivation cascade). Idempotent: safe to re-run.
--
-- 1. employees.erased_at — stamped by DSRService.erase. A GDPR-erased subject
--    was indistinguishable from an ordinary leaver (is_active = false and a
--    pseudonymised name), so every reactivation path — SCIM PATCH active:true,
--    the leaver revert, the SuperAdmin reactivate toggle — could put "Erased 84"
--    back into the headcount AND back behind a login. Reproduced by rolled-back
--    probe: after erase + SCIM active:true the row read is_active=true,
--    is_account_active=true, first_name='Erased'. The stamp is the fact the
--    reactivation guards test; it is never cleared.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS erased_at timestamptz;
COMMENT ON COLUMN employees.erased_at IS
    'Set by DSRService.erase (right-to-erasure). Irreversible: no reactivation path may set is_active or is_account_active back to true while this is non-NULL.';
CREATE INDEX IF NOT EXISTS idx_employees_erased_at ON employees (erased_at) WHERE erased_at IS NOT NULL;

-- 2. idp_signoffs.user_type — admin ids and employee ids overlap (admins 1-283,
--    employees 84-68963; admin 87 IS employee 87 today), and the sign-off row
--    stored only user_id. This change makes IDPService.signOff write/read this column;
--    the default keeps every existing row and every caller that does not yet
--    pass it meaning what it always meant (an employee-side signature).
ALTER TABLE idp_signoffs ADD COLUMN IF NOT EXISTS user_type text NOT NULL DEFAULT 'employee';
ALTER TABLE idp_signoffs DROP CONSTRAINT IF EXISTS chk_idp_signoffs_user_type;
ALTER TABLE idp_signoffs ADD CONSTRAINT chk_idp_signoffs_user_type
    CHECK (user_type IN ('employee', 'manager', 'admin'));

-- 3. TRUNCATE guard on the append-only tables: block_mutation is a ROW trigger
--    and TRUNCATE fires none (reproduced: `TRUNCATE system_logs` 6108 -> 0 rows,
--    rolled back). Migration 101 (append_only_truncate_guard) adds the BEFORE
--    TRUNCATE statement trigger on all three append-only tables — system_logs,
--    assessment_history AND review_signatures — so nothing is left to cover here.
