-- 105_roster_view_management_backlog.sql
--
-- The roster view (migration 70) counted a participant's skills as "submitted"
-- only while they sat in workflow_state 'submitted' or 'under_review'. The
-- moment a supervisor moved a row on — 'reviewed' (awaiting the manager),
-- 'arbitration' (escalated), or even 'rejected' — that skill dropped OUT of the
-- submitted count, and the person rolled BACK from 'in_review' to
-- 'in_progress' as if they had not finished. Measured on a development database: a participant
-- with 4 skills in reviewed / arbitration / rejected / changes_requested read
-- {"state":"in_progress","submitted":0}. CycleService.progressByManager — the
-- view that names the manager sitting on submissions — was therefore blind to
-- the management backlog exactly where it was largest.
--
-- Fix: "submitted" = every state in which the skill is WITH MANAGEMENT
-- ('submitted', 'under_review', 'reviewed', 'arbitration'); a rejected skill
-- gets its OWN bucket (rejected_skills) instead of being folded into "in
-- progress"; 'draft' / 'changes_requested' stay with the employee (in_progress).
--
-- CREATE OR REPLACE VIEW: the existing column list is kept, in order, and the
-- new column is appended LAST — so every current reader (CycleService,
-- DashboardService.getCampaignFunnel, the employee campaign banner) keeps
-- working unchanged. participant_state keeps the same five values: a rejected
-- skill is not validated, so a person with only rejections is still 'in_progress'
-- (the STATES list in CycleService/DashboardService is closed; a sixth value
-- would silently vanish from both). rated / approved semantics are untouched.
--
-- CONSTRAINT (unchanged from 70): expected_skills is the FULL department-designed
-- requirement count. Nothing here subsets, samples or tiers skills.
--
-- Idempotent: safe to re-run.

CREATE OR REPLACE VIEW v_cycle_participant_status AS
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
       END AS participant_state,
       COALESCE(sa.rejected, 0)  AS rejected_skills
FROM cycle_participants p
LEFT JOIN (
    SELECT employee_id,
           cycle_id,
           COUNT(*)::int                                                        AS total,
           COUNT(*) FILTER (WHERE self_rated_level IS NOT NULL)::int            AS rated,
           -- With management: submitted, opened, supervisor-reviewed (awaiting the
           -- manager), or escalated. Rejected is counted separately below.
           COUNT(*) FILTER (WHERE workflow_state IN ('submitted','under_review','reviewed','arbitration'))::int AS submitted,
           COUNT(*) FILTER (WHERE workflow_state = 'approved')::int             AS approved,
           COUNT(*) FILTER (WHERE workflow_state = 'rejected')::int             AS rejected
    FROM self_assessments
    GROUP BY employee_id, cycle_id
) sa ON sa.employee_id = p.employee_id AND sa.cycle_id = p.cycle_id;
