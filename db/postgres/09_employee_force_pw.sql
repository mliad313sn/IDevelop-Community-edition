-- Force-first-login password change for employees (parity with admins).
ALTER TABLE employees ADD COLUMN IF NOT EXISTS force_password_change BOOLEAN NOT NULL DEFAULT false;

INSERT INTO schema_meta(key, value) VALUES ('09_employee_force_pw', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();
