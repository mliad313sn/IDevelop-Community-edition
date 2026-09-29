-- =====================================================================
-- 60_employee_movements.sql - Movement & activity tracking
--
-- Answers one question on one page: WHAT is happening, WHERE, and WHO did it.
--
--  1) employee_movements - every organisational movement of a person:
--       site -> site, department -> department, service -> service,
--       role -> role, manager/supervisor reassignment, activation and
--       deactivation. Captured by an AFTER UPDATE TRIGGER on employees,
--       not by application code: ten different code paths write to
--       employees (UI, Excel import, JSON import, SCIM, SSO, lifecycle,
--       DSR, snapshot, invitations, skill-matrix workbook) and a trigger
--       is the only place that sees all of them - including direct SQL.
--
--       Labels are resolved and STORED at capture time. An org unit that
--       is renamed or deleted later must not rewrite history, so the
--       movement keeps the name as it was on the day it happened.
--
--       actor_ref is read from the transaction-local GUC 'app.actor_ref'
--       when the application sets it (see PostgresDatabase.withActor).
--       When it is absent the movement is still recorded, with a NULL
--       actor, and the UI shows it as "system" - never a wrong name.
--
--  2) v_movement_feed - movements UNION assessor actions (skill
--       assessments, self-assessment reviews and approvals) as one
--       chronological feed with a common shape, so the page can render a
--       single "who did what, where" timeline. Every row exposes
--       employee_id so callers can scope BEFORE aggregating.
--
-- Additive and idempotent. No existing row is modified.
-- =====================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS employee_movements (
    id           bigserial PRIMARY KEY,
    employee_id  bigint NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    kind         text   NOT NULL
                 CHECK (kind IN ('site', 'department', 'service', 'role',
                                 'manager', 'supervisor', 'status')),
    from_id      bigint,
    to_id        bigint,
    from_label   text,
    to_label     text,
    actor_ref    text,                       -- 'admin:5' / 'employee:12' / NULL = system
    source       text NOT NULL DEFAULT 'db', -- reserved for future explicit tagging
    note         text,
    occurred_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_emp_move_employee ON employee_movements(employee_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_emp_move_when     ON employee_movements(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_emp_move_kind     ON employee_movements(kind, occurred_at DESC);

-- ---------------------------------------------------------------------
-- Trigger: record one row per changed dimension.
-- ---------------------------------------------------------------------
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
        SELECT name INTO v_from FROM departments WHERE id = OLD.department_id;
        SELECT name INTO v_to   FROM departments WHERE id = NEW.department_id;
        INSERT INTO employee_movements (employee_id, kind, from_id, to_id, from_label, to_label, actor_ref)
        VALUES (NEW.id, 'department', OLD.department_id, NEW.department_id, v_from, v_to, v_actor);
    END IF;

    IF NEW.service_id IS DISTINCT FROM OLD.service_id THEN
        SELECT name INTO v_from FROM services WHERE id = OLD.service_id;
        SELECT name INTO v_to   FROM services WHERE id = NEW.service_id;
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

DROP TRIGGER IF EXISTS trg_capture_employee_movement ON employees;
CREATE TRIGGER trg_capture_employee_movement
    AFTER UPDATE ON employees
    FOR EACH ROW
    EXECUTE FUNCTION fn_capture_employee_movement();

-- ---------------------------------------------------------------------
-- Unified feed: movements + assessor activity, one shape.
-- ---------------------------------------------------------------------
DROP VIEW IF EXISTS v_movement_feed;
CREATE VIEW v_movement_feed AS
    -- organisational movements
    SELECT
        'movement'::text                       AS stream,
        m.kind                                 AS event_kind,
        m.occurred_at                          AS occurred_at,
        m.employee_id                          AS employee_id,
        e.last_name || ', ' || e.first_name    AS employee_name,
        e.employee_number                      AS employee_number,
        s.name                                 AS site_name,
        d.name                                 AS department_name,
        m.from_label                           AS from_label,
        m.to_label                             AS to_label,
        m.actor_ref                            AS actor_ref,
        NULL::bigint                           AS skill_id,
        NULL::text                             AS skill_name
    FROM employee_movements m
    JOIN employees   e ON e.id = m.employee_id
    LEFT JOIN sites       s ON s.id = e.site_id
    LEFT JOIN departments d ON d.id = e.department_id

    UNION ALL

    -- assessor activity: a validated skill assessment
    SELECT
        'assessment'::text,
        'skill_assessed',
        a.assessed_at,
        a.employee_id,
        e.last_name || ', ' || e.first_name,
        e.employee_number,
        s.name,
        d.name,
        NULL,
        a.current_level::text,
        CASE WHEN a.assessed_by IS NULL THEN NULL ELSE 'admin:' || a.assessed_by END,
        a.skill_id,
        sk.name
    FROM skill_assessments a
    JOIN employees   e  ON e.id = a.employee_id
    LEFT JOIN skills sk ON sk.id = a.skill_id
    LEFT JOIN sites       s ON s.id = e.site_id
    LEFT JOIN departments d ON d.id = e.department_id
    WHERE a.assessed_at IS NOT NULL

    UNION ALL

    -- assessor activity: a self-assessment review decision
    SELECT
        'review'::text,
        -- status is the enum self_assessment_state; cast both sides to text
        COALESCE(sa.workflow_state::text, sa.status::text, 'reviewed'),
        sa.reviewed_at,
        sa.employee_id,
        e.last_name || ', ' || e.first_name,
        e.employee_number,
        s.name,
        d.name,
        sa.self_rated_level::text,
        COALESCE(sa.workflow_state::text, sa.status::text),
        CASE WHEN sa.reviewed_by IS NULL THEN NULL ELSE 'admin:' || sa.reviewed_by END,
        sa.skill_id,
        sk.name
    FROM self_assessments sa
    JOIN employees   e  ON e.id = sa.employee_id
    LEFT JOIN skills sk ON sk.id = sa.skill_id
    LEFT JOIN sites       s ON s.id = e.site_id
    LEFT JOIN departments d ON d.id = e.department_id
    WHERE sa.reviewed_at IS NOT NULL;

COMMIT;
