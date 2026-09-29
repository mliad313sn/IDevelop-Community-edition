-- 106_kpi_snapshots_roles_unmeasured.sql
-- The KPI strip's "roles not yet measured" figure joins the stored history.
--
-- PROBLEM
--   DashboardModel.getOverviewKPIs reports rolesAtRisk AND rolesUnmeasured as a
--   pair on purpose: "at risk" is a MEASURED finding, "unmeasured" is the part of
--   the organisation nobody has looked at yet, and the strip shows both so a
--   low at-risk count cannot pass for a clean bill of health when most roles
--   were never assessed. kpi_snapshots (migration 82) persisted only
--   roles_at_risk — the history therefore kept the finding and dropped the
--   coverage that makes it readable. A trend of "3 roles at risk → 1" over a
--   period where unmeasured roles went 10 → 40 would read as improvement.
--
-- WHAT THIS ADDS
--   roles_unmeasured, nullable, NULL when unknown — same honesty contract as
--   every other column of the table (never coalesced to 0 on write or read).
--   Written by src/jobs/kpi-snapshot.js from the same getOverviewKPIs call that
--   produces roles_at_risk, so the two can never disagree about the same day.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + schema_meta stamp.

BEGIN;

ALTER TABLE public.kpi_snapshots ADD COLUMN IF NOT EXISTS roles_unmeasured integer;

COMMENT ON COLUMN public.kpi_snapshots.roles_unmeasured IS
    'Roles with no measured incumbent in scope on that day — the coverage companion of roles_at_risk. NULL when unknown, never 0.';

INSERT INTO schema_meta(key, value) VALUES ('106_kpi_snapshots_roles_unmeasured', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();

COMMIT;
