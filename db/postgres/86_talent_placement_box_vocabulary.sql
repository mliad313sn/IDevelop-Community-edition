-- FMEA (criticality 700) — the 9-box mirror wrote a value nothing can read.
--
-- `nine_box_evaluations.box` is a SMALLINT 1-9 used for display. `talent_placements
-- .box` is TEXT, and every consumer parses it as "{potential}-{performance}":
-- BiasDetectionService.boxScore, DEIService, CopilotService, ReportDataService,
-- TalentDepthService. The approval mirror passed the integer, so the column stored
-- "4" and `boxScore("4")` returned 0 — every employee placed through the 9-box
-- pulled the cohort mean down, fabricating or masking discrimination alerts in the
-- reports HR and the executive design review read.
--
-- The service now writes the vocabulary key. This repairs rows already stored.
-- `computeBox` is BAND[potential] * 3 + BAND[performance] + 1 with low=0, medium=1,
-- high=2, so the integer inverts deterministically:
--   idx = box - 1 ; potential = idx / 3 ; performance = idx % 3
-- Rows that already hold a vocabulary key are left untouched.

UPDATE talent_placements
   SET box = (ARRAY['low', 'medium', 'high'])[((box::int - 1) / 3) + 1]
             || '-' ||
             (ARRAY['low', 'medium', 'high'])[((box::int - 1) % 3) + 1]
 WHERE box ~ '^[1-9]$';
