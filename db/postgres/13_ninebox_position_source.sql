-- 13_ninebox_position_source.sql
-- Records whether the in-cell position (tier/trend) was the system's auto
-- suggestion accepted as-is ('system') or readjusted by the manager ('manager').
-- Idempotent.

ALTER TABLE nine_box_evaluations ADD COLUMN IF NOT EXISTS position_source TEXT NOT NULL DEFAULT 'manager';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_nb_position_source') THEN
    ALTER TABLE nine_box_evaluations ADD CONSTRAINT chk_nb_position_source CHECK (position_source IN ('system','manager'));
  END IF;
END $$;
