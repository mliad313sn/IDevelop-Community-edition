-- 176 — where an official skill level comes from (skill_assessments.validation).
--
-- The column (enum skill_validation, migration 29, DEFAULT 'self') was never
-- written by any path, so every official level read 'self', including the
-- levels a reviewer, an approval or a dispute decision had set. From this
-- release every writer states it: an assessor's entry, a reviewed or approved
-- self-assessment, a dispute decision and a validated training completion write
-- 'manager_validated'; an import that changes a level writes 'self'.
--
-- Backfill: ONLY rows whose origin is PROVEN by the note the promotion path
-- itself wrote, all still marked 'self':
--   'Set from …'                        an approved self-assessment, a
--                                       supervisor-validated rating, a
--                                       supervisor-validated training completion
--   'Set by dispute resolution …'       the decided rating of a dispute
--   'Validated by supervisor review …'  the level set by a supervisor review
-- Nothing else is touched: a level whose origin cannot be shown stays 'self'
-- and is never labelled validated without proof. The level, its date and its
-- assessor are unchanged; the history trigger logs level changes only, so no
-- history row is written. Idempotent (a second run finds nothing left to
-- change). Nothing is deleted.

UPDATE public.skill_assessments
   SET validation = 'manager_validated'
 WHERE validation = 'self'
   AND (notes LIKE 'Set from %'
        OR notes LIKE 'Set by dispute resolution%'
        OR notes LIKE 'Validated by supervisor review%');
