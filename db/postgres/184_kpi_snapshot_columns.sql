-- 184 — KPI module: kpi_snapshots columns for the indicator contracts K1, K4,
-- K8 and K9 (src/services/KpiService.js).
--
--   not_ready_count      K1 "Not ready": fully assessed and below the
--                        threshold, OR an assessed critical requirement not met.
--                        role_ready_count stays the "Ready" count.
--   partial_count        K1 "Partially assessed".
--   unassessed_count     K1 "Not assessed" (nothing assessed at all).
--   critical_unassessed  K4 "Not demonstrated": critical requirements never
--                        assessed. critical_compliance is critical met ÷
--                        critical ASSESSED (unchanged in IDevelop).
--   certs_expired        K8 people with at least one REQUIRED certificate expired.
--                        From this contract certs_expiring_90d is K8 PEOPLE with
--                        a required certificate expiring within 90 days.
--   safety_fit_pct       K9 safety-gate fitness (%).
--   kpi_contract         the KPI contract version a row was computed under
--                        (KpiService.CONTRACT_VERSION). NULL = a row written
--                        before the KPI module. A month-on-month movement is
--                        only computed between rows of the same contract for
--                        the metrics whose definition changed (role_ready_count,
--                        sole_holder_count, certs_expiring_90d): comparing across
--                        that change would show a movement that never happened.
--
-- Every column is NULLABLE and NULL is never coalesced (migration 82 rule):
-- NULL = not measured or not configured, never 0.
--
-- Additive and idempotent (ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT
-- EXISTS). Nothing is rewritten or deleted: existing rows keep their values
-- and get kpi_contract NULL.

ALTER TABLE public.kpi_snapshots ADD COLUMN IF NOT EXISTS not_ready_count     integer;
ALTER TABLE public.kpi_snapshots ADD COLUMN IF NOT EXISTS partial_count       integer;
ALTER TABLE public.kpi_snapshots ADD COLUMN IF NOT EXISTS unassessed_count    integer;
ALTER TABLE public.kpi_snapshots ADD COLUMN IF NOT EXISTS critical_unassessed integer;
ALTER TABLE public.kpi_snapshots ADD COLUMN IF NOT EXISTS certs_expired       integer;
ALTER TABLE public.kpi_snapshots ADD COLUMN IF NOT EXISTS safety_fit_pct      numeric(5,1);
ALTER TABLE public.kpi_snapshots ADD COLUMN IF NOT EXISTS kpi_contract        text;

COMMENT ON COLUMN public.kpi_snapshots.role_ready_count IS
    'K1 "Ready" count. Under a kpi_contract: every requirement assessed AND readiness at or above the threshold AND every critical requirement met. NULL when nobody in scope is measured.';
COMMENT ON COLUMN public.kpi_snapshots.not_ready_count IS
    'K1 "Not ready": fully assessed and below, or an assessed critical requirement not met. NULL when nobody in scope is measured.';
COMMENT ON COLUMN public.kpi_snapshots.partial_count IS
    'K1 "Partially assessed" count. NULL when nobody in scope is measured.';
COMMENT ON COLUMN public.kpi_snapshots.unassessed_count IS
    'K1 "Not assessed" count (people with requirements and no assessed requirement). A fact about the scope, never folded into "Not ready".';
COMMENT ON COLUMN public.kpi_snapshots.critical_unassessed IS
    'K4 "Not demonstrated": critical requirements (person x requirement) never assessed.';
COMMENT ON COLUMN public.kpi_snapshots.certs_expired IS
    'K8 people with at least one REQUIRED certificate expired. NULL when no certification is required in scope ("No certification configured").';
COMMENT ON COLUMN public.kpi_snapshots.safety_fit_pct IS
    'K9 % of the people on a safety-gated role who meet every blocking requirement (evidenced population). NULL when no gated role or nothing evidenced.';
COMMENT ON COLUMN public.kpi_snapshots.kpi_contract IS
    'KPI contract version the row was computed under (KpiService.CONTRACT_VERSION). NULL = a row written before the KPI module.';

CREATE INDEX IF NOT EXISTS idx_kpi_snapshot_contract
    ON public.kpi_snapshots (scope_type, scope_id, kpi_contract, snapshot_date DESC);

SELECT public.fn_console_reader_sync();
