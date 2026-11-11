-- 189 — kpi_snapshots columns for K5 and K6, so the succession figures and the
-- « What changed » sentences can show a movement under the same contract.
--
--   bench_strength_pct            K5 bench strength (%): critical roles with at
--                                 least one ready successor ÷ critical roles.
--                                 NULL when no critical role is designated in
--                                 the scope.
--   bench_critical_roles          K5 denominator and K6 n: the critical roles
--                                 of the scope (fewer than 5: no % sentence).
--                                 NULL when unknown.
--   critical_roles_without_ready  K6 count. NULL when no critical role is
--                                 designated: never a reassuring 0.
--
-- Every column is NULLABLE and NULL is never coalesced (migration 82 rule).
-- Rows written before this migration keep NULL: no movement is ever computed
-- against them.
--
-- Additive and idempotent: safe to re-run. Nothing is rewritten or deleted.

ALTER TABLE public.kpi_snapshots ADD COLUMN IF NOT EXISTS bench_strength_pct           numeric(5,1);
ALTER TABLE public.kpi_snapshots ADD COLUMN IF NOT EXISTS bench_critical_roles         integer;
ALTER TABLE public.kpi_snapshots ADD COLUMN IF NOT EXISTS critical_roles_without_ready integer;

COMMENT ON COLUMN public.kpi_snapshots.bench_strength_pct IS
    'K5: % of critical roles with at least one ready successor (migration 189). NULL when no critical role is designated in the scope.';
COMMENT ON COLUMN public.kpi_snapshots.bench_critical_roles IS
    'K5 denominator and K6 n: critical roles in the scope (migration 189). NULL when unknown.';
COMMENT ON COLUMN public.kpi_snapshots.critical_roles_without_ready IS
    'K6: critical roles without a ready successor (migration 189). NULL when no critical role is designated (never a reassuring 0).';

SELECT public.fn_console_reader_sync();
