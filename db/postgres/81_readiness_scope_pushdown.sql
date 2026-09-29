-- 81_readiness_scope_pushdown.sql
-- Let a site / department / service / role scope predicate REACH the inside of
-- v_employee_readiness. Nothing about what the view REPORTS changes.
--
-- THE MEASURED PROBLEM
--   v_employee_readiness (migration 79) is
--       FROM v_employee_details e
--       JOIN v_employee_skill_gaps g ON g.employee_id = e.employee_id
--       GROUP BY e.employee_id, …, e.site_id, e.department_id, …
--   The dashboard filters it with `WHERE e.site_id IN (…)`. That predicate is on
--   a GROUPING column, so the planner happily pushes it below the GROUP BY and
--   onto `e` — and then stops. The only thing tying `g` to `e` is employee_id,
--   so PostgreSQL's equivalence classes carry a site predicate exactly nowhere:
--   the 173 691-row gaps view is built IN FULL for every scoped read.
--
--   Measured on a development database seeded to 4 000 employees / 173 691 requirement rows
--   (scripts/loadtest-readiness.js, everything rolled back):
--       v_employee_skill_gaps, ORG-WIDE                exec 2 523 ms  buffers 988 875
--       v_employee_readiness scoped to 2 164 employees exec 2 924 ms  buffers 989 069
--   Identical work for 54 % of the rows. The load test shows the same flatness
--   end to end: getReadinessByGroup cost the SAME at org scope, at a 2 164-person
--   site and at a 76-person site. A front-line manager paid the superadmin's bill.
--
-- THE FIX — one line of join qual, zero semantic change
--   v_employee_skill_gaps is itself built FROM v_employee_details. For a given
--   employee_id its site/department/service/role columns are, by construction,
--   the SAME columns v_employee_readiness reads off `e`. Stating that equality
--   explicitly in the join is therefore a TAUTOLOGY on the data — and it is the
--   one thing the planner needs: `e.site_id` and `g.site_id` land in one
--   equivalence class, so `WHERE site_id IN (…)` is implied onto `g` too and
--   reaches the base scan inside the gaps view.
--
--   NULLs cannot bite here. employees.site_id / department_id / service_id /
--   role_id are all NOT NULL with RESTRICT foreign keys, and sites.name /
--   departments.name / services.name / roles.name are NOT NULL, so neither side
--   of any added equality can ever be NULL and no row can be lost to
--   NULL <> NULL. (This is an INNER JOIN; a dropped row would be a silently
--   missing employee, which is exactly the failure mode being ruled out.)
--
-- WHAT DOES NOT CHANGE
--   * Same view, same 22 columns, same order, same types (CREATE OR REPLACE
--     refuses any drift, and v_department_matrix_completion and the rest of the
--     dependants keep working untouched).
--   * total_required stays the FULL department-designed requirement count. The
--     DO block below re-asserts that against role_skill_requirements — nothing
--     here samples, caps or subsets a role's skills.
--   * readiness stays NULL when there is nothing to score, and migration 79's
--     "an unrated requirement is unknown, not a deficit" arithmetic is copied
--     verbatim. readiness_assessed_only lives on v_employee_assessment_coverage
--     and is not touched by this file at all.
--
-- PROOF, not assertion: the pre-image of every per-employee number the view
-- publishes is snapshotted into a temp table BEFORE the replace and compared
-- row-for-row, column-for-column AFTER it. Any single differing value aborts the
-- migration (P0001 — not one of the runner's "object already exists" codes, so
-- it cannot be swallowed and stamped 'pre-existing').
--
-- NO MATERIALISATION, DELIBERATELY. The same reasoning migration 80 recorded
-- applies: readiness is the number a director stands a campaign down on, and the
-- writes that move it are exactly when a manager reloads to check their work
-- landed. A refresh tick would make the figure silently lag a validation. This
-- change costs nothing in freshness — every read is still live — so that
-- trade-off never has to be made. No job, no refresh schedule.
--
-- Idempotent: CREATE OR REPLACE VIEW + an ON CONFLICT schema_meta stamp.

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Snapshot the CURRENT answer for every employee, before touching anything.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE _m81_before ON COMMIT DROP AS
SELECT employee_id, site_id, department_id, service_id, role_id,
       total_required, skills_met, total_gap_points, total_critical, critical_met,
       points_gained, points_required, readiness, is_role_ready,
       assessed_required, never_assessed_required, unassessed_gap_points
  FROM v_employee_readiness;

-- ---------------------------------------------------------------------------
-- 1. The same view, with the scope columns stated in the join.
--    Body is verbatim migration 79 except for the four added join equalities.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_employee_readiness AS
SELECT
    e.employee_id,
    e.full_name,
    e.site_id, e.site_name,
    e.department_id, e.department_name,
    e.service_id, e.service_name,
    e.role_id, e.role_name,
    -- The department-designed requirement count, WHOLE (never a subset).
    COUNT(g.skill_id) AS total_required,
    SUM(g.is_met)::int AS skills_met,
    -- Gap arithmetic over ASSESSED requirements only: an unrated requirement is
    -- an unknown, not a deficit.
    SUM(CASE WHEN g.is_assessed = 1 AND g.gap > 0 THEN g.gap ELSE 0 END)::int AS total_gap_points,
    SUM(CASE WHEN g.is_critical THEN 1 ELSE 0 END)::int AS total_critical,
    SUM(CASE WHEN g.is_critical AND g.is_met = 1 THEN 1 ELSE 0 END)::int AS critical_met,
    SUM(LEAST(g.actual_level, g.required_level))::int AS points_gained,
    SUM(g.required_level)::int AS points_required,
    CASE WHEN SUM(g.required_level) > 0
        THEN ROUND(100.0 * SUM(LEAST(g.actual_level, g.required_level))::numeric / SUM(g.required_level)::numeric, 1)
        ELSE NULL END AS readiness,
    CASE WHEN (
            SUM(g.required_level) > 0
            AND (100.0 * SUM(LEAST(g.actual_level, g.required_level))::numeric / SUM(g.required_level)::numeric) >= 80
            AND SUM(CASE WHEN g.is_critical THEN 1 ELSE 0 END)
              = SUM(CASE WHEN g.is_critical AND g.is_met = 1 THEN 1 ELSE 0 END)
        )
        THEN 1 ELSE 0 END AS is_role_ready,
    SUM(g.is_assessed)::int AS assessed_required,
    SUM(CASE WHEN g.is_assessed = 0 THEN 1 ELSE 0 END)::int AS never_assessed_required,
    SUM(CASE WHEN g.is_assessed = 0 AND g.gap > 0 THEN g.gap ELSE 0 END)::int AS unassessed_gap_points
FROM v_employee_details e
JOIN v_employee_skill_gaps g
  ON  g.employee_id = e.employee_id
  -- Tautologies on the data (g is derived from the SAME v_employee_details row),
  -- and the ONLY thing that lets a site/department/service/role predicate on the
  -- grouping columns reach the gaps scan. All eight columns are NOT NULL.
  AND g.site_id       = e.site_id
  AND g.department_id = e.department_id
  AND g.service_id    = e.service_id
  AND g.role_id       = e.role_id
  AND g.site_name       = e.site_name
  AND g.department_name = e.department_name
  AND g.service_name    = e.service_name
  AND g.role_name       = e.role_name
GROUP BY e.employee_id, e.full_name, e.site_id, e.site_name, e.department_id, e.department_name,
         e.service_id, e.service_name, e.role_id, e.role_name;

COMMENT ON VIEW v_employee_readiness IS
    'Per-employee readiness. total_required is the FULL department-designed requirement count. '
    'total_gap_points counts ONLY assessed requirements (migration 79) — an unrated requirement is '
    'unknown, not a deficit; unassessed_gap_points shows what was excluded. readiness here still '
    'spans every requirement: use v_employee_assessment_coverage.readiness_assessed_only together '
    'with assessed/expected when partial coverage must not be read as weakness. '
    'The join repeats the org columns (migration 81) purely so a scope predicate can be pushed '
    'into v_employee_skill_gaps — they are equal by construction and change no output.';

-- ---------------------------------------------------------------------------
-- 2. Prove the rewrite changed NOTHING, per employee, per column.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    drift bigint;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'v_employee_readiness'
          AND column_name = 'unassessed_gap_points'
    ) THEN
        RAISE EXCEPTION
            'migration 81: v_employee_readiness lost unassessed_gap_points — the view replace did not take';
    END IF;

    -- 2a. Same population, same numbers. A FULL JOIN catches an employee who
    --     appeared, an employee who vanished, and any moved value alike.
    SELECT COUNT(*) INTO drift
      FROM _m81_before b
      FULL JOIN v_employee_readiness a ON a.employee_id = b.employee_id
     WHERE b.employee_id IS NULL
        OR a.employee_id IS NULL
        OR a.site_id                IS DISTINCT FROM b.site_id
        OR a.department_id          IS DISTINCT FROM b.department_id
        OR a.service_id             IS DISTINCT FROM b.service_id
        OR a.role_id                IS DISTINCT FROM b.role_id
        OR a.total_required         IS DISTINCT FROM b.total_required
        OR a.skills_met             IS DISTINCT FROM b.skills_met
        OR a.total_gap_points       IS DISTINCT FROM b.total_gap_points
        OR a.total_critical         IS DISTINCT FROM b.total_critical
        OR a.critical_met           IS DISTINCT FROM b.critical_met
        OR a.points_gained          IS DISTINCT FROM b.points_gained
        OR a.points_required        IS DISTINCT FROM b.points_required
        OR a.readiness              IS DISTINCT FROM b.readiness
        OR a.is_role_ready          IS DISTINCT FROM b.is_role_ready
        OR a.assessed_required      IS DISTINCT FROM b.assessed_required
        OR a.never_assessed_required IS DISTINCT FROM b.never_assessed_required
        OR a.unassessed_gap_points  IS DISTINCT FROM b.unassessed_gap_points;
    IF drift > 0 THEN
        RAISE EXCEPTION
            'migration 81: % employees whose readiness row changed — the join rewrite is NOT output-identical', drift;
    END IF;

    -- 2b. The HARD CONSTRAINT, re-checked independently of 2a: the requirement
    --     count per employee is still the FULL department-designed catalogue.
    SELECT COUNT(*) INTO drift
      FROM (
        SELECT e.employee_id,
               (SELECT COUNT(*) FROM role_skill_requirements r
                 WHERE r.role_id = e.role_id AND r.required_level > 0) AS designed,
               (SELECT v.total_required FROM v_employee_readiness v
                 WHERE v.employee_id = e.employee_id)                  AS exposed
          FROM v_employee_details e
      ) t
     WHERE t.exposed IS NOT NULL AND t.designed <> t.exposed;
    IF drift > 0 THEN
        RAISE EXCEPTION
            'migration 81: % employees whose total_required no longer equals the department-designed skill count', drift;
    END IF;
END $$;

INSERT INTO schema_meta(key, value) VALUES ('81_readiness_scope_pushdown', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();

COMMIT;
