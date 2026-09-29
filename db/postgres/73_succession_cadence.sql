-- ============================================================================
-- 73 — Succession cadence + nomination attribution.
--
--   `succession_plans.review_due` shipped in 24_continuity.sql but was never
--   written nor read by any code path, so a plan, once opened, was never
--   revisited and nothing ever prompted a leader to act. This migration adds
--   the two columns the cadence needs (when a plan was last reviewed and by
--   whom) and the attribution a nomination needs (who put this person on the
--   bench, and when), then backfills a first review date for the plans that
--   already exist so the cadence starts running for them too.
--
--   Additive & idempotent: safe to re-run.
-- ============================================================================

-- ---- 1) Plan review cadence -------------------------------------------------
ALTER TABLE public.succession_plans
    ADD COLUMN IF NOT EXISTS last_reviewed_at timestamptz;

ALTER TABLE public.succession_plans
    ADD COLUMN IF NOT EXISTS reviewed_by bigint REFERENCES public.admins(id) ON DELETE SET NULL;

-- Plans opened before this migration have no review date at all — give them
-- one so they surface in the "à revoir" queue instead of staying invisible.
-- Only fills NULLs, so re-running changes nothing.
UPDATE public.succession_plans
   SET review_due = (created_at + interval '6 months')::date
 WHERE review_due IS NULL
   AND status <> 'archived';

-- The due-for-review queue reads this predicate on every continuity page load.
CREATE INDEX IF NOT EXISTS idx_succession_plan_review_due
    ON public.succession_plans (review_due)
    WHERE status <> 'archived';

-- ---- 2) Nomination attribution ---------------------------------------------
-- Who nominated this successor, and when. Auto-seeded rows keep a NULL
-- nominated_by (the system nominated them) but still get a nominated_at.
ALTER TABLE public.successors
    ADD COLUMN IF NOT EXISTS nominated_by bigint REFERENCES public.admins(id) ON DELETE SET NULL;

ALTER TABLE public.successors
    ADD COLUMN IF NOT EXISTS nominated_at timestamptz DEFAULT now();

UPDATE public.successors
   SET nominated_at = created_at
 WHERE nominated_at IS NULL;
