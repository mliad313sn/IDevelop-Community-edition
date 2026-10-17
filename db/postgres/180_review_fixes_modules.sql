-- 180 — Nothing is deleted any more, and every decision says who, when and why.
--
--   successors          a successor is REMOVED, never deleted: state
--                       ('active' | 'removed'), removed_by (an actor ref,
--                       'admin:<id>' / 'employee:<id>'), removed_at,
--                       removed_reason. v_continuity_coverage counts active
--                       successors only.
--   lms_completions     decided_by_ref, decided_at, decision_reason on a
--                       proposed uplift, accepted or declined (the reason is
--                       required on a decline: the service enforces it, and a
--                       CHECK holds it for every decision recorded from now on).
--   coverage_rules      deactivated_reason / _at / _by (is_active exists).
--   planned_absences    is_active + deactivated_reason / _at / _by: a cancelled
--                       absence leaves the lists and the prediction.
--
-- Additive and idempotent (IF NOT EXISTS, guarded constraints). Nothing is
-- deleted, and every existing row keeps its meaning (state 'active',
-- is_active true). The reasons are free text about a person: they are covered
-- by the erasure registry (src/services/erasureRegistry.js).
--
-- v_continuity_coverage is recreated with the columns and order of migration
-- 24 (no later migration replaced it); only the bench is limited to active
-- successors.

-- ---- successors -------------------------------------------------------------
ALTER TABLE public.successors ADD COLUMN IF NOT EXISTS state          text NOT NULL DEFAULT 'active';
ALTER TABLE public.successors ADD COLUMN IF NOT EXISTS removed_by     text;
ALTER TABLE public.successors ADD COLUMN IF NOT EXISTS removed_at     timestamptz;
ALTER TABLE public.successors ADD COLUMN IF NOT EXISTS removed_reason text;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_successor_state') THEN
        ALTER TABLE public.successors
            ADD CONSTRAINT chk_successor_state CHECK (state IN ('active', 'removed'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_successor_removed') THEN
        ALTER TABLE public.successors
            ADD CONSTRAINT chk_successor_removed CHECK (
                state <> 'removed'
                OR (removed_at IS NOT NULL AND length(btrim(COALESCE(removed_reason, ''))) > 0)
            );
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_successors_plan_active
    ON public.successors (plan_id) WHERE state = 'active';

CREATE OR REPLACE VIEW public.v_continuity_coverage AS
SELECT
    rc.role_id,
    r.name                                            AS role_name,
    rc.criticality_score,
    rc.vacancy_risk,
    sp.id                                             AS plan_id,
    sp.status                                         AS plan_status,
    sp.incumbent_employee_id,
    COUNT(s.id)                                       AS bench_depth,
    COUNT(s.id) FILTER (WHERE s.readiness_band = 'ready_now')   AS ready_now_count,
    COUNT(s.id) FILTER (WHERE s.readiness_band = 'emergency')   AS emergency_count,
    (COUNT(s.id) FILTER (WHERE s.readiness_band = 'ready_now') = 0) AS has_coverage_gap,
    rr.flight_risk                                    AS incumbent_flight_risk,
    rr.impact_of_loss                                 AS incumbent_impact_of_loss
FROM public.role_criticality rc
JOIN public.roles r ON r.id = rc.role_id
LEFT JOIN public.succession_plans sp
       ON sp.position_role_id = rc.role_id AND sp.status <> 'archived'
LEFT JOIN public.successors s ON s.plan_id = sp.id AND s.state = 'active'
LEFT JOIN public.retention_risk rr ON rr.employee_id = sp.incumbent_employee_id
GROUP BY rc.role_id, r.name, rc.criticality_score, rc.vacancy_risk,
         sp.id, sp.status, sp.incumbent_employee_id,
         rr.flight_risk, rr.impact_of_loss;

-- ---- lms_completions ----------------------------------------------------------
ALTER TABLE public.lms_completions ADD COLUMN IF NOT EXISTS decided_by_ref  text;
ALTER TABLE public.lms_completions ADD COLUMN IF NOT EXISTS decided_at      timestamptz;
ALTER TABLE public.lms_completions ADD COLUMN IF NOT EXISTS decision_reason text;

DO $$
BEGIN
    -- A decline (review_reason 'declined_by_supervisor') recorded from now on
    -- carries its reason; earlier declines (decided_at NULL) stay readable.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_lms_decline_reason') THEN
        ALTER TABLE public.lms_completions
            ADD CONSTRAINT chk_lms_decline_reason CHECK (
                decided_at IS NULL
                OR COALESCE(review_reason, '') <> 'declined_by_supervisor'
                OR length(btrim(COALESCE(decision_reason, ''))) > 0
            );
    END IF;
END $$;

-- ---- coverage_rules / planned_absences -----------------------------------------
ALTER TABLE public.coverage_rules ADD COLUMN IF NOT EXISTS deactivated_reason text;
ALTER TABLE public.coverage_rules ADD COLUMN IF NOT EXISTS deactivated_at     timestamptz;
ALTER TABLE public.coverage_rules ADD COLUMN IF NOT EXISTS deactivated_by     text;

ALTER TABLE public.planned_absences ADD COLUMN IF NOT EXISTS is_active          boolean NOT NULL DEFAULT true;
ALTER TABLE public.planned_absences ADD COLUMN IF NOT EXISTS deactivated_reason text;
ALTER TABLE public.planned_absences ADD COLUMN IF NOT EXISTS deactivated_at     timestamptz;
ALTER TABLE public.planned_absences ADD COLUMN IF NOT EXISTS deactivated_by     text;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_absence_deactivated') THEN
        ALTER TABLE public.planned_absences
            ADD CONSTRAINT chk_absence_deactivated CHECK (
                is_active OR deactivated_at IS NULL
                OR length(btrim(COALESCE(deactivated_reason, ''))) > 0
            );
    END IF;
END $$;

-- The SQL console reads the new columns and the recreated view.
SELECT public.fn_console_reader_sync();
