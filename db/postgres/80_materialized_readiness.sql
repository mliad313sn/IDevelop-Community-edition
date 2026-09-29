-- 80_materialized_readiness.sql
-- Make the readiness view stack SCOPE-AWARE, without materialising anything.
--
-- THE MEASURED PROBLEM
--   v_resolved_assessments (migration 71) resolves "latest level per
--   (employee, skill)" with
--       ROW_NUMBER OVER (PARTITION BY employee_id, skill_id ORDER BY assessed_at DESC)
--   over a UNION ALL of skill_assessments + approved self_assessments. A window
--   function is an optimisation barrier for join pushdown: the dashboard's scope
--   predicate lives on v_employee_details (site_id / department_id /
--   employee_id), and the planner has no way to carry it through the WindowAgg.
--
--   Measured on a development database (77 employees, 2 844 assessment rows) — a query scoped to
--   ONE site with 8 employees / 326 requirement rows:
--       ->  Subquery Scan on latest (rows=2712)
--             ->  WindowAgg (rows=2712)
--                   ->  Merge Append (rows=2844)
--   i.e. 100 % of the org's assessment history was sorted and window-ranked to
--   answer a question about 2.6 % of the workforce. The executive dashboard
--   fires ~10 such aggregates per load, so the cost is paid ~10x per page, and
--   it grows with the ORG, not with the scope.
--
-- WHY NOT A MATERIALIZED VIEW (the file name is the one the work was filed
-- under; the decision is deliberate and is recorded here rather than hidden)
--   A MATVIEW would have to be refreshed by a job. Readiness is the number a
--   director stands down a campaign on, and the writes that move it —
--   a supervisor validating a level, a self-assessment being approved — are
--   exactly the moments a manager reloads the page to check their work landed.
--   With a refresh tick the best bound is "stale by up to one tick"; with
--   REFRESH ... CONCURRENTLY on a 4 000-employee estate that tick cannot be very
--   short. A readiness figure that silently lags a validation is the same class
--   of defect as the fabricated gap points migration 79 removed: a number that
--   looks earned and is not. The restructure below costs nothing in freshness —
--   every read is still live — so the staleness trade-off never has to be made.
--   Consequently this migration adds NO job and needs no refresh schedule.
--
-- WHAT CHANGES
--   v_requirement_provenance and v_employee_skill_gaps stop joining the
--   window-function view and resolve the same latest-per-(employee,skill) row
--   with a LEFT JOIN LATERAL straight onto the base tables. Both branches are
--   driven by indexes that already exist:
--       skill_assessments  UNIQUE (employee_id, skill_id)
--                          idx_skill_assessments_emp_skill_time
--       self_assessments   idx_self_assessments_emp_skill_created
--                          (employee_id, skill_id, created_at DESC) WHERE status = 'approved'
--   so the scope predicate on v_employee_details now reaches the base scan: the
--   work becomes proportional to the requirements IN SCOPE.
--
-- WHAT DOES NOT CHANGE — the output contract is byte-identical
--   * Same views, same column names, same order, same types (CREATE OR REPLACE
--     enforces that; it refuses any drift).
--   * Same resolution rule: latest assessed_at wins; a supervisor row is
--     'supervisor_validated'/'assessed', an APPROVED self-rating is
--     'self_approved'/'self_only', no row at all stays NULL / 'never_assessed'
--     and is never coalesced to 0.
--   * v_resolved_assessments is UNTOUCHED. Its four other dependents
--     (v_coverage_status, v_domain_capability, v_subdomain_capability,
--     v_skill_currency) keep the exact view they had, and it stays the
--     reference implementation the DO block below checks the new laterals
--     against — on every pair whose latest timestamp is unique (see the
--     tie-break note below).
--   * Wave 2's canonical readiness (v_employee_assessment_coverage
--     .readiness_assessed_only) is derived from v_requirement_provenance and is
--     not redefined here — it cannot move unless the resolution moves, and the
--     drift check forbids that.
--   * HARD CONSTRAINT: expected_skills / total_required stay the FULL
--     department-designed requirement count. Nothing here samples or filters
--     requirements away — `required_level > 0` is the same predicate the views
--     already had.
--
-- ONE deliberate improvement: the original ROW_NUMBER had NO tie-break beyond
-- assessed_at, so a supervisor validation and an approved self-rating carrying
-- the IDENTICAL timestamp resolved arbitrarily — plan-dependent, and free to
-- change between two runs of the same query. The laterals order by
-- `assessed_at DESC, branch`: supervisor wins an exact tie. That turns
-- undefined behaviour into defined behaviour, in the direction where a
-- validated level beats an auto-approved self-rating.
--
-- The drift checks below therefore compare only the (employee, skill) pairs
-- whose resolution is WELL-DEFINED — a strict maximum timestamp. Pairs where
-- two or more candidate rows tie on the maximum are counted and reported as a
-- NOTICE instead: on those the old view had no answer to preserve, so failing
-- the migration over them would be failing over noise. (The 4 000-employee load
-- test's synthetic timestamps produced 48 such pairs out of 173 691 requirement
-- rows; the real a development database dataset has 0. The load test is what surfaced this: a
-- strict check would have aborted the migration on a customer database that
-- happens to carry ties.)
--
-- Idempotent: CREATE OR REPLACE VIEW only + an ON CONFLICT schema_meta stamp.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. v_requirement_provenance — same 20 columns, scope-reachable resolution
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_requirement_provenance AS
SELECT
    e.employee_id,
    e.site_id, e.site_name,
    e.department_id, e.department_name,
    e.service_id, e.service_name,
    e.role_id, e.role_name,
    s.id AS skill_id, s.name AS skill_name,
    dom.id AS domain_id, dom.name AS domain_name,
    rsr.required_level,
    rsr.is_critical,
    -- NOT coalesced: NULL means "nobody has ever rated this", which is a very
    -- different fact from a rated level of 0.
    ra.level AS assessed_level,
    ra.source,
    ra.assessed_at,
    COALESCE(ra.assessment_status, 'never_assessed') AS assessment_status,
    CASE WHEN ra.level IS NOT NULL THEN 1 ELSE 0 END AS is_assessed
FROM v_employee_details e
JOIN role_skill_requirements rsr ON rsr.role_id = e.role_id
JOIN skills s                    ON s.id  = rsr.skill_id
JOIN domains dom                 ON dom.id = s.domain_id
-- Same rows v_resolved_assessments would have produced for this (employee,
-- skill) — but as a correlated lookup the scope predicate on `e` can drive.
LEFT JOIN LATERAL (
    SELECT c.level, c.source, c.assessed_at, c.assessment_status
    FROM (
        (SELECT sa.current_level AS level,
                'supervisor_validated'::text AS source,
                sa.assessed_at,
                'assessed'::text AS assessment_status,
                1 AS branch
           FROM skill_assessments sa
          WHERE sa.employee_id = e.employee_id AND sa.skill_id = rsr.skill_id
          ORDER BY sa.assessed_at DESC
          LIMIT 1)
        UNION ALL
        (SELECT sf.self_rated_level,
                'self_approved'::text,
                sf.created_at,
                'self_only'::text,
                2
           FROM self_assessments sf
          WHERE sf.employee_id = e.employee_id AND sf.skill_id = rsr.skill_id
            AND sf.status = 'approved'
          ORDER BY sf.created_at DESC
          LIMIT 1)
    ) c
    ORDER BY c.assessed_at DESC, c.branch
    LIMIT 1
) ra ON TRUE
WHERE rsr.required_level > 0;

COMMENT ON VIEW v_requirement_provenance IS
    'One row per (employee, required skill). assessment_status = never_assessed | self_only | assessed. '
    'assessed_level is NULL for never_assessed on purpose. Resolution is identical to '
    'v_resolved_assessments (migration 80 asserts equality on every pair with a defined answer) '
    'but is expressed as a '
    'LATERAL so a site/department/employee scope predicate reaches the base scan.';

-- ---------------------------------------------------------------------------
-- 2. v_employee_skill_gaps — same 21 columns, same resolution, same lateral
--    (this is the view v_employee_readiness and the whole gap stack sit on)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_employee_skill_gaps AS
SELECT
    e.employee_id,
    e.site_id, e.site_name,
    e.department_id, e.department_name,
    e.service_id, e.service_name,
    e.role_id, e.role_name,
    s.id AS skill_id, s.name AS skill_name,
    dom.id AS domain_id, dom.name AS domain_name,
    rsr.required_level,
    -- A lapsed certification zeroes the effective level: unchanged behaviour.
    CASE WHEN cl.employee_id IS NOT NULL THEN 0
         ELSE COALESCE(ra.level::integer, 0) END AS actual_level,
    rsr.required_level - CASE WHEN cl.employee_id IS NOT NULL THEN 0
                              ELSE COALESCE(ra.level::integer, 0) END AS gap,
    rsr.is_critical,
    CASE WHEN ra.level IS NOT NULL THEN 1 ELSE 0 END AS is_assessed,
    CASE WHEN CASE WHEN cl.employee_id IS NOT NULL THEN 0
                   ELSE COALESCE(ra.level::integer, 0) END >= rsr.required_level
         THEN 1 ELSE 0 END AS is_met,
    COALESCE(ra.level::integer, 0) AS assessed_level,
    cl.employee_id IS NOT NULL AS cert_lapsed
FROM v_employee_details e
JOIN role_skill_requirements rsr ON rsr.role_id = e.role_id
JOIN skills s                    ON s.id  = rsr.skill_id
JOIN domains dom                 ON dom.id = s.domain_id
LEFT JOIN LATERAL (
    SELECT c.level
    FROM (
        (SELECT sa.current_level AS level, sa.assessed_at, 1 AS branch
           FROM skill_assessments sa
          WHERE sa.employee_id = e.employee_id AND sa.skill_id = rsr.skill_id
          ORDER BY sa.assessed_at DESC
          LIMIT 1)
        UNION ALL
        (SELECT sf.self_rated_level, sf.created_at, 2
           FROM self_assessments sf
          WHERE sf.employee_id = e.employee_id AND sf.skill_id = rsr.skill_id
            AND sf.status = 'approved'
          ORDER BY sf.created_at DESC
          LIMIT 1)
    ) c
    ORDER BY c.assessed_at DESC, c.branch
    LIMIT 1
) ra ON TRUE
LEFT JOIN v_certification_lapsed cl
       ON cl.employee_id = e.employee_id AND cl.skill_id = rsr.skill_id
WHERE rsr.required_level > 0;

COMMENT ON VIEW v_employee_skill_gaps IS
    'One row per (employee, required skill) with the effective level and gap. actual_level still '
    'COALESCEs a missing assessment to 0 for backwards compatibility — read is_assessed (or '
    'v_requirement_provenance.assessment_status) before treating a 0 as measured. Resolution is '
    'identical to v_resolved_assessments; migration 80 asserts that on every pair whose latest '
    'timestamp is unique.';

-- ---------------------------------------------------------------------------
-- 3. Prove the restructure changed NOTHING.
--
--    v_resolved_assessments is left in place precisely so it can serve as the
--    reference implementation. These checks compare every (employee, required
--    skill) row of both rewritten views against it — level, source, status and
--    the is_assessed predicate migration 79 depends on — EXCEPT the pairs whose
--    latest timestamp is not unique, where the pre-80 view had no defined answer
--    to preserve (those are counted and RAISE NOTICEd instead). P0001 is not one
--    of the migration runner's "object already exists" codes, so a failure here
--    cannot be swallowed and silently stamped 'pre-existing'.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE _m80_ambiguous ON COMMIT DROP AS
WITH cand AS (
    SELECT employee_id, skill_id, assessed_at AS ts FROM skill_assessments
    UNION ALL
    SELECT employee_id, skill_id, created_at    FROM self_assessments WHERE status = 'approved'
)
SELECT employee_id, skill_id
  FROM (SELECT employee_id, skill_id,
               RANK() OVER (PARTITION BY employee_id, skill_id ORDER BY ts DESC) AS rk
          FROM cand) x
 WHERE rk = 1
 GROUP BY employee_id, skill_id
HAVING COUNT(*) > 1;

DO $$
DECLARE
    drift bigint;
    ambiguous bigint;
BEGIN
    SELECT COUNT(*) INTO ambiguous FROM _m80_ambiguous;
    IF ambiguous > 0 THEN
        RAISE NOTICE
            'migration 80: % (employee, skill) pairs tie exactly on the latest timestamp. The pre-80 view resolved those ARBITRARILY; they now resolve to the supervisor-validated row. Excluded from the drift checks because there was no defined answer to preserve.', ambiguous;
    END IF;

    -- 3a. provenance vs the reference view
    SELECT COUNT(*) INTO drift
      FROM v_requirement_provenance p
      LEFT JOIN v_resolved_assessments ra
             ON ra.employee_id = p.employee_id AND ra.skill_id = p.skill_id
     WHERE NOT EXISTS (SELECT 1 FROM _m80_ambiguous a
                        WHERE a.employee_id = p.employee_id AND a.skill_id = p.skill_id)
       AND (p.assessed_level IS DISTINCT FROM ra.level
        OR  p.source         IS DISTINCT FROM ra.source
        OR  p.assessment_status IS DISTINCT FROM COALESCE(ra.assessment_status, 'never_assessed'));
    IF drift > 0 THEN
        RAISE EXCEPTION
            'migration 80: % rows where v_requirement_provenance disagrees with v_resolved_assessments — the LATERAL is not the same resolution', drift;
    END IF;

    -- 3b. gaps vs the reference view (actual_level carries the cert-lapse
    --     override, so compare the raw resolution through assessed_level)
    SELECT COUNT(*) INTO drift
      FROM v_employee_skill_gaps g
      LEFT JOIN v_resolved_assessments ra
             ON ra.employee_id = g.employee_id AND ra.skill_id = g.skill_id
     WHERE NOT EXISTS (SELECT 1 FROM _m80_ambiguous a
                        WHERE a.employee_id = g.employee_id AND a.skill_id = g.skill_id)
       AND (g.assessed_level IS DISTINCT FROM COALESCE(ra.level::integer, 0)
        OR  g.is_assessed    IS DISTINCT FROM (CASE WHEN ra.level IS NOT NULL THEN 1 ELSE 0 END));
    IF drift > 0 THEN
        RAISE EXCEPTION
            'migration 80: % rows where v_employee_skill_gaps disagrees with v_resolved_assessments', drift;
    END IF;

    -- 3c. the invariant migration 79 relies on: the gap predicate IS the
    --     provenance predicate, over the identical requirement set.
    SELECT COUNT(*) INTO drift
      FROM v_employee_skill_gaps g
      FULL JOIN v_requirement_provenance p
        ON p.employee_id = g.employee_id AND p.skill_id = g.skill_id
     WHERE g.employee_id IS NULL
        OR p.employee_id IS NULL
        OR g.is_assessed <> p.is_assessed;
    IF drift > 0 THEN
        RAISE EXCEPTION
            'migration 80: % requirement rows where v_employee_skill_gaps.is_assessed disagrees with v_requirement_provenance', drift;
    END IF;

    -- 3d. the HARD CONSTRAINT: the requirement count per employee is still the
    --     FULL department-designed catalogue, not a subset.
    SELECT COUNT(*) INTO drift
      FROM (
        SELECT e.employee_id,
               (SELECT COUNT(*) FROM role_skill_requirements r
                 WHERE r.role_id = e.role_id AND r.required_level > 0) AS designed,
               (SELECT COUNT(*) FROM v_requirement_provenance p
                 WHERE p.employee_id = e.employee_id) AS exposed
          FROM v_employee_details e
      ) t
     WHERE t.designed <> t.exposed;
    IF drift > 0 THEN
        RAISE EXCEPTION
            'migration 80: % employees whose exposed requirement count no longer equals the department-designed count', drift;
    END IF;
END $$;

INSERT INTO schema_meta(key, value) VALUES ('80_materialized_readiness', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();

COMMIT;
