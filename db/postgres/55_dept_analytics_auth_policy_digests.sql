-- =====================================================================
-- 55_dept_analytics_auth_policy_digests.sql
--
-- Three additive feature surfaces (idempotent, no data loss):
--
--  1) Departmental analytics views:
--       v_department_matrix_completion  — Site → Department skill-matrix
--                                         completion % (convenience aggregate).
--       v_ninebox_current               — latest APPROVED 9-box eval per
--                                         employee, with org dimensions
--                                         (row-level, so callers can apply
--                                         RBAC scope before aggregating).
--       v_perf_actions                  — one row per performance action
--                                         (PIP / IDP / coaching / mentoring /
--                                         self-assessment) with org dims, for
--                                         date_trunc('month', …) time series.
--     All three derive from v_employee_details, which already filters
--     is_active = true — so a deactivated employee vanishes from every
--     analytic surface instantly, with NO application-side filtering needed.
--
--  2) Per-user authentication policy:
--       employees.auth_policy / admins.auth_policy
--         'any'          (default) local password or SSO, whatever is enabled
--         'sso_only'     local password refused (employees; declarative twin
--                        of the existing password_disabled switch)
--         'local_only'   SSO callback refused for this account
--         'mfa_required' the account must enrol in MFA before using the app
--     Enforced by src/middleware/authPolicy.js + the two login services.
--
--  3) digest_subscriptions — opt-in bi-weekly / monthly departmental status
--     digests for admins, managers and supervisors. The dept-digest job tick
--     (src/jobs/dept-digest.js) sends each recipient a report scoped to
--     exactly the org sub-tree they govern.
-- =====================================================================
BEGIN;

-- ---------------------------------------------------------------------
-- 2) Per-user authentication policy
-- ---------------------------------------------------------------------
ALTER TABLE employees ADD COLUMN IF NOT EXISTS auth_policy text NOT NULL DEFAULT 'any';
ALTER TABLE admins    ADD COLUMN IF NOT EXISTS auth_policy text NOT NULL DEFAULT 'any';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_employees_auth_policy') THEN
    ALTER TABLE employees ADD CONSTRAINT chk_employees_auth_policy
      CHECK (auth_policy IN ('any', 'sso_only', 'local_only', 'mfa_required'));
  END IF;
  -- Admins cannot use SSO at all (SsoController refuses admin identities so the
  -- second factor can never be bypassed) — 'sso_only' would self-lock an admin
  -- account, so it is not a legal admin policy value.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_admins_auth_policy') THEN
    ALTER TABLE admins ADD CONSTRAINT chk_admins_auth_policy
      CHECK (auth_policy IN ('any', 'local_only', 'mfa_required'));
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 3) Digest subscriptions (opt-in departmental status report)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS digest_subscriptions (
    id              bigserial PRIMARY KEY,
    subscriber_type text    NOT NULL CHECK (subscriber_type IN ('admin', 'employee')),
    subscriber_id   bigint  NOT NULL,           -- admins.id or employees.id
    frequency       text    NOT NULL DEFAULT 'biweekly'
                    CHECK (frequency IN ('biweekly', 'monthly')),
    day_of_week     integer NOT NULL DEFAULT 1  -- biweekly anchor day (0=Sunday)
                    CHECK (day_of_week BETWEEN 0 AND 6),
    day_of_month    integer NOT NULL DEFAULT 1  -- monthly send day
                    CHECK (day_of_month BETWEEN 1 AND 28),
    hour            integer NOT NULL DEFAULT 7  CHECK (hour BETWEEN 0 AND 23),
    is_active       boolean NOT NULL DEFAULT true,
    last_sent_on    date,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    -- one subscription per person
    UNIQUE (subscriber_type, subscriber_id)
);

CREATE INDEX IF NOT EXISTS idx_digest_subscriptions_due
    ON digest_subscriptions (is_active, last_sent_on);

-- ---------------------------------------------------------------------
-- 1) Analytics views
-- ---------------------------------------------------------------------

-- Latest APPROVED 9-box evaluation per employee, with org dimensions.
-- Row-level on purpose: controllers filter employee_id by the caller's RBAC
-- scope FIRST, then aggregate — so a manager only ever aggregates their own
-- sub-tree. Joining v_employee_details also excludes deactivated employees.
DROP VIEW IF EXISTS v_ninebox_current;
CREATE VIEW v_ninebox_current AS
SELECT
    ed.employee_id,
    ed.full_name,
    ed.site_id, ed.site_name,
    ed.department_id, ed.department_name,
    ed.service_id, ed.service_name,
    nb.box,
    nb.performance,
    nb.potential,
    nb.approved_at
FROM (
    SELECT DISTINCT ON (employee_id)
           employee_id, box, performance, potential, approved_at
      FROM nine_box_evaluations
     WHERE status = 'approved'
     ORDER BY employee_id, approved_at DESC NULLS LAST, id DESC
) nb
JOIN v_employee_details ed ON ed.employee_id = nb.employee_id;

-- One row per performance action, with org dimensions and a single
-- occurred_at column ready for date_trunc('month', …) grouping.
-- action_type: 'pip' | 'idp' | 'coaching' | 'mentoring' | 'self_assessment'
DROP VIEW IF EXISTS v_perf_actions;
CREATE VIEW v_perf_actions AS
SELECT a.action_type, a.action_id, a.employee_id, a.occurred_at, a.state,
       ed.site_id, ed.site_name, ed.department_id, ed.department_name,
       ed.service_id, ed.service_name
FROM (
    SELECT 'pip'::text AS action_type, p.id AS action_id, p.employee_id,
           p.created_at AS occurred_at, p.state::text AS state
      FROM pips p
    UNION ALL
    SELECT 'idp', ip.id, ip.employee_id, ip.created_at, ip.status::text
      FROM idp_plans ip
    UNION ALL
    -- coaching_plans.kind distinguishes coaching from mentoring natively
    SELECT cp.kind, cp.id, cp.employee_id, cp.created_at, cp.state
      FROM coaching_plans cp
    UNION ALL
    SELECT 'self_assessment', sa.id, sa.employee_id, sa.created_at, sa.status::text
      FROM self_assessments sa
) a
JOIN v_employee_details ed ON ed.employee_id = a.employee_id;

-- Convenience aggregate: Site → Department skill-matrix completion.
-- completion_pct = assessed required cells / total required cells.
-- Derives from v_employee_skill_gaps (active employees only).
DROP VIEW IF EXISTS v_department_matrix_completion;
CREATE VIEW v_department_matrix_completion AS
SELECT
    g.site_id, g.site_name,
    g.department_id, g.department_name,
    COUNT(DISTINCT g.employee_id)::int              AS headcount,
    COUNT(*)::int                                   AS required_cells,
    SUM(g.is_assessed)::int                         AS assessed_cells,
    ROUND(100.0 * SUM(g.is_assessed) / NULLIF(COUNT(*), 0), 1) AS completion_pct,
    ROUND(100.0 * SUM(g.is_met)     / NULLIF(COUNT(*), 0), 1)  AS met_pct
FROM v_employee_skill_gaps g
GROUP BY g.site_id, g.site_name, g.department_id, g.department_name;

INSERT INTO schema_meta(key, value) VALUES ('55_dept_analytics_auth_policy_digests', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();

COMMIT;
