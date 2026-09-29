-- FMEA C1 (criticality 648) — one person, three dots, two boxes.
--
-- REPRODUCED (a development database, 2026-09-01): 37 non-archived rows for 11 people.
--   employee 87 : 10 rows, ALL drafts, spread over boxes 5 / 8 / 9
--   employee 88 :  9 rows — 7 approved in box 1 + 2 drafts in box 8
--   employee 89 :  8 rows — 7 approved in box 6 + 1 draft in box 9
--   employee 68963: 3 rows — 1 approved box 1 + 2 drafts box 8
-- `NineBoxService.grid` selects every row with status <> 'archived', so the
-- console plotted ten chips for one person. The roster badge took the newest row
-- (a DRAFT), the employee dashboard and the Power BI feed took the APPROVED row,
-- and the talent-development dashboard COUNTed every approved row — so employee 88
-- contributed 7 people to the "Concern" cell of the distribution.
--
-- THE RULE this migration enforces, and that the service now implements:
--
--   A placement is what has been APPROVED. A draft is a proposal, never a position.
--
--   * at most ONE open evaluation (draft | under_review) per employee — the
--     proposal currently being worked on;
--   * at most ONE approved evaluation per employee — the CURRENT position;
--   * approving supersedes the previous approval by ARCHIVING it, which is where
--     `placementTrend` and the talent timeline already read history from, so
--     nothing is lost;
--   * `rejected` and `archived` are neither, and are excluded from the grid.
--
-- Two PARTIAL unique indexes are the mechanism. They cannot be created over the
-- data as it stands (23505 is deliberately NOT swallowed by the migration runner),
-- so the duplicates are resolved FIRST, deliberately:
--
--   nothing is deleted. For each employee the most recent approval (by approved_at,
--   then id) stays approved and every earlier approval becomes 'archived'; the most
--   recently touched open row (by updated_at, then id) stays open and every earlier
--   one becomes 'archived'. Every superseded row gets a nine_box_events row so the
--   change is visible in the audit trail rather than silent.
--
-- Idempotent: on a database with no duplicates both UPDATEs affect 0 rows and both
-- indexes are IF NOT EXISTS.

-- 1) Supersede every approval but the most recent one, per employee.
WITH ranked AS (
    SELECT id,
           row_number() OVER (
               PARTITION BY employee_id
               ORDER BY COALESCE(approved_at, updated_at, created_at) DESC, id DESC
           ) AS rn
      FROM nine_box_evaluations
     WHERE status = 'approved'
), superseded AS (
    UPDATE nine_box_evaluations ev
       SET status = 'archived', updated_at = now()
      FROM ranked r
     WHERE ev.id = r.id AND r.rn > 1
    RETURNING ev.id, ev.employee_id
)
INSERT INTO nine_box_events
       (evaluation_id, employee_id, actor_id, actor_type, action, from_status, to_status, detail)
SELECT s.id, s.employee_id, NULL, 'system', 'supersede', 'approved', 'archived',
       jsonb_build_object('reason',
           'migration 95: one current approved placement per employee')
  FROM superseded s;

-- 2) Supersede every open proposal but the most recently touched one, per employee.
WITH ranked AS (
    SELECT id, status,
           row_number() OVER (
               PARTITION BY employee_id
               ORDER BY COALESCE(updated_at, created_at) DESC, id DESC
           ) AS rn
      FROM nine_box_evaluations
     WHERE status IN ('draft', 'under_review')
), superseded AS (
    UPDATE nine_box_evaluations ev
       SET status = 'archived', updated_at = now()
      FROM ranked r
     WHERE ev.id = r.id AND r.rn > 1
    RETURNING ev.id, ev.employee_id, r.status AS was
)
INSERT INTO nine_box_events
       (evaluation_id, employee_id, actor_id, actor_type, action, from_status, to_status, detail)
SELECT s.id, s.employee_id, NULL, 'system', 'supersede', s.was, 'archived',
       jsonb_build_object('reason',
           'migration 95: one open proposal per employee')
  FROM superseded s;

-- 3) The mechanism that stops it coming back. createDraft now edits the existing
--    open proposal instead of inserting a second one, and approve archives the
--    previous approval in the same transaction, so neither index should ever fire
--    in normal use — they are the backstop for the ten code paths that are not the UI.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ninebox_open_per_employee
    ON nine_box_evaluations (employee_id)
 WHERE status IN ('draft', 'under_review');

CREATE UNIQUE INDEX IF NOT EXISTS uq_ninebox_approved_per_employee
    ON nine_box_evaluations (employee_id)
 WHERE status = 'approved';
