-- ============================================================================
-- Self-service onboarding: a holding area for people who self-register (open
-- signup) or sign in via SSO without an existing account. They are NOT yet
-- employees — `employees` requires site/department/service/role (NOT NULL) — so
-- they wait here until an admin "places" them (which creates the real employee
-- row). Additive & idempotent.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.onboarding_requests (
    id                  bigserial PRIMARY KEY,
    email               public.citext NOT NULL,
    first_name          text,
    last_name           text,
    source              text NOT NULL DEFAULT 'signup',   -- 'signup' | 'sso'
    auth_provider       text,                              -- 'local' (signup) | provider key (sso)
    external_id         text,                              -- SSO subject id (sso only)
    password_hash       text,                              -- chosen at signup (local only)
    status              text NOT NULL DEFAULT 'pending',   -- 'pending' | 'approved' | 'rejected'
    requested_at        timestamptz NOT NULL DEFAULT now(),
    decided_at          timestamptz,
    decided_by          bigint,                            -- admin id that placed/rejected
    decision_note       text,
    created_employee_id bigint,                            -- set when approved/placed
    CONSTRAINT chk_onboarding_status CHECK (status IN ('pending','approved','rejected')),
    CONSTRAINT chk_onboarding_source CHECK (source IN ('signup','sso'))
);

-- At most one OPEN (pending) request per email; resolved rows may repeat.
CREATE UNIQUE INDEX IF NOT EXISTS idx_onboarding_pending_email
    ON public.onboarding_requests (lower(email)) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_onboarding_status ON public.onboarding_requests (status);
