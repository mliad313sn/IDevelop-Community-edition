-- =====================================================================
-- 56_voc_compliance_nudges.sql — Operational Compliance Assurance
--
-- Three additive feature surfaces (idempotent, no data loss):
--
--  1) Certification & Verification-of-Competency (VOC) engine
--       skill_certification_policies — per-skill policy: is this skill a
--         formal certification, how long is it valid, how far ahead is the
--         revalidation window, and after how many months without
--         reassessment does the skill level lapse ("currency decay").
--       employee_certifications — issued records per (employee, skill):
--         issue/expiry dates, VOC sign-off, one evidence file (AV-scanned,
--         same clamav flow as assessment evidence), and an alert_stage
--         watermark so the expiry job sends each 90/60/30/expired alert
--         exactly once per record.
--       v_certification_current — latest non-revoked record per
--         (employee, skill) with computed cert_status; derives from
--         v_employee_details so deactivated employees drop out and
--         callers can scope by employee_id BEFORE aggregating.
--       v_skill_currency — skill-currency decay: for skills whose policy
--         sets decay_months, the latest resolved assessment with
--         days_since_assessed and is_lapsed. A lapsed level is REPORTED as
--         unverified (dashboards/alerts), not destructively rewritten —
--         the assessment history stays intact and recovery is a
--         reassessment, not a data restore.
--
--  2) Position-coverage compliance ("safe-shift" rules)
--       coverage_rules — "org unit X must always have >= N people at
--         level >= L in skill S (optionally with a valid certification)".
--         site/department/service are each optional (NULL = any), so a
--         rule can target a site, a department, a service, or the whole
--         company. last_* columns carry the most recent evaluation so
--         breach TRANSITIONS (ok -> breached) can be detected and alerted
--         exactly once.
--       v_coverage_status — live evaluation of every active rule against
--         active headcount + resolved levels + current certifications.
--
--  3) Assessment campaign nudges
--       nudge_log — exactly-once ledger for cycle deadline reminders
--         (employee) and escalations (manager); UNIQUE per
--         (cycle, target, kind) so each nudge stage fires once per cycle.
-- =====================================================================
BEGIN;

-- ---------------------------------------------------------------------
-- 1a) Per-skill certification / currency policy
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS skill_certification_policies (
    id                        bigserial PRIMARY KEY,
    skill_id                  bigint NOT NULL UNIQUE REFERENCES skills(id) ON DELETE CASCADE,
    is_certification          boolean NOT NULL DEFAULT true,   -- formal cert/VOC (vs plain currency-tracked skill)
    validity_months           integer CHECK (validity_months IS NULL OR validity_months BETWEEN 1 AND 120),
                              -- NULL = certification never expires
    revalidation_window_days  integer NOT NULL DEFAULT 90
                              CHECK (revalidation_window_days BETWEEN 7 AND 365),
    decay_months              integer CHECK (decay_months IS NULL OR decay_months BETWEEN 1 AND 120),
                              -- NULL = no skill-currency decay for this skill
    created_by                bigint,                          -- admins.id
    created_at                timestamptz NOT NULL DEFAULT now(),
    updated_at                timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 1b) Issued certification / VOC records
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employee_certifications (
    id               bigserial PRIMARY KEY,
    employee_id      bigint NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    skill_id         bigint NOT NULL REFERENCES skills(id)    ON DELETE CASCADE,
    cert_number      text,
    issued_on        date NOT NULL,
    expires_on       date,                                    -- NULL = never expires
    is_revoked       boolean NOT NULL DEFAULT false,
    revoked_reason   text,
    -- VOC sign-off (who verified the competency in the field)
    verified_by_type text CHECK (verified_by_type IN ('admin', 'employee')),
    verified_by      bigint,
    verified_at      timestamptz,
    notes            text,
    -- One evidence file per record (certificate scan / VOC checklist photo),
    -- same AV pipeline as assessment evidence.
    file_uri         text,
    original_name    text,
    mime             text,
    size_bytes       bigint,
    av_status        public.av_status,
    av_signature     text,
    quarantine_uri   text,
    scanned_at       timestamptz,
    -- Expiry-alert watermark: 0 = none sent, 1 = 90d, 2 = 60d, 3 = 30d,
    -- 4 = expired. The job only sends when the computed stage EXCEEDS this.
    alert_stage      smallint NOT NULL DEFAULT 0 CHECK (alert_stage BETWEEN 0 AND 4),
    created_by       bigint,                                  -- admins.id who recorded it
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_cert_dates CHECK (expires_on IS NULL OR expires_on > issued_on)
);

CREATE INDEX IF NOT EXISTS idx_employee_certifications_emp_skill
    ON employee_certifications(employee_id, skill_id, issued_on DESC);
CREATE INDEX IF NOT EXISTS idx_employee_certifications_expiry
    ON employee_certifications(expires_on) WHERE NOT is_revoked;

-- ---------------------------------------------------------------------
-- 2) Position-coverage rules
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS coverage_rules (
    id                 bigserial PRIMARY KEY,
    name               text NOT NULL,
    site_id            bigint REFERENCES sites(id)       ON DELETE CASCADE,  -- NULL = any site
    department_id      bigint REFERENCES departments(id) ON DELETE CASCADE,  -- NULL = any department
    service_id         bigint REFERENCES services(id)    ON DELETE CASCADE,  -- NULL = any service
    skill_id           bigint NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    min_level          smallint NOT NULL DEFAULT 1 CHECK (min_level BETWEEN 1 AND 5),
    min_headcount      integer  NOT NULL CHECK (min_headcount >= 1),
    require_valid_cert boolean  NOT NULL DEFAULT false,
    severity           text     NOT NULL DEFAULT 'critical' CHECK (severity IN ('critical', 'warning')),
    is_active          boolean  NOT NULL DEFAULT true,
    -- Last evaluation (written by the coverage-check job) so breach
    -- TRANSITIONS are detectable and alerted exactly once.
    last_evaluated_at  timestamptz,
    last_actual        integer,
    last_satisfied     boolean,
    breached_since     timestamptz,
    created_by         bigint,                               -- admins.id
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coverage_rules_active ON coverage_rules(is_active);

-- ---------------------------------------------------------------------
-- 3) Nudge ledger (exactly-once per cycle/target/kind)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nudge_log (
    id          bigserial PRIMARY KEY,
    cycle_id    bigint NOT NULL REFERENCES assessment_cycles(id) ON DELETE CASCADE,
    target_type text   NOT NULL CHECK (target_type IN ('employee', 'manager')),
    target_id   bigint NOT NULL,
    kind        text   NOT NULL CHECK (kind IN ('reminder_7', 'reminder_2', 'escalation_3', 'escalation_overdue')),
    sent_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (cycle_id, target_type, target_id, kind)
);

-- ---------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------

-- Latest non-revoked certification per (employee, skill), active employees
-- only, with computed status:
--   'no_expiry' — never expires        'valid'    — expiry beyond the window
--   'expiring'  — inside the
--                 revalidation window  'expired'  — past expiry
DROP VIEW IF EXISTS v_certification_current CASCADE;
CREATE VIEW v_certification_current AS
SELECT
    c.id AS certification_id,
    ed.employee_id, ed.full_name,
    ed.site_id, ed.site_name, ed.department_id, ed.department_name,
    ed.service_id, ed.service_name,
    c.skill_id, s.name AS skill_name,
    c.cert_number, c.issued_on, c.expires_on,
    c.verified_by_type, c.verified_by, c.verified_at,
    c.av_status, c.alert_stage,
    p.revalidation_window_days,
    (c.expires_on - CURRENT_DATE) AS days_to_expiry,
    CASE
        WHEN c.expires_on IS NULL THEN 'no_expiry'
        WHEN c.expires_on < CURRENT_DATE THEN 'expired'
        WHEN c.expires_on - CURRENT_DATE <= COALESCE(p.revalidation_window_days, 90) THEN 'expiring'
        ELSE 'valid'
    END AS cert_status
FROM (
    SELECT DISTINCT ON (employee_id, skill_id) *
      FROM employee_certifications
     WHERE NOT is_revoked
     ORDER BY employee_id, skill_id, issued_on DESC, id DESC
) c
JOIN v_employee_details ed ON ed.employee_id = c.employee_id
JOIN skills s ON s.id = c.skill_id
LEFT JOIN skill_certification_policies p ON p.skill_id = c.skill_id;

-- Skill-currency decay: for skills with a decay policy, the latest resolved
-- level and whether it has LAPSED (older than decay_months with no
-- reassessment). Reported, not destructively rewritten.
DROP VIEW IF EXISTS v_skill_currency CASCADE;
CREATE VIEW v_skill_currency AS
SELECT
    ed.employee_id, ed.full_name,
    ed.site_id, ed.site_name, ed.department_id, ed.department_name,
    ed.service_id, ed.service_name,
    ra.skill_id, s.name AS skill_name,
    ra.level, ra.assessed_at,
    p.decay_months,
    EXTRACT(DAY FROM now() - ra.assessed_at)::int AS days_since_assessed,
    (ra.assessed_at < now() - make_interval(months => p.decay_months)) AS is_lapsed
FROM v_resolved_assessments ra
JOIN skill_certification_policies p ON p.skill_id = ra.skill_id AND p.decay_months IS NOT NULL
JOIN skills s ON s.id = ra.skill_id
JOIN v_employee_details ed ON ed.employee_id = ra.employee_id
WHERE ra.level > 0;

-- Live coverage evaluation for every ACTIVE rule: qualified = active
-- employees inside the rule's org filter with resolved level >= min_level
-- and (when required) a current valid/expiring/no-expiry certification.
-- ('expiring' still counts as covered — it is valid today; the cert-expiry
-- job is what drives the revalidation before it stops counting.)
DROP VIEW IF EXISTS v_coverage_status CASCADE;
CREATE VIEW v_coverage_status AS
SELECT
    r.id AS rule_id, r.name, r.severity, r.require_valid_cert,
    r.site_id, st.name AS site_name,
    r.department_id, d.name AS department_name,
    r.service_id, sv.name AS service_name,
    r.skill_id, s.name AS skill_name,
    r.min_level, r.min_headcount,
    r.last_satisfied, r.breached_since,
    COALESCE(q.qualified, 0) AS qualified_headcount,
    (COALESCE(q.qualified, 0) >= r.min_headcount) AS satisfied
FROM coverage_rules r
JOIN skills s ON s.id = r.skill_id
LEFT JOIN sites st       ON st.id = r.site_id
LEFT JOIN departments d  ON d.id  = r.department_id
LEFT JOIN services sv    ON sv.id = r.service_id
LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS qualified
      FROM v_employee_details ed
      JOIN v_resolved_assessments ra
        ON ra.employee_id = ed.employee_id
       AND ra.skill_id = r.skill_id
       AND ra.level >= r.min_level
     WHERE (r.site_id       IS NULL OR ed.site_id       = r.site_id)
       AND (r.department_id IS NULL OR ed.department_id = r.department_id)
       AND (r.service_id    IS NULL OR ed.service_id    = r.service_id)
       AND (NOT r.require_valid_cert OR EXISTS (
                SELECT 1
                  FROM v_certification_current cc
                 WHERE cc.employee_id = ed.employee_id
                   AND cc.skill_id = r.skill_id
                   AND cc.cert_status IN ('valid', 'expiring', 'no_expiry')))
) q ON true
WHERE r.is_active;

INSERT INTO schema_meta(key, value) VALUES ('56_voc_compliance_nudges', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();

COMMIT;
