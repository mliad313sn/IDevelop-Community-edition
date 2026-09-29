-- =====================================================================
-- 61_post_approval_reviews.sql - Supervisor re-review AFTER approval
--
-- The existing flow ends at approval: employee self-assesses, the
-- supervisor/manager reviews, the score is approved and becomes final.
-- Disputes (assessment_disputes, L0/L1/L2) only run BEFORE that point.
--
-- This adds the missing case: a supervisor sees an ALREADY APPROVED score
-- they believe is wrong. They can raise a re-review with a proposed level
-- and a reason. Because the score already carries a manager's (or an
-- admin's) approval, a manager may NOT quietly overturn it - only an
-- administrator can decide. That is the whole point of the module, so the
-- rule is enforced in the database, not only in the controller:
--
--   * decided_by_admin_id is REQUIRED the moment state leaves 'pending'
--     (chk_decision_needs_admin), so there is no code path - route, script
--     or direct SQL - that can approve one without naming an admin.
--   * a partial UNIQUE index allows only ONE pending re-review per
--     assessment, so a score cannot be contested twice in parallel.
--
-- Additive and idempotent.
-- =====================================================================
BEGIN;

DO $$ BEGIN
    CREATE TYPE post_review_state AS ENUM ('pending', 'approved', 'rejected', 'withdrawn');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS post_approval_reviews (
    id                   bigserial PRIMARY KEY,
    self_assessment_id   bigint NOT NULL REFERENCES self_assessments(id) ON DELETE CASCADE,
    employee_id          bigint NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    skill_id             bigint NOT NULL REFERENCES skills(id) ON DELETE CASCADE,

    approved_level       smallint,                   -- the level as it stood when contested
    -- The proficiency scale in this system is 0..4 (see self_assessments,
    -- skill_assessments and supervisor_reviews). Anything wider would let a
    -- case be raised that cannot be applied when the admin approves it.
    proposed_level       smallint NOT NULL CHECK (proposed_level BETWEEN 0 AND 4),
    reason               text NOT NULL,

    raised_by            bigint,                     -- employees.id (supervisor/manager)
    raised_by_admin_id   bigint,                     -- admins.id when an admin raises it
    raised_at            timestamptz NOT NULL DEFAULT now(),

    state                post_review_state NOT NULL DEFAULT 'pending',
    decided_by_admin_id  bigint,                     -- admins.id - REQUIRED once decided
    decided_at           timestamptz,
    decision_note        text,

    -- A decision is only ever an administrator's. Enforced here so it holds
    -- for every writer, not just the controller.
    CONSTRAINT chk_decision_needs_admin CHECK (
        state = 'pending'
        OR state = 'withdrawn'
        OR (decided_by_admin_id IS NOT NULL AND decided_at IS NOT NULL)
    )
);

-- Re-align the scale on databases that received the first cut of this
-- migration (which wrongly allowed 0..5). Idempotent, and it clamps any row
-- already raised at the impossible level so the constraint can be re-added.
ALTER TABLE post_approval_reviews DROP CONSTRAINT IF EXISTS post_approval_reviews_proposed_level_check;
UPDATE post_approval_reviews SET proposed_level = 4 WHERE proposed_level > 4;
ALTER TABLE post_approval_reviews
    ADD CONSTRAINT post_approval_reviews_proposed_level_check CHECK (proposed_level BETWEEN 0 AND 4);

-- Only one live contest per approved assessment.
CREATE UNIQUE INDEX IF NOT EXISTS uq_post_review_one_pending
    ON post_approval_reviews (self_assessment_id) WHERE state = 'pending';

CREATE INDEX IF NOT EXISTS idx_post_review_state    ON post_approval_reviews (state, raised_at DESC);
CREATE INDEX IF NOT EXISTS idx_post_review_employee ON post_approval_reviews (employee_id, raised_at DESC);

-- Readable queue: joins the people and the skill so the console and the
-- movement feed never have to re-derive names.
DROP VIEW IF EXISTS v_post_approval_queue;
CREATE VIEW v_post_approval_queue AS
SELECT
    p.id, p.self_assessment_id, p.state, p.reason, p.decision_note,
    p.approved_level, p.proposed_level, p.raised_at, p.decided_at,
    p.employee_id, p.skill_id, p.decided_by_admin_id,
    e.first_name || ' ' || e.last_name              AS employee_name,
    e.employee_number                               AS employee_number,
    s.name                                          AS site_name,
    d.name                                          AS department_name,
    sk.name                                         AS skill_name,
    CASE WHEN p.raised_by IS NULL THEN NULL
         ELSE r.last_name || ', ' || r.first_name END AS raised_by_name,
    a.username                                      AS decided_by_name
FROM post_approval_reviews p
JOIN employees   e  ON e.id  = p.employee_id
LEFT JOIN employees r  ON r.id  = p.raised_by
LEFT JOIN admins    a  ON a.id  = p.decided_by_admin_id
LEFT JOIN skills    sk ON sk.id = p.skill_id
LEFT JOIN sites       s ON s.id = e.site_id
LEFT JOIN departments d ON d.id = e.department_id;

COMMIT;
