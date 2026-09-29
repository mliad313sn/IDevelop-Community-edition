-- 44_benchmark_fit_history.sql — historical trending for benchmark fit.
-- One row per (day, role): org-truth snapshot of how occupants fit the role's
-- benchmark. Captured daily by src/jobs/fit-history.js; surfaced as a trend on
-- the benchmark role drill-through. Additive & idempotent.

CREATE TABLE IF NOT EXISTS benchmark_fit_history (
    id            serial PRIMARY KEY,
    snapshot_date date    NOT NULL DEFAULT CURRENT_DATE,
    role_id       integer NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    occupants     integer NOT NULL DEFAULT 0,
    fit           numeric,          -- benchmark fit % (NULL = no data)
    coverage      numeric,          -- % of required skills assessed
    critical_fit  numeric,
    UNIQUE (snapshot_date, role_id)
);

CREATE INDEX IF NOT EXISTS idx_bfh_role_date ON benchmark_fit_history(role_id, snapshot_date);

INSERT INTO schema_meta(key, value) VALUES ('44_benchmark_fit_history', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();
