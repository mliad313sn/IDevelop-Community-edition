-- FMEA #2 (criticality 420) and #3 (criticality 405)
--
-- `supervisor_reviews.gap` is the number the employee reads to decide whether to
-- contest a review. Two defects made it untrustworthy:
--
--   #3  The row was created AT SUBMIT with supervisor_rated_level = the employee's
--       own rating, gap = 0 and reviewed_at = now. Before anyone had looked at
--       the assessment the page already announced "Superviseur 1 / Ecart 0" with a
--       green "d'accord" badge, and stamped a review date.
--   #2  When the supervisor then genuinely disagreed, the V2 workflow wrote the new
--       supervisor_rated_level but never recomputed `gap`. Verified by probe: a
--       rating moved 1 -> 3 still stored gap 0, so the employee read "Ecart 0" on a
--       divergence of 2 - on the very column that drives the dispute decision.
--
-- A review nobody has performed has no rating, no gap and no date. Those three
-- columns therefore become nullable, and NULL now means "not reviewed yet".

ALTER TABLE supervisor_reviews ALTER COLUMN supervisor_rated_level DROP NOT NULL;
ALTER TABLE supervisor_reviews ALTER COLUMN gap DROP NOT NULL;
ALTER TABLE supervisor_reviews ALTER COLUMN reviewed_at DROP NOT NULL;
ALTER TABLE supervisor_reviews ALTER COLUMN reviewed_at DROP DEFAULT;

-- Clear the fabricated rating/gap/date from every review still awaiting a decision.
UPDATE supervisor_reviews
   SET supervisor_rated_level = NULL, gap = NULL, reviewed_at = NULL
 WHERE status = 'pending' AND decision IS NULL;

-- Repair any completed row whose stored gap disagrees with its own two ratings.
UPDATE supervisor_reviews sr
   SET gap = sr.supervisor_rated_level - sa.self_rated_level
  FROM self_assessments sa
 WHERE sa.id = sr.self_assessment_id
   AND sr.supervisor_rated_level IS NOT NULL
   AND sa.self_rated_level IS NOT NULL
   AND sr.gap IS DISTINCT FROM (sr.supervisor_rated_level - sa.self_rated_level);
