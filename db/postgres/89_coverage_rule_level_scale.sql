-- FMEA (criticality 144) — a coverage rule nobody can ever satisfy.
--
-- The competency scale is 0-4: `skill_assessments.current_level` carries a CHECK
-- for exactly that, and the levels actually present in this database run 0..4.
-- `coverage_rules.min_level` accepted 1-5, and `CoverageService` clamped input to
-- that same wrong range.
--
-- A safe-shift rule written at "level >= 5" can therefore never be met by anyone.
-- It becomes a permanent critical breach: alerted once, then sitting on
-- /compliance for good, while people are sent to training for a threshold that
-- does not exist. The bulk generator creates rules in batches, so one wrong
-- choice scales to hundreds.
--
-- Any existing level-5 rule is lowered to 4 — the top of the real scale, which is
-- the strictest thing the author could actually have meant.

UPDATE coverage_rules SET min_level = 4 WHERE min_level > 4;

ALTER TABLE coverage_rules DROP CONSTRAINT IF EXISTS coverage_rules_min_level_check;
ALTER TABLE coverage_rules ADD CONSTRAINT coverage_rules_min_level_check
    CHECK (min_level BETWEEN 1 AND 4);
