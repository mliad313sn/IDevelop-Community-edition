-- 12_ninebox_cell_position.sql
-- Fine-grained positioning of an employee WITHIN a 9-box cell:
--   cell_tier  : vertical band inside the cell — 1 = upper (trending up),
--                2 = middle, 3 = lower.
--   cell_trend : horizontal lean — 'up' (improving → right), 'stable' (center),
--                'down' (declining → left).
-- Together they place each person in a 3×3 micro-grid inside their box, so
-- people sharing a cell are differentiated by their relative trend/position.
-- Idempotent.

ALTER TABLE nine_box_evaluations ADD COLUMN IF NOT EXISTS cell_tier  SMALLINT NOT NULL DEFAULT 2;
ALTER TABLE nine_box_evaluations ADD COLUMN IF NOT EXISTS cell_trend TEXT     NOT NULL DEFAULT 'stable';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_nb_cell_tier') THEN
    ALTER TABLE nine_box_evaluations ADD CONSTRAINT chk_nb_cell_tier  CHECK (cell_tier BETWEEN 1 AND 3);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_nb_cell_trend') THEN
    ALTER TABLE nine_box_evaluations ADD CONSTRAINT chk_nb_cell_trend CHECK (cell_trend IN ('up','stable','down'));
  END IF;
END $$;
