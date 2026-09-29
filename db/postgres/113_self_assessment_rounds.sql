-- 113_self_assessment_rounds.sql
-- "one measurement per round".
--
-- THE DEFECT (HR1-04 / HR3-21). The product kept EXACTLY ONE row per
-- (employee, skill), forced by UNIQUE (employee_id, skill_id, status). A new
-- campaign therefore REWROTE that row — level, notes and the campaign it
-- belongs to — and the service deleted any duplicate outright. Progression was
-- unshowable (there were never two measurements to compare) and the delete
-- broke the house rule "nothing is ever deleted".
--
-- THE DECISION. Each round of measurement is its OWN record, dated, attached to
-- its campaign (cycle_id) or marked "off-campaign" (cycle_id IS NULL), kept for
-- ever. The CURRENT measurement is the most recent one; earlier rounds are
-- never modified and never erased.
--
-- HOW, without rewriting the 25 places that read "the" measurement:
--   * the physical table becomes `self_assessment_rounds` and holds EVERY round;
--   * `self_assessments` stays, as an auto-updatable VIEW over the rounds that
--     are still current (superseded_at IS NULL). Every existing reader and
--     writer therefore keeps meaning exactly what it meant before — "the
--     current measurement" — with no code change, and history simply cannot
--     leak into a review queue, a campaign counter or a dashboard tile.
--   * the UNIQUE (employee_id, skill_id, status) constraint that forced the old
--     design is DROPPED and replaced by a stronger, honest invariant:
--     at most ONE CURRENT round per (employee, skill).
--
-- DATA CARRY-OVER IS LOSSLESS: nothing is deleted here. Rows that already
-- duplicate a (employee, skill) pair (possible on installations that pre-date
-- the unique constraint, or that carry one row per status) are RECONCILED —
-- ordered by date, numbered, and all but the newest marked superseded, each
-- pointing at the round that replaced it.
--
-- No BEGIN/COMMIT here: db.migrate already runs each file inside one
-- transaction on one connection, and a COMMIT in the file would end THAT
-- transaction early and split the migration from its schema_meta stamp.

DO $$
DECLARE
    v_kind "char";
BEGIN
    SELECT c.relkind INTO v_kind FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'self_assessments';

    -- Idempotent: only rename while `self_assessments` is still the base table.
    IF v_kind = 'r' THEN
        ALTER TABLE public.self_assessments RENAME TO self_assessment_rounds;
    END IF;
END $$;

-- The index that forced one row per (employee, skill). Dropped explicitly: it
-- is the root cause named in the rulebook, not collateral damage.
ALTER TABLE public.self_assessment_rounds
    DROP CONSTRAINT IF EXISTS self_assessments_employee_id_skill_id_status_key;

ALTER TABLE public.self_assessment_rounds
    ADD COLUMN IF NOT EXISTS round_no smallint NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS superseded_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS superseded_by bigint;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'self_assessment_rounds_superseded_by_fkey') THEN
        ALTER TABLE public.self_assessment_rounds
            ADD CONSTRAINT self_assessment_rounds_superseded_by_fkey
            FOREIGN KEY (superseded_by) REFERENCES public.self_assessment_rounds(id) ON DELETE SET NULL;
    END IF;
END $$;

COMMENT ON TABLE  public.self_assessment_rounds IS
    'Every round of self-assessment ever measured. One row per (employee, skill, round). Append-only in practice: earlier rounds are superseded, never rewritten or deleted (A1, 2026-09-13).';
COMMENT ON COLUMN public.self_assessment_rounds.round_no IS
    'Measurement round for this (employee, skill), 1-based, in chronological order.';
COMMENT ON COLUMN public.self_assessment_rounds.superseded_at IS
    'NULL = this is the CURRENT measurement. Set when a later round replaces it.';
COMMENT ON COLUMN public.self_assessment_rounds.superseded_by IS
    'The round that replaced this one.';
COMMENT ON COLUMN public.self_assessment_rounds.cycle_id IS
    'The campaign this round was measured in. NULL = measured off-campaign ("hors campagne") — dated and marked, never counted in a campaign rate.';

-- ---- Lossless carry-over of the existing rows -----------------------------
-- Number every round chronologically inside its (employee, skill) pair, and
-- mark every round but the newest as superseded by its successor. On a database
-- with no duplicates (the expected case) this touches nothing: every pair has
-- exactly one row, which stays round 1 and stays current.
WITH ordered AS (
    SELECT id, employee_id, skill_id,
           row_number() OVER (PARTITION BY employee_id, skill_id
                              ORDER BY created_at, id) AS rn,
           lead(id)         OVER (PARTITION BY employee_id, skill_id
                              ORDER BY created_at, id) AS next_id,
           lead(created_at) OVER (PARTITION BY employee_id, skill_id
                              ORDER BY created_at, id) AS next_created_at
      FROM public.self_assessment_rounds
)
UPDATE public.self_assessment_rounds r
   SET round_no      = o.rn::smallint,
       superseded_at = CASE WHEN o.next_id IS NULL THEN r.superseded_at
                            ELSE COALESCE(r.superseded_at, o.next_created_at) END,
       superseded_by = CASE WHEN o.next_id IS NULL THEN r.superseded_by
                            ELSE COALESCE(r.superseded_by, o.next_id) END
  FROM ordered o
 WHERE o.id = r.id
   AND (r.round_no IS DISTINCT FROM o.rn::smallint
        OR (o.next_id IS NOT NULL AND r.superseded_at IS NULL));

-- THE replacement invariant: one current measurement per (employee, skill).
-- Weaker constraints let two live rows exist and the whole product assumes one.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sa_current_round
    ON public.self_assessment_rounds (employee_id, skill_id)
 WHERE superseded_at IS NULL;

-- The progression read: every round of one person, newest first.
CREATE INDEX IF NOT EXISTS idx_sa_rounds_emp_skill_round
    ON public.self_assessment_rounds (employee_id, skill_id, round_no DESC);

-- ---- `self_assessments` = the CURRENT measurement, as it always was -------
-- Auto-updatable (single base relation, no aggregate/DISTINCT/window), so
-- INSERT / UPDATE / DELETE / ON CONFLICT / RETURNING all keep working exactly
-- as they did against the table. Column list is the table's original 18
-- columns, in order, so `SELECT *` keeps its shape.
CREATE OR REPLACE VIEW public.self_assessments AS
    SELECT id, employee_id, skill_id, self_rated_level, status, submitted_at,
           reviewed_at, reviewed_by, notes, created_at, updated_at, cycle_id,
           justification, locked_state, workflow_state, approved_by, approved_at,
           current_reviewer_id
      FROM public.self_assessment_rounds
     WHERE superseded_at IS NULL;

COMMENT ON VIEW public.self_assessments IS
    'The CURRENT measurement per (employee, skill) — the most recent round. Earlier rounds live in self_assessment_rounds and are read by the progression page.';

INSERT INTO schema_meta(key, value) VALUES ('113_self_assessment_rounds', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();
