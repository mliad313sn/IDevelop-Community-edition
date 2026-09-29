-- 70_cycle_participants.sql
--
-- THE ROSTER. Until now the only definition of "who is in this cycle" was
-- "who already has a self_assessments row" — an audience derived from
-- ENGAGEMENT rather than from INTENT. That made the one person the whole
-- system exists to reach — the non-starter — both unaddressable and
-- uncountable:
--   * CycleService.open announced the launch to
--     SELECT DISTINCT employee_id FROM self_assessments WHERE cycle_id = ?
--     which returns ZERO rows at open, so the announcement reached nobody;
--   * cycle-nudge.js reminders select rows in draft/changes_requested, so
--     somebody who never opened the page has no row and cannot be nudged;
--   * v_employee_cycle_progress INNER JOINs self_assessments, so a
--     non-starter is invisible to the progress view as well.
-- No engagement -> no rows -> no notification -> no engagement.
--
-- This table breaks that loop: enrolment is stamped AT LAUNCH from the
-- employee population, so "who has not started" becomes a WHERE clause.
--
-- CONSTRAINT (deliberate, do not "optimise" it away): the number of skills a
-- role is assessed on is designed by each DEPARTMENT. `expected_skills`
-- snapshots the FULL department-designed catalogue for the person's role. It
-- RECORDS the ask; it never shrinks it. This table MUST NOT gain any
-- skill-subset, sampled-skill, wave, tier or priority column, and
-- excluded_at/exclusion_reason are PERSON-level only (long-term absence,
-- departure) — never a way to exclude skills.
--
-- Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS cycle_participants (
    cycle_id        bigint      NOT NULL REFERENCES assessment_cycles(id) ON DELETE CASCADE,
    employee_id     bigint      NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    -- Org placement SNAPSHOTTED at launch: a mid-cycle transfer must not
    -- retroactively rewrite who was accountable for this campaign.
    role_id         bigint,
    site_id         bigint,
    department_id   bigint,
    service_id      bigint,
    supervisor_id   bigint,
    -- The FULL department-designed requirement count for the role at launch.
    expected_skills int         NOT NULL DEFAULT 0,
    enrolled_at     timestamptz NOT NULL DEFAULT now(),
    started_at      timestamptz,
    submitted_at    timestamptz,
    completed_at    timestamptz,
    -- PERSON-level exclusion only (long leave, departure). Never skill-level.
    excluded_at     timestamptz,
    exclusion_reason text,
    PRIMARY KEY (cycle_id, employee_id)
);

CREATE INDEX IF NOT EXISTS idx_cycle_participants_cycle    ON cycle_participants (cycle_id);
CREATE INDEX IF NOT EXISTS idx_cycle_participants_employee ON cycle_participants (employee_id);
CREATE INDEX IF NOT EXISTS idx_cycle_participants_pending  ON cycle_participants (cycle_id, submitted_at) WHERE excluded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_cycle_participants_supervisor ON cycle_participants (cycle_id, supervisor_id) WHERE excluded_at IS NULL;

-- Live funnel per participant. LEFT JOINs throughout so a NON-STARTER (no
-- self_assessments row at all) still appears — that is the entire point.
DROP VIEW IF EXISTS v_cycle_participant_status;
CREATE VIEW v_cycle_participant_status AS
SELECT p.cycle_id,
       p.employee_id,
       p.site_id,
       p.department_id,
       p.service_id,
       p.supervisor_id,
       p.expected_skills,
       p.excluded_at,
       COALESCE(sa.rated, 0)     AS rated_skills,
       COALESCE(sa.submitted, 0) AS submitted_skills,
       COALESCE(sa.approved, 0)  AS approved_skills,
       CASE
           WHEN p.excluded_at IS NOT NULL                              THEN 'excluded'
           WHEN COALESCE(sa.total, 0) = 0                              THEN 'not_started'
           WHEN COALESCE(sa.approved, 0) >= p.expected_skills
                AND p.expected_skills > 0                              THEN 'approved'
           WHEN COALESCE(sa.submitted, 0) > 0                          THEN 'in_review'
           WHEN COALESCE(sa.rated, 0) > 0                              THEN 'in_progress'
           ELSE 'not_started'
       END AS participant_state
FROM cycle_participants p
LEFT JOIN (
    SELECT employee_id,
           cycle_id,
           COUNT(*)::int                                                        AS total,
           COUNT(*) FILTER (WHERE self_rated_level IS NOT NULL)::int            AS rated,
           COUNT(*) FILTER (WHERE workflow_state IN ('submitted','under_review'))::int AS submitted,
           COUNT(*) FILTER (WHERE workflow_state = 'approved')::int             AS approved
    FROM self_assessments
    GROUP BY employee_id, cycle_id
) sa ON sa.employee_id = p.employee_id AND sa.cycle_id = p.cycle_id;

INSERT INTO schema_meta(key, value) VALUES ('70_cycle_participants', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();

COMMIT;
