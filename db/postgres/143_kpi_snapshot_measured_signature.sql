-- 143 — a measured-population fingerprint on each KPI snapshot (re-audit J8)
--
-- The KPI cards show a month-on-month delta and caveat it only when the measured
-- HEAD COUNT moved. But an average can move because WHO is averaged changed, not
-- anyone's capability: five below-average leavers replaced by five joiners leaves
-- measured_employees unchanged, so the delta read as pure improvement with no
-- note at all. There is no way to tell that apart from head counts. This stores a
-- fingerprint of the measured employee-id SET, so a later snapshot can tell "same
-- cohort, real movement" from "different cohort" even when the count is identical.
-- Nullable: older rows and unmeasured scopes simply carry no fingerprint.

ALTER TABLE kpi_snapshots ADD COLUMN IF NOT EXISTS measured_signature text;
