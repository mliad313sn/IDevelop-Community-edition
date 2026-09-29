-- =====================================================================
-- 63_cancellation_requests.sql - cancelling a plan, under approval, with
-- the whole story kept.
--
-- WHAT
--   A manager or an admin may ask to cancel a coaching plan, a mentoring
--   plan, a PIP or an IDP. The request is NOT self-service: a LOCAL ADMIN
--   covering that employee must approve it. Nothing is ever deleted - the
--   plan is marked cancelled and the request row keeps who asked, why, who
--   decided, when, and what the plan's state was beforehand.
--
-- WHY A DEDICATED TABLE AND NOT maker_checker_requests
--   The existing two-person queue is the right PATTERN, but its
--   maker_id/checker_id both FK to admins(id). A manager is an employee,
--   so a manager could never be the maker there. This table accepts either
--   kind of requester while keeping the decision admin-only.
--
-- TRACE GUARANTEES (enforced here, not only in the service)
--   * reason is NOT NULL - a cancellation without an explanation cannot be
--     recorded at all;
--   * a decided row MUST name the deciding admin (chk_cancel_decided_by_admin),
--     so no code path, script or manual UPDATE can cancel anonymously;
--   * previous_state is captured so the trail shows what was destroyed;
--   * exactly one pending request per plan (partial unique index);
--   * ON DELETE RESTRICT on the decider - an admin who approved a
--     cancellation cannot be deleted out of the audit trail.
--
-- Additive and idempotent.
-- =====================================================================
BEGIN;

-- IDP had no terminal 'cancelled' state (draft/active/completed/archived).
-- PIP already has one; coaching_plans.state is free text.
DO $$ BEGIN
    ALTER TYPE idp_status ADD VALUE IF NOT EXISTS 'cancelled';
EXCEPTION WHEN undefined_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE cancellation_state AS ENUM ('pending', 'approved', 'rejected', 'withdrawn');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS cancellation_requests (
    id                       bigserial PRIMARY KEY,
    entity_type              text NOT NULL
                             CHECK (entity_type IN ('coaching', 'mentoring', 'pip', 'idp')),
    entity_id                bigint NOT NULL,
    employee_id              bigint REFERENCES employees(id) ON DELETE SET NULL,

    -- The explanation is the point of the module: never optional.
    reason                   text NOT NULL CHECK (length(btrim(reason)) > 0),
    previous_state           text,                     -- what it was before cancelling

    requested_by_employee_id bigint REFERENCES employees(id) ON DELETE SET NULL,
    requested_by_admin_id    bigint REFERENCES admins(id)    ON DELETE SET NULL,
    requested_at             timestamptz NOT NULL DEFAULT now(),

    state                    cancellation_state NOT NULL DEFAULT 'pending',
    decided_by_admin_id      bigint REFERENCES admins(id) ON DELETE RESTRICT,
    decided_at               timestamptz,
    decision_note            text,

    -- A decision is always an administrator's, and always attributable.
    CONSTRAINT chk_cancel_decided_by_admin CHECK (
        state IN ('pending', 'withdrawn')
        OR (decided_by_admin_id IS NOT NULL AND decided_at IS NOT NULL)
    ),
    -- Somebody must own the request.
    CONSTRAINT chk_cancel_has_requester CHECK (
        requested_by_employee_id IS NOT NULL OR requested_by_admin_id IS NOT NULL
    )
);

-- One live request per plan: a plan cannot be contested twice in parallel.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cancel_one_pending
    ON cancellation_requests (entity_type, entity_id) WHERE state = 'pending';

CREATE INDEX IF NOT EXISTS idx_cancel_state    ON cancellation_requests (state, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_cancel_employee ON cancellation_requests (employee_id, requested_at DESC);

-- Readable queue: resolves the people and the plan title so the console and
-- any export never have to re-derive them.
DROP VIEW IF EXISTS v_cancellation_queue;
CREATE VIEW v_cancellation_queue AS
SELECT
    cr.id, cr.entity_type, cr.entity_id, cr.state::text AS state,
    cr.reason, cr.previous_state, cr.decision_note,
    cr.requested_at, cr.decided_at, cr.employee_id,
    e.last_name || ', ' || e.first_name              AS employee_name,
    e.employee_number                                AS employee_number,
    s.name                                           AS site_name,
    d.name                                           AS department_name,
    COALESCE(
        re.last_name || ', ' || re.first_name,
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

COMMIT;
