-- ============================================================================
-- Phase 1 — People Continuity core.
--   Succession planning, bench/successors, retention (risk-of-loss), emergency
--   cover, knowledge handover, and a coverage view. Builds ON existing data
--   (employees, roles, role_skill_requirements, talent_placements,
--   lifecycle_events) — no org-data duplication.
--   Additive & idempotent: safe to re-run.
-- ============================================================================

-- ---- Enums (guarded so the migration is idempotent) ------------------------
DO $$ BEGIN
    CREATE TYPE public.continuity_plan_status AS ENUM ('draft','active','under_review','archived');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE public.readiness_band AS ENUM ('ready_now','ready_1_2y','ready_3y','emergency');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE public.successor_source AS ENUM ('auto_9box','auto_readiness','manual');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE public.risk_level AS ENUM ('low','medium','high');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE public.confidentiality_tier AS ENUM ('standard','restricted','sealed');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE public.handover_status AS ENUM ('open','in_progress','completed','cancelled');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ---- 1) Critical roles -----------------------------------------------------
CREATE TABLE IF NOT EXISTS public.role_criticality (
    role_id            bigint PRIMARY KEY REFERENCES public.roles(id) ON DELETE CASCADE,
    criticality_score  smallint NOT NULL DEFAULT 3,   -- 1 (low) .. 5 (mission-critical)
    business_impact    text,
    vacancy_risk       public.risk_level NOT NULL DEFAULT 'medium',
    time_to_fill_days  integer,
    rationale          text,
    designated_by      bigint REFERENCES public.admins(id) ON DELETE SET NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_role_criticality_score CHECK (criticality_score BETWEEN 1 AND 5)
);

-- ---- 2) Succession plans (one per key position = critical role) ------------
CREATE TABLE IF NOT EXISTS public.succession_plans (
    id                  bigserial PRIMARY KEY,
    position_role_id    bigint NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
    incumbent_employee_id bigint REFERENCES public.employees(id) ON DELETE SET NULL,
    owner_admin_id      bigint REFERENCES public.admins(id) ON DELETE SET NULL,
    status              public.continuity_plan_status NOT NULL DEFAULT 'draft',
    confidentiality     public.confidentiality_tier NOT NULL DEFAULT 'standard',
    review_due          date,
    notes               text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
-- At most one non-archived plan per role.
CREATE UNIQUE INDEX IF NOT EXISTS idx_succession_plan_open_role
    ON public.succession_plans (position_role_id) WHERE status <> 'archived';
CREATE INDEX IF NOT EXISTS idx_succession_plan_status ON public.succession_plans (status);

-- ---- 3) Successors (the bench) ---------------------------------------------
CREATE TABLE IF NOT EXISTS public.successors (
    id                   bigserial PRIMARY KEY,
    plan_id              bigint NOT NULL REFERENCES public.succession_plans(id) ON DELETE CASCADE,
    candidate_employee_id bigint NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
    readiness_band       public.readiness_band NOT NULL DEFAULT 'ready_3y',
    bench_rank           smallint,
    source               public.successor_source NOT NULL DEFAULT 'manual',
    confidence           numeric(4,3),
    gap_summary          jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_successor_plan_candidate UNIQUE (plan_id, candidate_employee_id)
);
CREATE INDEX IF NOT EXISTS idx_successors_plan ON public.successors (plan_id);
CREATE INDEX IF NOT EXISTS idx_successors_candidate ON public.successors (candidate_employee_id);

-- ---- 4) Emergency cover (interim "hit-by-a-bus" designation) ---------------
CREATE TABLE IF NOT EXISTS public.emergency_cover (
    id                bigserial PRIMARY KEY,
    plan_id           bigint NOT NULL REFERENCES public.succession_plans(id) ON DELETE CASCADE,
    cover_employee_id bigint NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
    note              text,
    designated_by     bigint REFERENCES public.admins(id) ON DELETE SET NULL,
    created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_emergency_cover_plan ON public.emergency_cover (plan_id);

-- ---- 5) Retention / risk-of-loss -------------------------------------------
CREATE TABLE IF NOT EXISTS public.retention_risk (
    employee_id     bigint PRIMARY KEY REFERENCES public.employees(id) ON DELETE CASCADE,
    flight_risk     public.risk_level NOT NULL DEFAULT 'low',
    impact_of_loss  public.risk_level NOT NULL DEFAULT 'low',
    risk_factors    jsonb NOT NULL DEFAULT '{}'::jsonb,
    computed_score  smallint,                       -- 0..100, system-computed
    manual_override boolean NOT NULL DEFAULT false,
    confidentiality public.confidentiality_tier NOT NULL DEFAULT 'restricted',
    owner_admin_id  bigint REFERENCES public.admins(id) ON DELETE SET NULL,
    last_reviewed   timestamptz,
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_retention_flight ON public.retention_risk (flight_risk);

-- ---- 6) Knowledge handover (ties to lifecycle leaver/mover) ----------------
CREATE TABLE IF NOT EXISTS public.handover_plans (
    id                   bigserial PRIMARY KEY,
    lifecycle_event_id   bigint REFERENCES public.lifecycle_events(id) ON DELETE SET NULL,
    outgoing_employee_id bigint NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
    incoming_employee_id bigint REFERENCES public.employees(id) ON DELETE SET NULL,
    status               public.handover_status NOT NULL DEFAULT 'open',
    due_date             date,
    owner_admin_id       bigint REFERENCES public.admins(id) ON DELETE SET NULL,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_handover_outgoing ON public.handover_plans (outgoing_employee_id);
CREATE INDEX IF NOT EXISTS idx_handover_status ON public.handover_plans (status);

CREATE TABLE IF NOT EXISTS public.handover_items (
    id           bigserial PRIMARY KEY,
    handover_id  bigint NOT NULL REFERENCES public.handover_plans(id) ON DELETE CASCADE,
    title        text NOT NULL,
    detail       text,
    kind         text NOT NULL DEFAULT 'knowledge',  -- 'knowledge' | 'task' | 'contact' | 'access'
    status       public.handover_status NOT NULL DEFAULT 'open',
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_handover_items_plan ON public.handover_items (handover_id);

-- ---- 7) Coverage analytics view --------------------------------------------
-- Per critical role: bench depth, ready-now count, gap flag, incumbent risk.
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
LEFT JOIN public.successors s ON s.plan_id = sp.id
LEFT JOIN public.retention_risk rr ON rr.employee_id = sp.incumbent_employee_id
GROUP BY rc.role_id, r.name, rc.criticality_score, rc.vacancy_risk,
         sp.id, sp.status, sp.incumbent_employee_id,
         rr.flight_risk, rr.impact_of_loss;
