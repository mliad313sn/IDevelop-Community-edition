-- 91_fit_history_unmeasured_is_null.sql
-- FMEA A1 — benchmark_fit_history stored fit = 0 / critical_fit = 0 for roles
-- whose occupants had never been assessed at all (coverage = 0). That is an
-- ABSENCE OF MEASUREMENT persisted as a RESULT, inside a trend history, so the
-- fabricated zero is permanent and the role reads as "0 % fit" forever.
--
-- src/jobs/fit-history.js now writes NULL for fit/critical_fit whenever coverage
-- is 0. This repairs the rows already written under the old behaviour.
--
-- Coverage is DELIBERATELY left at 0: it is a real measurement (0 % of the
-- required skills assessed) and it is how the unmeasured state is reported
-- explicitly. Only the derived fit figures are cleared.
--
-- Scope is exact: coverage = 0 means literally nothing was assessed, so any
-- fit/critical_fit on such a row can only have come from the LEAST(actual=0, …)
-- arithmetic. Rows with coverage > 0 or coverage IS NULL are untouched.
-- Additive, idempotent, re-runnable.

UPDATE benchmark_fit_history
   SET fit          = NULL,
       critical_fit = NULL
 WHERE coverage IS NOT NULL
   AND coverage = 0
   AND (fit IS NOT NULL OR critical_fit IS NOT NULL);

INSERT INTO schema_meta(key, value) VALUES ('91_fit_history_unmeasured_is_null', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();
