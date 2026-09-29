-- 9-box disclosure, the confidentiality leak, and manager tasks.
--
-- Three arbitrations from the HR policy of 13/09/2026 land here:
--
--   A4  A placement stays UNDISCLOSED by default. Disclosure is a deliberate act
--       that must be traceable: WHO disclosed it, WHEN, and WHY. The boolean
--       `disclosed_to_employee` recorded the fact and nothing else — the employee
--       could see their cell with no date, no author and no reason, and a manager
--       could publish a confidential judgement leaving no justification behind.
--
--   A4b The leak. `pips.summary` and `idp_objectives.smart_text` are read by the
--       SUBJECT of the plan, and rows written before the confidentiality rule
--       still name the 9-box cell in that prose while the placement itself is
--       undisclosed. Measured on a development database before this migration: PIP #12 (employee
--       88) reads 'Auto-initiated from 9-box placement "Underperformer" (low
--       performance)…' and IDP objective #17 (plan 6, employee 89) reads
--       '… (from 9-box "High Performer")', with 0 of 37 placements disclosed.
--       A rule enforced only for new rows is not enforced: the live rows are
--       corrected here, and the correction is recorded in system_logs.
--
--   A3  The software must not open a performance-improvement plan on a human
--       being by itself. An approved low-performance placement now raises a TASK
--       for the manager, who opens the plan with a written reason — or records
--       that no plan is needed, also with a reason. `talent_manager_tasks` is
--       that queue.
--
-- Nothing is deleted: the leak correction rewrites the two employee-facing
-- sentences and keeps the original text in the audit record. Idempotent.

-- 1) Disclosure is an act, not a flag ----------------------------------------
ALTER TABLE nine_box_evaluations ADD COLUMN IF NOT EXISTS disclosed_at      timestamptz;
ALTER TABLE nine_box_evaluations ADD COLUMN IF NOT EXISTS disclosed_by      bigint;
ALTER TABLE nine_box_evaluations ADD COLUMN IF NOT EXISTS disclosed_by_type text;
ALTER TABLE nine_box_evaluations ADD COLUMN IF NOT EXISTS disclosure_reason text;

COMMENT ON COLUMN nine_box_evaluations.disclosed_at IS
    'When the placement was deliberately disclosed to its subject (A4). NULL while confidential.';
COMMENT ON COLUMN nine_box_evaluations.disclosed_by IS
    'Who disclosed it. Employees and admins are different id spaces, hence disclosed_by_type beside it (same pattern as nine_box_events.actor_type).';
COMMENT ON COLUMN nine_box_evaluations.disclosure_reason IS
    'Mandatory justification captured at disclosure time. Un-disclosing clears all four columns and records its own reason in nine_box_events.';

-- disclosed_by_type is meaningless on its own; constrain the vocabulary.
ALTER TABLE nine_box_evaluations DROP CONSTRAINT IF EXISTS chk_ninebox_disclosed_by_type;
ALTER TABLE nine_box_evaluations ADD CONSTRAINT chk_ninebox_disclosed_by_type
    CHECK (disclosed_by_type IS NULL OR disclosed_by_type IN ('admin', 'manager', 'supervisor'));

-- "Disclosed" and "who/when/why" travel together or not at all. This is what
-- stops a later raw UPDATE from publishing a judgement with nobody's name on it.
-- Validated against live data: 0 of 37 placements are disclosed today.
ALTER TABLE nine_box_evaluations DROP CONSTRAINT IF EXISTS chk_ninebox_disclosure_complete;
ALTER TABLE nine_box_evaluations ADD CONSTRAINT chk_ninebox_disclosure_complete
    CHECK (
        disclosed_to_employee IS NOT TRUE
        OR (disclosed_at IS NOT NULL AND length(btrim(COALESCE(disclosure_reason, ''))) > 0)
    );

CREATE INDEX IF NOT EXISTS idx_ninebox_disclosed
    ON nine_box_evaluations (employee_id, disclosed_at DESC)
    WHERE disclosed_to_employee = true;

-- 2) The machine proposes, the manager decides ---------------------------
-- A task is a piece of work waiting on a named human. It carries NO grid
-- vocabulary of its own: `origin_evaluation_id` is provenance, and the manager —
-- who has clearance — reads the cell from the placement itself. That keeps the
-- confidentiality rule true even if a task list is ever surfaced more widely.
CREATE TABLE IF NOT EXISTS talent_manager_tasks (
    id                      bigserial PRIMARY KEY,
    employee_id             bigint NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    -- The hierarchical superior the task is addressed to (supervisor, else
    -- manager). NULL when the person has no superior: the task then shows to
    -- anyone with clearance over them rather than disappearing.
    assignee_employee_id    bigint REFERENCES employees(id) ON DELETE SET NULL,
    kind                    text NOT NULL,
    state                   text NOT NULL DEFAULT 'open',
    origin_evaluation_id    bigint,
    origin_kind             text,
    created_at              timestamptz NOT NULL DEFAULT now(),
    resolved_at             timestamptz,
    resolved_by_employee_id bigint,
    resolved_by_admin_id    bigint,
    resolution              text,
    resolution_reason       text,
    resolved_target_id      bigint,
    CONSTRAINT chk_tmt_kind       CHECK (kind IN ('open_pip')),
    CONSTRAINT chk_tmt_state      CHECK (state IN ('open', 'done', 'dismissed')),
    CONSTRAINT chk_tmt_resolution CHECK (resolution IS NULL OR resolution IN ('plan_opened', 'no_plan')),
    -- Closing a task is a decision about a person: it names its author, its date
    -- and its reason, or it does not happen.
    CONSTRAINT chk_tmt_resolved_complete CHECK (
        state = 'open'
        OR (resolved_at IS NOT NULL
            AND resolution IS NOT NULL
            AND length(btrim(COALESCE(resolution_reason, ''))) > 0)
    )
);

COMMENT ON TABLE talent_manager_tasks IS
    'A3: an approved low-performance placement raises a task here instead of opening a PIP. The plan is created only by a human act carrying a written reason.';

-- One open task per person per kind, so re-approving the same placement (which
-- the 9-box explicitly allows, unlimited) never stacks a second identical task.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tmt_open_per_employee_kind
    ON talent_manager_tasks (employee_id, kind) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS idx_tmt_assignee_open
    ON talent_manager_tasks (assignee_employee_id) WHERE state = 'open';

-- 3) Correct the live confidentiality leak (A4b) ------------------------------
-- The original wording is copied into system_logs BEFORE the rewrite, so the
-- correction is auditable and nothing is lost. Both statements are scoped by the
-- vocabulary regex, so re-running the migration corrects nothing twice.
INSERT INTO system_logs (admin_id, action, entity_type, entity_id, details, category, severity)
SELECT NULL, 'NINEBOX_LEAK_CORRECTION', 'pip', p.id,
       jsonb_build_object('field', 'summary', 'was', p.summary,
                          'why', 'A4: employee-facing prose named the confidential 9-box cell'),
       'talent', 'warning'
  FROM pips p
 WHERE p.summary ~* '(9[- ]?box|nine[- ]?box|Underperformer|Diamond in the rough|Shooting Star|Gold Star|Critical Contributor|Emerging Star|Essential Contributor|Trusted Professional|Core Player|Growth Employee|High Performer)'
    OR p.summary ~ '\m(Concern|Dilemma)\M';

UPDATE pips
   SET summary = 'Plan d’amélioration ouvert à la suite d’une revue de performance. '
               || 'Objectif : progresser sur les compétences critiques du poste avec un accompagnement (coaching/mentorat).',
       updated_at = now()
 WHERE summary ~* '(9[- ]?box|nine[- ]?box|Underperformer|Diamond in the rough|Shooting Star|Gold Star|Critical Contributor|Emerging Star|Essential Contributor|Trusted Professional|Core Player|Growth Employee|High Performer)'
    OR summary ~ '\m(Concern|Dilemma)\M';

INSERT INTO system_logs (admin_id, action, entity_type, entity_id, details, category, severity)
SELECT NULL, 'NINEBOX_LEAK_CORRECTION', 'idpObjective', o.id,
       jsonb_build_object('field', 'smart_text', 'was', o.smart_text,
                          'why', 'A4: employee-facing prose named the confidential 9-box cell'),
       'talent', 'warning'
  FROM idp_objectives o
 WHERE o.smart_text ~* '(9[- ]?box|nine[- ]?box|Underperformer|Diamond in the rough|Shooting Star|Gold Star|Critical Contributor|Emerging Star|Essential Contributor|Trusted Professional|Core Player|Growth Employee|High Performer)'
    OR o.smart_text ~ '\m(Concern|Dilemma)\M';

-- Strip the trailing provenance clause only — the development objective itself
-- (the skill and the levels) is what the person must act on and is kept.
UPDATE idp_objectives
   SET smart_text = btrim(regexp_replace(
           smart_text,
           '\s*[\(（][^)）]*(9[- ]?box|nine[- ]?box)[^)）]*[\)）]\s*$', '', 'gi'))
 WHERE smart_text ~* '(9[- ]?box|nine[- ]?box)';

INSERT INTO schema_meta(key, value) VALUES ('115_ninebox_disclosure_and_manager_tasks', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();
