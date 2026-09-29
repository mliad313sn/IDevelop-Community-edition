-- 82_kpi_snapshots.sql
-- The first stored history of the HEADLINE figures.
--
-- FILE NUMBER: the brief said "migration 81", but 81_readiness_scope_pushdown.sql
-- already exists (76/77 never did). Migrations apply in numeric order and are
-- keyed by file name in schema_meta, so re-using 81 would either collide with an
-- applied key or run before the migration it builds on. Next free number is 82.
--
-- PROBLEM
--   benchmark_fit_history (migration 44) is the ONLY stored KPI history in the
--   schema, and it holds per-ROLE benchmark fit — not the executive KPI strip.
--   Everything on the dashboard is point-in-time, so no card can say
--   "82 % (+3 since last month)". The one place that tried — the executive
--   trend chart — BACK-CAST the series by subtracting raw skill-level deltas
--   (0-4) from a sum of readiness PERCENTAGES, a unit mismatch that made every
--   historical point arithmetically meaningless.
--
-- WHAT THIS ADDS
--   kpi_snapshots — one row per (snapshot_date, scope_type, scope_id) holding
--   the KPI-strip metrics. Written by src/jobs/kpi-snapshot.js, modelled exactly
--   on the proven jobs/fit-history.js pattern (idempotent per day via a unique
--   key + ON CONFLICT DO NOTHING, so an hourly tick only writes once a day).
--
-- HONESTY CONTRACT (this is the whole point of the table)
--   * Every metric column is NULLABLE and stays NULL when unmeasured. NULL is
--     never coalesced to 0 on write or on read — a delta against a NULL prior is
--     ABSENT, not "0". A fabricated trend is worse than no trend.
--   * avg_readiness is the coverage-aware readiness_assessed_only, the same
--     canonical figure the KPI strip prints — NOT readiness over all
--     requirements. Both are recorded so the pair can never silently swap.
--   * expected_requirements is the FULL department-designed requirement count.
--     Nothing here samples, tiers or subsets a role's skills.
--
--   scope_type is 'org' | 'site'. scope_id is 0 for 'org' (a real value, so the
--   unique key needs no COALESCE) and the site id for 'site'.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + guarded index + schema_meta stamp.

BEGIN;

CREATE TABLE IF NOT EXISTS public.kpi_snapshots (
    id                        bigserial PRIMARY KEY,
    snapshot_date             date        NOT NULL,
    scope_type                text        NOT NULL,
    scope_id                  bigint      NOT NULL DEFAULT 0,
    scope_label               text,
    -- Population
    total_employees           integer,
    measured_employees        integer,
    -- Canonical, coverage-aware readiness (NULL when nobody is measured)
    avg_readiness             numeric(5,1),
    -- The all-requirements parallel, recorded so the two can never be confused
    avg_readiness_all         numeric(5,1),
    assessment_coverage       numeric(5,1),
    assessed_requirements     integer,
    expected_requirements     integer,
    critical_compliance       numeric(5,1),
    role_ready_count          integer,
    roles_at_risk             integer,
    -- Continuity / certification exposure
    sole_holder_count         integer,
    no_qualified_count        integer,
    certs_expiring_90d        integer,
    created_at                timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_kpi_snapshot_scope CHECK (scope_type IN ('org','site'))
);

-- One snapshot per day per scope — the idempotency key the job relies on.
CREATE UNIQUE INDEX IF NOT EXISTS uq_kpi_snapshot_day_scope
    ON public.kpi_snapshots (snapshot_date, scope_type, scope_id);

CREATE INDEX IF NOT EXISTS idx_kpi_snapshot_scope_date
    ON public.kpi_snapshots (scope_type, scope_id, snapshot_date DESC);

COMMENT ON TABLE public.kpi_snapshots IS
    'Daily rollup of the executive KPI strip per scope (org / site). Metric columns are NULL when unmeasured and are NEVER coalesced to 0 — a delta with no prior snapshot must be absent, not zero.';
COMMENT ON COLUMN public.kpi_snapshots.avg_readiness IS
    'Coverage-aware readiness_assessed_only (v_employee_assessment_coverage). NULL when nobody in scope has an assessed requirement.';
COMMENT ON COLUMN public.kpi_snapshots.expected_requirements IS
    'FULL department-designed requirement count in scope. Never a subset.';

INSERT INTO schema_meta(key, value) VALUES ('82_kpi_snapshots', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();

COMMIT;
