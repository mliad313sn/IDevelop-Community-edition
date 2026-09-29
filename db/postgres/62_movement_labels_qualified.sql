-- =====================================================================
-- 62_movement_labels_qualified.sql - make movement labels unambiguous
--
-- Department and service names are NOT unique in this model: they are named
-- per site. On a test instance 9 of the 10 departments are called "IT",
-- and services repeat too ("IT Operations" x6). Migration 60 stored the bare
-- name, so a genuine transfer between two different departments rendered as
--
--     department: IT -> IT
--
-- which reads to an operator as a broken trail rather than a real move.
--
-- The trigger now qualifies the label with its parent:
--     department -> "IT (Riverside)"
--     service    -> "IT Operations (IT / Riverside)"
-- Sites and roles are globally unique on this data and stay as they are.
--
-- Only the capture function changes; the table, the view, the indexes and
-- every already-captured row are untouched (history is never rewritten).
-- Idempotent: CREATE OR REPLACE.
-- =====================================================================
BEGIN;

CREATE OR REPLACE FUNCTION fn_capture_employee_movement() RETURNS trigger AS $$
DECLARE
    v_actor text := NULLIF(current_setting('app.actor_ref', true), '');
    v_from  text;
    v_to    text;
BEGIN
    IF NEW.site_id IS DISTINCT FROM OLD.site_id THEN
        SELECT name INTO v_from FROM sites WHERE id = OLD.site_id;
        SELECT name INTO v_to   FROM sites WHERE id = NEW.site_id;
        INSERT INTO employee_movements (employee_id, kind, from_id, to_id, from_label, to_label, actor_ref)
        VALUES (NEW.id, 'site', OLD.site_id, NEW.site_id, v_from, v_to, v_actor);
    END IF;

    IF NEW.department_id IS DISTINCT FROM OLD.department_id THEN
        SELECT d.name || COALESCE(' (' || s.name || ')', '') INTO v_from
          FROM departments d LEFT JOIN sites s ON s.id = d.site_id WHERE d.id = OLD.department_id;
        SELECT d.name || COALESCE(' (' || s.name || ')', '') INTO v_to
          FROM departments d LEFT JOIN sites s ON s.id = d.site_id WHERE d.id = NEW.department_id;
        INSERT INTO employee_movements (employee_id, kind, from_id, to_id, from_label, to_label, actor_ref)
        VALUES (NEW.id, 'department', OLD.department_id, NEW.department_id, v_from, v_to, v_actor);
    END IF;

    IF NEW.service_id IS DISTINCT FROM OLD.service_id THEN
        SELECT sv.name || COALESCE(' (' || d.name || COALESCE(' / ' || s.name, '') || ')', '') INTO v_from
          FROM services sv
          LEFT JOIN departments d ON d.id = sv.department_id
          LEFT JOIN sites       s ON s.id = d.site_id
         WHERE sv.id = OLD.service_id;
        SELECT sv.name || COALESCE(' (' || d.name || COALESCE(' / ' || s.name, '') || ')', '') INTO v_to
          FROM services sv
          LEFT JOIN departments d ON d.id = sv.department_id
          LEFT JOIN sites       s ON s.id = d.site_id
         WHERE sv.id = NEW.service_id;
        INSERT INTO employee_movements (employee_id, kind, from_id, to_id, from_label, to_label, actor_ref)
        VALUES (NEW.id, 'service', OLD.service_id, NEW.service_id, v_from, v_to, v_actor);
    END IF;

    IF NEW.role_id IS DISTINCT FROM OLD.role_id THEN
        SELECT name INTO v_from FROM roles WHERE id = OLD.role_id;
        SELECT name INTO v_to   FROM roles WHERE id = NEW.role_id;
        INSERT INTO employee_movements (employee_id, kind, from_id, to_id, from_label, to_label, actor_ref)
        VALUES (NEW.id, 'role', OLD.role_id, NEW.role_id, v_from, v_to, v_actor);
    END IF;

    IF NEW.manager_id IS DISTINCT FROM OLD.manager_id THEN
        SELECT last_name || ', ' || first_name INTO v_from FROM employees WHERE id = OLD.manager_id;
        SELECT last_name || ', ' || first_name INTO v_to   FROM employees WHERE id = NEW.manager_id;
        INSERT INTO employee_movements (employee_id, kind, from_id, to_id, from_label, to_label, actor_ref)
        VALUES (NEW.id, 'manager', OLD.manager_id, NEW.manager_id, v_from, v_to, v_actor);
    END IF;

    IF NEW.supervisor_id IS DISTINCT FROM OLD.supervisor_id THEN
        SELECT last_name || ', ' || first_name INTO v_from FROM employees WHERE id = OLD.supervisor_id;
        SELECT last_name || ', ' || first_name INTO v_to   FROM employees WHERE id = NEW.supervisor_id;
        INSERT INTO employee_movements (employee_id, kind, from_id, to_id, from_label, to_label, actor_ref)
        VALUES (NEW.id, 'supervisor', OLD.supervisor_id, NEW.supervisor_id, v_from, v_to, v_actor);
    END IF;

    IF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
        INSERT INTO employee_movements (employee_id, kind, from_label, to_label, actor_ref)
        VALUES (NEW.id, 'status',
                CASE WHEN OLD.is_active THEN 'active' ELSE 'inactive' END,
                CASE WHEN NEW.is_active THEN 'active' ELSE 'inactive' END,
                v_actor);
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
