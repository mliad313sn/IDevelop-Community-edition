-- 72_talent_chain.sql
-- PROVENANCE for the automated talent chain: ASSESSMENT → 9-box placement → plan.
--
-- PROBLEM
--   DevelopmentTriggerService opens a PIP (red zone) or an IDP (blue zone) as a
--   side-effect of an approved 9-box placement, but the created row carried NO
--   pointer back to the evaluation that caused it. The link existed only as free
--   text in system_logs / nine_box_events, so "why does this person have a PIP?"
--   could not be answered by a query, and a disputed placement could not be
--   traced to the plans it produced.
--
-- WHAT THIS MIGRATION DOES
--   Adds a nullable origin_evaluation_id to pips and idp_plans, referencing
--   nine_box_evaluations(id) ON DELETE SET NULL (deleting an evaluation must
--   never cascade-delete somebody's improvement or development plan — it only
--   loses the provenance pointer), plus one index per table so the reverse
--   lookup "which plans came from this evaluation?" is cheap.
--
-- SCOPE / SAFETY
--   * Additive and idempotent — ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT
--     EXISTS. No existing column, constraint or row is touched, so every current
--     reader and writer of pips / idp_plans keeps working unchanged.
--   * NULL is a normal value: manually created plans, plans created before this
--     migration, and plans triggered by a V2 talent_placements override with no
--     matching 9-box evaluation all legitimately have no origin.
--   * THESE COLUMNS ARE PROVENANCE ONLY. They must NEVER be read by an
--     authorization guard, a clearance check or a disclosure decision — the
--     employee's right to see their placement is governed solely by
--     nine_box_evaluations.disclosed_to_employee, and joining a plan back to an
--     evaluation must not become a side channel around it.
--   * Nothing here reduces the number of skills per role.

ALTER TABLE public.pips      ADD COLUMN IF NOT EXISTS origin_evaluation_id bigint
    REFERENCES public.nine_box_evaluations(id) ON DELETE SET NULL;
ALTER TABLE public.idp_plans ADD COLUMN IF NOT EXISTS origin_evaluation_id bigint
    REFERENCES public.nine_box_evaluations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_pips_origin_evaluation
    ON public.pips (origin_evaluation_id);
CREATE INDEX IF NOT EXISTS idx_idp_plans_origin_evaluation
    ON public.idp_plans (origin_evaluation_id);

COMMENT ON COLUMN public.pips.origin_evaluation_id IS
    'Provenance only: the nine_box_evaluations row whose approval auto-opened this PIP. '
    'NULL for manually created plans. NEVER read this in an authorization or disclosure check.';
COMMENT ON COLUMN public.idp_plans.origin_evaluation_id IS
    'Provenance only: the nine_box_evaluations row whose approval auto-opened this IDP. '
    'NULL for manually created plans. NEVER read this in an authorization or disclosure check.';
