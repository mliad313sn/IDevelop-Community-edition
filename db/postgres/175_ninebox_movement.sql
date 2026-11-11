-- 175 — 9-box movements: where a placement comes from, and why it changed.
--
-- Until now a placement stood alone: nothing recorded the box the person held
-- before, and a move from a high box to a low one carried no written reason.
--
--   previous_*              SNAPSHOT of the person's previous APPROVED placement,
--                           taken when the new one is submitted (or approved
--                           straight from a draft). A snapshot, so a later edit of
--                           either row never rewrites the history of the move.
--   movement_direction      first | stable | up | down | lateral, derived from the
--                           two axes (NineBoxService.movementDirection).
--   movement_justification  the written reason of the LATEST box change, with
--   + _by / _by_type / _at  who gave it and when. Required (at least 20
--                           characters, a real sentence, not a copy of the
--                           previous reason) when the box differs from the
--                           previous one. Each change is also logged in
--                           nine_box_events, ids only.
--   movement_cycle_id       the campaign the move belongs to when the evaluation
--                           itself carries no cycle_id.
--   movement_backfilled     true when the snapshot below was rebuilt from history
--                           for a placement decided before the rule existed.
--
-- The stored box labels are unchanged: the pages name a box from its number
-- through the talentx catalogue, in the reader's language.
--
-- Additive and idempotent: nullable columns, one self-referencing FK (ON DELETE
-- SET NULL), three CHECKs, two indexes and a backfill of the snapshot for
-- decided placements that have none. The backfill never invents a reason: the
-- justification of a rebuilt move stays NULL ("no reason recorded").

ALTER TABLE nine_box_evaluations ADD COLUMN IF NOT EXISTS previous_evaluation_id     bigint;
ALTER TABLE nine_box_evaluations ADD COLUMN IF NOT EXISTS previous_box               smallint;
ALTER TABLE nine_box_evaluations ADD COLUMN IF NOT EXISTS previous_performance       text;
ALTER TABLE nine_box_evaluations ADD COLUMN IF NOT EXISTS previous_potential         text;
ALTER TABLE nine_box_evaluations ADD COLUMN IF NOT EXISTS previous_cycle_id          bigint;
ALTER TABLE nine_box_evaluations ADD COLUMN IF NOT EXISTS previous_approved_at       timestamptz;
ALTER TABLE nine_box_evaluations ADD COLUMN IF NOT EXISTS movement_direction         text;
ALTER TABLE nine_box_evaluations ADD COLUMN IF NOT EXISTS movement_snapshot_at       timestamptz;
ALTER TABLE nine_box_evaluations ADD COLUMN IF NOT EXISTS movement_backfilled        boolean NOT NULL DEFAULT false;
ALTER TABLE nine_box_evaluations ADD COLUMN IF NOT EXISTS movement_cycle_id          bigint;
ALTER TABLE nine_box_evaluations ADD COLUMN IF NOT EXISTS movement_justification     text;
ALTER TABLE nine_box_evaluations ADD COLUMN IF NOT EXISTS movement_justified_by      bigint;
ALTER TABLE nine_box_evaluations ADD COLUMN IF NOT EXISTS movement_justified_by_type text;
ALTER TABLE nine_box_evaluations ADD COLUMN IF NOT EXISTS movement_justified_at      timestamptz;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ninebox_previous_evaluation') THEN
        ALTER TABLE nine_box_evaluations
            ADD CONSTRAINT fk_ninebox_previous_evaluation
            FOREIGN KEY (previous_evaluation_id) REFERENCES nine_box_evaluations(id) ON DELETE SET NULL;
    END IF;
END $$;

ALTER TABLE nine_box_evaluations DROP CONSTRAINT IF EXISTS chk_ninebox_movement_direction;
ALTER TABLE nine_box_evaluations ADD CONSTRAINT chk_ninebox_movement_direction
    CHECK (movement_direction IS NULL OR movement_direction IN ('first', 'stable', 'up', 'down', 'lateral'));

ALTER TABLE nine_box_evaluations DROP CONSTRAINT IF EXISTS chk_ninebox_movement_justified_by_type;
ALTER TABLE nine_box_evaluations ADD CONSTRAINT chk_ninebox_movement_justified_by_type
    CHECK (movement_justified_by_type IS NULL OR movement_justified_by_type IN ('admin', 'employee'));

ALTER TABLE nine_box_evaluations DROP CONSTRAINT IF EXISTS chk_ninebox_previous_bands;
ALTER TABLE nine_box_evaluations ADD CONSTRAINT chk_ninebox_previous_bands
    CHECK (
        (previous_performance IS NULL OR previous_performance IN ('low', 'medium', 'high'))
        AND (previous_potential IS NULL OR previous_potential IN ('low', 'medium', 'high'))
        AND (previous_box IS NULL OR previous_box BETWEEN 1 AND 9)
    );

COMMENT ON COLUMN nine_box_evaluations.previous_evaluation_id IS
    'Snapshot (migration 175): the person''s previous APPROVED evaluation, taken at submission (or at approval from a draft). NULL with movement_direction = first when there was none.';
COMMENT ON COLUMN nine_box_evaluations.movement_justification IS
    'Written reason of the latest box change (at least 20 characters when the box differs from previous_box). Confidential: never shown to the person, never sent by e-mail, withheld from the self-service export, redacted on erasure.';
COMMENT ON COLUMN nine_box_evaluations.movement_backfilled IS
    'True when migration 175 rebuilt the snapshot from history for a placement decided before a reason was required (no reason was ever asked for).';

CREATE INDEX IF NOT EXISTS idx_ninebox_previous_evaluation
    ON nine_box_evaluations (previous_evaluation_id) WHERE previous_evaluation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ninebox_movement_decided
    ON nine_box_evaluations (employee_id, approved_at DESC) WHERE approved_at IS NOT NULL;

-- BACKFILL: decided placements (approved, or superseded into 'archived') that
-- have no snapshot yet. The previous placement is the latest OTHER decided
-- placement of the same person approved strictly before, leaving out those
-- cancelled from the maintenance panel (a mistake is not a position anyone
-- held). Rows that already carry a snapshot are never touched, so a second run
-- changes nothing.
WITH decided AS (
    SELECT n.id, n.employee_id, n.approved_at
      FROM nine_box_evaluations n
     WHERE n.approved_at IS NOT NULL
       AND n.status IN ('approved', 'archived')
       AND n.movement_snapshot_at IS NULL
), prev AS (
    SELECT d.id AS cur_id, p.*
      FROM decided d
      LEFT JOIN LATERAL (
          SELECT o.id AS p_id, o.box AS p_box, o.performance AS p_perf, o.potential AS p_pot,
                 COALESCE(o.cycle_id, o.movement_cycle_id) AS p_cycle, o.approved_at AS p_at
            FROM nine_box_evaluations o
           WHERE o.employee_id = d.employee_id
             AND o.id <> d.id
             AND o.approved_at IS NOT NULL
             AND o.approved_at < d.approved_at
             AND o.status IN ('approved', 'archived')
             AND NOT (o.status = 'archived' AND EXISTS (
                     SELECT 1 FROM nine_box_events c
                      WHERE c.evaluation_id = o.id AND c.action = 'cancel'))
           ORDER BY o.approved_at DESC, o.id DESC
           LIMIT 1
      ) p ON true
)
UPDATE nine_box_evaluations n
   SET previous_evaluation_id = prev.p_id,
       previous_box           = prev.p_box,
       previous_performance   = prev.p_perf,
       previous_potential     = prev.p_pot,
       previous_cycle_id      = prev.p_cycle,
       previous_approved_at   = prev.p_at,
       movement_direction     = CASE
           WHEN prev.p_id IS NULL THEN 'first'
           WHEN prev.p_perf = n.performance AND prev.p_pot = n.potential THEN 'stable'
           WHEN array_position(ARRAY['low','medium','high'], n.performance) >= array_position(ARRAY['low','medium','high'], prev.p_perf)
            AND array_position(ARRAY['low','medium','high'], n.potential)   >= array_position(ARRAY['low','medium','high'], prev.p_pot) THEN 'up'
           WHEN array_position(ARRAY['low','medium','high'], n.performance) <= array_position(ARRAY['low','medium','high'], prev.p_perf)
            AND array_position(ARRAY['low','medium','high'], n.potential)   <= array_position(ARRAY['low','medium','high'], prev.p_pot) THEN 'down'
           ELSE 'lateral'
       END,
       movement_snapshot_at   = now(),
       movement_backfilled    = true
  FROM prev
 WHERE n.id = prev.cur_id
   AND n.movement_snapshot_at IS NULL;

-- The SQL console reader sees the new columns (migration 168).
SELECT public.fn_console_reader_sync();
