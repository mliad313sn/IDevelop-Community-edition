-- Deterministic seed for CI / smoke tests (DB_DRIVER=pg only).
-- Idempotent: ON CONFLICT DO NOTHING everywhere.
-- 1 super-admin, 1 site, 1 dept, 1 service, 2 roles, 3 skills, 3 employees.

BEGIN;

INSERT INTO sites (id, name, code) VALUES (1, 'Stonebridge', 'SB') ON CONFLICT (id) DO NOTHING;
INSERT INTO departments (id, site_id, name, code) VALUES (1, 1, 'Mining', 'MIN') ON CONFLICT (id) DO NOTHING;
INSERT INTO services (id, department_id, name, code) VALUES (1, 1, 'Open Pit', 'OP') ON CONFLICT (id) DO NOTHING;

INSERT INTO domains (id, name) VALUES (1, 'Safety') ON CONFLICT (id) DO NOTHING;
INSERT INTO skills (id, domain_id, name) VALUES
    (1, 1, 'Hazard identification'),
    (2, 1, 'Lock-out tag-out'),
    (3, 1, 'Emergency response')
    ON CONFLICT (id) DO NOTHING;

INSERT INTO roles (id, name) VALUES
    (1, 'Welder'),
    (2, 'Foreman')
    ON CONFLICT (id) DO NOTHING;

INSERT INTO role_skill_requirements (role_id, skill_id, required_level, is_critical) VALUES
    (1, 1, 2, true),
    (1, 2, 3, true),
    (2, 1, 3, true),
    (2, 2, 3, true),
    (2, 3, 2, false)
    ON CONFLICT (role_id, skill_id) DO NOTHING;

-- Default SuperAdmin (password is 'Admin123!'; bcrypt hash 12 rounds)
-- Generate with: node -e "console.log(require('bcryptjs').hashSync('Admin123!',12))"
INSERT INTO admins (id, username, email, password_hash, role, is_active, force_password_change)
VALUES (
    1,
    'admin',
    'admin@example.com',
    '$2a$12$/SEED.REPLACE.WITH.GENERATED.HASH.0123456789ABCDEFGHIJ',
    'superadmin',
    true,
    false
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO employees (id, employee_number, first_name, last_name, site_id, department_id, service_id, role_id, username, password_hash, is_account_active)
VALUES
    (1, 'EMP001', 'Test', 'Employee', 1, 1, 1, 1, 'emp001', '$2a$12$/SEED.REPLACE.WITH.GENERATED.HASH.0123456789ABCDEFGHIJ', true),
    (2, 'MGR001', 'Test', 'Manager',  1, 1, 1, 2, 'mgr001', '$2a$12$/SEED.REPLACE.WITH.GENERATED.HASH.0123456789ABCDEFGHIJ', true),
    (3, 'EMP002', 'Other', 'Worker',  1, 1, 1, 1, 'emp002', '$2a$12$/SEED.REPLACE.WITH.GENERATED.HASH.0123456789ABCDEFGHIJ', true)
    ON CONFLICT (id) DO NOTHING;

-- mgr001 supervises emp001 + emp002
UPDATE employees SET supervisor_id = 2 WHERE id IN (1, 3);

-- Re-sync sequences
SELECT setval(pg_get_serial_sequence('sites','id'),                    (SELECT MAX(id) FROM sites));
SELECT setval(pg_get_serial_sequence('departments','id'),              (SELECT MAX(id) FROM departments));
SELECT setval(pg_get_serial_sequence('services','id'),                 (SELECT MAX(id) FROM services));
SELECT setval(pg_get_serial_sequence('domains','id'),                  (SELECT MAX(id) FROM domains));
SELECT setval(pg_get_serial_sequence('skills','id'),                   (SELECT MAX(id) FROM skills));
SELECT setval(pg_get_serial_sequence('roles','id'),                    (SELECT MAX(id) FROM roles));
SELECT setval(pg_get_serial_sequence('admins','id'),                   (SELECT MAX(id) FROM admins));
SELECT setval(pg_get_serial_sequence('employees','id'),                (SELECT MAX(id) FROM employees));

COMMIT;
