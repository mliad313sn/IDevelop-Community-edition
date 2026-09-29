-- =====================================================================
--  / M-20 — one order for a person's name, down to the database.
--
-- The passe-1 fix repaired one SQL call site in src/. An independent pass
-- then found the class alive in the EJS layer and in /admin/accounts/export.csv.
-- Measuring by HTTP rather than by grep found it alive one layer deeper still:
-- FOUR live objects in the database itself concatenate last_name BEFORE
-- first_name, which no sweep of src/ or views/ can see.
--
--   VIEW     v_movement_feed              (3 branches)  -> /movements
--   VIEW     v_post_approval_queue        (1)           -> post-approval queue
--   VIEW     v_cancellation_queue         (2)           -> cancellation console
--   FUNCTION fn_capture_employee_movement (4)           -> WRITES the labels
--
-- `v_post_approval_queue` carries the whole finding inside a single object:
-- `employee_name` is « Prénom Nom » and `raised_by_name`, two lines below,
-- is « NOM, Prénom ».
--
-- The trigger function is not a display defect: it STAMPS the reversed
-- spelling into employee_movements.from_label / to_label on every future
-- manager or supervisor change, so the ledger would keep growing new
-- occurrences long after the views were fixed. Measured on the test database
-- before this migration: /movements served 38 « NOM, Prénom » against 4 « Prénom Nom »,
-- employee 136 named BOTH ways in that one response.
--
-- Order chosen: given name, then family name — see src/utils/personName.js for
-- why (it is the order every search box indexes on, and last_name here is free
-- text that routinely carries a compound name, so only the order tells a reader
-- which half is which).
--
-- COALESCE + TRIM, not plain `||`: the expressions replaced here returned NULL
-- as soon as one half was missing, i.e. an unnamed row. Now the half that
-- exists is still shown.
--
-- CREATE OR REPLACE throughout: identical column lists, names, order and types,
-- so nothing that depends on these views is disturbed. Idempotent by
-- construction, safe to re-run.
-- =====================================================================
BEGIN;

-- ---------------------------------------------------------------------
-- 1) The writer. Fix this first: from here on the ledger is stamped once,
--    correctly. History already written is handled in step 5.
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
        -- given name, then family name — the one order (utils/personName).
        SELECT TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')) INTO v_from
          FROM employees WHERE id = OLD.manager_id;
        SELECT TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')) INTO v_to
          FROM employees WHERE id = NEW.manager_id;
        INSERT INTO employee_movements (employee_id, kind, from_id, to_id, from_label, to_label, actor_ref)
        VALUES (NEW.id, 'manager', OLD.manager_id, NEW.manager_id, v_from, v_to, v_actor);
    END IF;

    IF NEW.supervisor_id IS DISTINCT FROM OLD.supervisor_id THEN
        -- same order as the manager branch above and as the roster.
        SELECT TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')) INTO v_from
          FROM employees WHERE id = OLD.supervisor_id;
        SELECT TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')) INTO v_to
          FROM employees WHERE id = NEW.supervisor_id;
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

-- ---------------------------------------------------------------------
-- 2) The movements feed: three branches, one order.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v_movement_feed AS
    -- organisational movements
    SELECT
        'movement'::text                       AS stream,
        m.kind                                 AS event_kind,
        m.occurred_at                          AS occurred_at,
        m.employee_id                          AS employee_id,
        TRIM(COALESCE(e.first_name, '') || ' ' || COALESCE(e.last_name, '')) AS employee_name,
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

    -- assessor activity: a validated skill assessment.
    SELECT
        'assessment'::text,
        'skill_assessed',
        a.assessed_at,
        a.employee_id,
        TRIM(COALESCE(e.first_name, '') || ' ' || COALESCE(e.last_name, '')),
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

    -- assessor activity: a self-assessment review decision.
    SELECT
        'review'::text,
        COALESCE(sa.workflow_state::text, sa.status::text, 'reviewed'),
        sa.reviewed_at,
        sa.employee_id,
        TRIM(COALESCE(e.first_name, '') || ' ' || COALESCE(e.last_name, '')),
        e.employee_number,
        s.name,
        d.name,
        sa.self_rated_level::text,
        COALESCE(sa.workflow_state::text, sa.status::text),
        CASE WHEN sa.reviewed_by IS NULL THEN NULL ELSE 'employee:' || sa.reviewed_by END,
        sa.skill_id,
        sk.name
    FROM self_assessments sa
    JOIN employees   e  ON e.id = sa.employee_id
    LEFT JOIN skills sk ON sk.id = sa.skill_id
    LEFT JOIN sites       s ON s.id = e.site_id
    LEFT JOIN departments d ON d.id = e.department_id
    WHERE sa.reviewed_at IS NOT NULL;

-- ---------------------------------------------------------------------
-- 3) Post-approval queue: employee_name said « Prénom Nom » and
--    raised_by_name, in the same SELECT list, said « NOM, Prénom ».
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v_post_approval_queue AS
SELECT
    p.id, p.self_assessment_id, p.state, p.reason, p.decision_note,
    p.approved_level, p.proposed_level, p.raised_at, p.decided_at,
    p.employee_id, p.skill_id, p.decided_by_admin_id,
    TRIM(COALESCE(e.first_name, '') || ' ' || COALESCE(e.last_name, '')) AS employee_name,
    e.employee_number                               AS employee_number,
    s.name                                          AS site_name,
    d.name                                          AS department_name,
    sk.name                                         AS skill_name,
    CASE WHEN p.raised_by IS NULL THEN NULL
         ELSE TRIM(COALESCE(r.first_name, '') || ' ' || COALESCE(r.last_name, '')) END AS raised_by_name,
    a.username                                      AS decided_by_name
FROM post_approval_reviews p
JOIN employees   e  ON e.id  = p.employee_id
LEFT JOIN employees r  ON r.id  = p.raised_by
LEFT JOIN admins    a  ON a.id  = p.decided_by_admin_id
LEFT JOIN skills    sk ON sk.id = p.skill_id
LEFT JOIN sites       s ON s.id = e.site_id
LEFT JOIN departments d ON d.id = e.department_id;

-- ---------------------------------------------------------------------
-- 4) Cancellation queue.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v_cancellation_queue AS
SELECT
    cr.id, cr.entity_type, cr.entity_id, cr.state::text AS state,
    cr.reason, cr.previous_state, cr.decision_note,
    cr.requested_at, cr.decided_at, cr.employee_id,
    TRIM(COALESCE(e.first_name, '') || ' ' || COALESCE(e.last_name, '')) AS employee_name,
    e.employee_number                                AS employee_number,
    s.name                                           AS site_name,
    d.name                                           AS department_name,
    COALESCE(
        NULLIF(TRIM(COALESCE(re.first_name, '') || ' ' || COALESCE(re.last_name, '')), ''),
        ra.username
    )                                                AS requested_by_name,
    CASE WHEN cr.requested_by_admin_id IS NOT NULL THEN 'admin' ELSE 'manager' END AS requested_by_kind,
    da.username                                      AS decided_by_name
FROM cancellation_requests cr
LEFT JOIN employees   e  ON e.id  = cr.employee_id
LEFT JOIN employees   re ON re.id = cr.requested_by_employee_id
LEFT JOIN admins      ra ON ra.id = cr.requested_by_admin_id
LEFT JOIN admins      da ON da.id = cr.decided_by_admin_id
LEFT JOIN sites       s  ON s.id  = e.site_id
LEFT JOIN departments d  ON d.id  = e.department_id;

-- ---------------------------------------------------------------------
-- 5) Labels the OLD trigger already stamped into the ledger.
--
--    Nothing is deleted and no fact is rewritten: the row, its employee, its
--    kind, its timestamp, its actor and its from_id/to_id all stay exactly as
--    they were. Only the derived NAME LABEL — a string this product generated
--    itself from first_name / last_name — is re-spelled in the one order, and
--    only where it matches an existing employee's reversed spelling EXACTLY,
--    so a hand-typed note can never be caught by it.
--
--    Without this, /movements keeps serving the same person in two orders in
--    one response (« Clara Beatrice NOVAK » in the row, « Beatrice NOVAK,
--    Clara » in the from→to cell of the row above), which is the finding.
-- ---------------------------------------------------------------------
UPDATE employee_movements m
   SET from_label = TRIM(COALESCE(e.first_name, '') || ' ' || COALESCE(e.last_name, ''))
  FROM employees e
 WHERE m.kind IN ('manager', 'supervisor')
   AND m.from_label IS NOT NULL
   AND m.from_label = e.last_name || ', ' || e.first_name;

UPDATE employee_movements m
   SET to_label = TRIM(COALESCE(e.first_name, '') || ' ' || COALESCE(e.last_name, ''))
  FROM employees e
 WHERE m.kind IN ('manager', 'supervisor')
   AND m.to_label IS NOT NULL
   AND m.to_label = e.last_name || ', ' || e.first_name;

COMMIT;
