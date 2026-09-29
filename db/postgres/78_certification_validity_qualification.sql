-- ===================================================================
-- 74 — Certification validity actually degrades the qualification signal.
--
-- Until now a lapsed statutory certificate (blasting licence, LOTO
-- authorisation, first-aid VOC, banksman ticket…) changed NOTHING outside
-- /compliance: readiness, benchmark fit and the succession bench all kept
-- calling the holder "ready". In a mining context that is exactly backwards —
-- an expired ticket means the person may NOT perform the task today.
--
-- What this migration does, and just as importantly what it does NOT do:
--
--   IT DOES     — for a skill on which an employee HAS certification history
--                 but holds no currently-valid certificate, the EFFECTIVE
--                 qualification level used by readiness / benchmark /
--                 succession drops to 0 until a new certificate is recorded.
--
--   IT DOES NOT — touch which skills are assessed, how many requirements a
--                 role has, or the recorded assessment itself. The
--                 department-designed requirement counts are untouched:
--                 v_employee_skill_gaps still emits exactly one row per
--                 (employee, required skill), `is_assessed` still reflects the
--                 assessment record, and `assessed_level` preserves the raw
--                 level. Only the "does this person currently qualify" verdict
--                 changes. This is about the VALIDITY of a held qualification,
--                 never about the scope of the assessment.
--
--   IT DOES NOT — degrade anyone who never held a certificate for the skill.
--                 No certificate history = no lapse = nothing changes. A
--                 certification POLICY existing on a skill is not, on its own,
--                 evidence that a given person was ever certified.
--
--   IT DOES NOT — change v_coverage_status. A coverage rule carries an
--                 EXPLICIT `require_valid_cert` flag: that is the rule
--                 author's stated intent and stays authoritative, so existing
--                 rules do not silently change their breach verdict.
--
-- Idempotent: CREATE OR REPLACE only (v_employee_skill_gaps keeps its column
-- list, order and types and only GAINS two trailing columns), so dependent
-- views (v_employee_readiness, v_department_matrix_completion) survive.
-- ===================================================================

BEGIN;

-- -------------------------------------------------------------------
-- v_certification_lapsed — (employee, skill) pairs where a certification
-- was held and is no longer valid: the latest record expired, or every
-- record for the pair has been revoked.
--
-- "Currently valid" mirrors v_coverage_status: valid | expiring | no_expiry.
-- 'expiring' is still valid TODAY — the revalidation ladder (cert-expiry job)
-- is what drives renewal before it stops counting.
--
-- Skills whose policy explicitly says is_certification = false are excluded:
-- those policies exist only to drive the skill-currency decay horizon, and a
-- stray record there must not degrade anybody.
-- -------------------------------------------------------------------
-- CREATE OR REPLACE (never DROP … CASCADE): once v_employee_skill_gaps depends
-- on this view, a CASCADE drop here would silently take v_employee_readiness
-- and v_department_matrix_completion with it on any re-run.
CREATE OR REPLACE VIEW v_certification_lapsed AS
SELECT
    h.employee_id,
    h.skill_id,
    h.last_expires_on,
    CASE WHEN h.has_unrevoked THEN 'expired' ELSE 'revoked' END AS lapse_reason
FROM (
    SELECT ec.employee_id,
           ec.skill_id,
           MAX(ec.expires_on) FILTER (WHERE NOT ec.is_revoked) AS last_expires_on,
           bool_or(NOT ec.is_revoked)                          AS has_unrevoked
      FROM employee_certifications ec
      LEFT JOIN skill_certification_policies p ON p.skill_id = ec.skill_id
     WHERE COALESCE(p.is_certification, true)
     GROUP BY ec.employee_id, ec.skill_id
) h
WHERE NOT EXISTS (
    SELECT 1
      FROM v_certification_current cc
     WHERE cc.employee_id = h.employee_id
       AND cc.skill_id    = h.skill_id
       AND cc.cert_status IN ('valid', 'expiring', 'no_expiry'));

COMMENT ON VIEW v_certification_lapsed IS
    'Employee+skill pairs whose held certification is no longer valid (expired or fully revoked). Feeds the effective-qualification degradation used by readiness, benchmark and succession.';

-- -------------------------------------------------------------------
-- v_employee_skill_gaps — same shape as 07_dashboard_views, with the
-- effective level substituted for the raw level and two new trailing
-- columns so every consumer can still see the raw signal and explain WHY
-- someone dropped:
--     assessed_level  the recorded (undegraded) level
--     cert_lapsed     true when a lapsed certificate forced the degrade
-- -------------------------------------------------------------------
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
    -- Effective level: a lapsed statutory certificate means "cannot perform".
    (CASE WHEN cl.employee_id IS NOT NULL THEN 0 ELSE COALESCE(ra.level, 0) END) AS actual_level,
    (rsr.required_level - CASE WHEN cl.employee_id IS NOT NULL THEN 0 ELSE COALESCE(ra.level, 0) END) AS gap,
    rsr.is_critical,
    -- Unchanged on purpose: the skill IS assessed, the ticket just lapsed.
    -- Assessment coverage / requirement counts must not move.
    CASE WHEN ra.level IS NOT NULL THEN 1 ELSE 0 END AS is_assessed,
    CASE WHEN (CASE WHEN cl.employee_id IS NOT NULL THEN 0 ELSE COALESCE(ra.level, 0) END) >= rsr.required_level
         THEN 1 ELSE 0 END AS is_met,
    COALESCE(ra.level, 0) AS assessed_level,
    (cl.employee_id IS NOT NULL) AS cert_lapsed
FROM v_employee_details e
JOIN role_skill_requirements rsr ON rsr.role_id = e.role_id
JOIN skills s                    ON s.id  = rsr.skill_id
JOIN domains dom                 ON dom.id = s.domain_id
LEFT JOIN v_resolved_assessments ra ON ra.employee_id = e.employee_id AND ra.skill_id = rsr.skill_id
LEFT JOIN v_certification_lapsed cl ON cl.employee_id = e.employee_id AND cl.skill_id = rsr.skill_id
WHERE rsr.required_level > 0;

-- -------------------------------------------------------------------
-- v_certification_lapse_impact — the compliance page's evidence that the
-- degradation is real: every lapse that actually breaks a role requirement,
-- with the level the person WOULD have counted at.
-- -------------------------------------------------------------------
CREATE OR REPLACE VIEW v_certification_lapse_impact AS
SELECT
    g.employee_id, ed.full_name,
    ed.site_id, ed.site_name, ed.department_id, ed.department_name,
    g.role_id, g.role_name,
    g.skill_id, g.skill_name,
    g.required_level, g.assessed_level,
    g.is_critical,
    cl.lapse_reason, cl.last_expires_on
FROM v_employee_skill_gaps g
JOIN v_certification_lapsed cl ON cl.employee_id = g.employee_id AND cl.skill_id = g.skill_id
JOIN v_employee_details ed     ON ed.employee_id = g.employee_id
WHERE g.cert_lapsed
  AND g.assessed_level >= g.required_level;   -- would have been MET but for the lapse

COMMENT ON VIEW v_certification_lapse_impact IS
    'Role requirements that are unmet ONLY because the held certification lapsed — the auditable link between /compliance and the readiness/benchmark/succession numbers.';

INSERT INTO schema_meta(key, value) VALUES ('78_certification_validity_qualification', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();

COMMIT;
