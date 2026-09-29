-- FMEA C2 (criticality 240) — /movements printed the raw token `admin:136` as
-- the AUTHOR of a supervisor review.
--
-- REPRODUCED (a development database, 2026-09-01): every attributed row of the `review` stream is
-- mis-namespaced. 90 rows carry `admin:85` / `admin:96`, 2 carry `admin:136`, and
-- NOT ONE of those ids is an admin — 1 is the only row in `admins`:
--
--     reviewed_by | n  | employees(id)             | admins(id)
--     ------------+----+---------------------------+-----------
--        96       | 44 | Berg, Ingrid              | (none)
--        85       | 44 | HOLLOWE, Victor          | (none)
--       136       |  2 | Beatrice NOVAK, Clara    | (none)
--
-- MovementService.resolveActors splits the ref on ':' and looks the id up in the
-- table the PREFIX names. Told 'admin', it queried `admins`, found nothing, and fell
-- back to printing the token itself — so 92 of 92 attributed review rows named
-- nobody, and `topActors` on the page header listed `admin:85` as a person.
--
-- The latent half is worse than the visible half: the moment an `admins` row exists
-- with an id that also exists in `employees` (they are independent sequences — a
-- 136th admin is not far-fetched), the lookup SUCCEEDS and silently prints the
-- WRONG PERSON as the author of a review. That is an audit trail.
--
-- The identity was never ambiguous, only mislabelled. The two source columns point
-- at two different tables and the schema says so:
--
--   skill_assessments.assessed_by  -> FK admins(id)     ('admin:'    is CORRECT)
--   self_assessments.reviewed_by   -> FK employees(id)  ('admin:'    is WRONG)
--
-- (SelfAssessmentWorkflowService only writes reviewed_by for a MANAGER or SUPERVISOR
-- actor — an admin actor cannot own that employee-FK column and leaves it NULL, which
-- the feed already renders as "system".) So the review branch is re-namespaced to
-- 'employee:' and resolveActors resolves the real name with no code change.
--
-- CREATE OR REPLACE (not DROP/CREATE): identical column list, names, order and types,
-- so nothing that depends on the view is disturbed. Idempotent by construction.

CREATE OR REPLACE VIEW v_movement_feed AS
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

    -- assessor activity: a validated skill assessment.
    -- assessed_by REFERENCES admins(id) — 'admin:' is the right namespace here.
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

    -- assessor activity: a self-assessment review decision.
    -- reviewed_by REFERENCES employees(id) — the reviewer is the supervisor or
    -- manager who decided, an EMPLOYEE. An admin actor leaves the column NULL.
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
        CASE WHEN sa.reviewed_by IS NULL THEN NULL ELSE 'employee:' || sa.reviewed_by END,
        sa.skill_id,
        sk.name
    FROM self_assessments sa
    JOIN employees   e  ON e.id = sa.employee_id
    LEFT JOIN skills sk ON sk.id = sa.skill_id
    LEFT JOIN sites       s ON s.id = e.site_id
    LEFT JOIN departments d ON d.id = e.department_id
    WHERE sa.reviewed_at IS NOT NULL;
