-- ============================================================================
-- Capability expansion (assessment corrective build). Additive & idempotent.
-- Closes market/stakeholder gaps: goal cascading, calibration, DEI demographics,
-- skills graph + proficiency, internal mobility, engagement surveys, recognition
-- & continuous feedback, integrated review summary, merit, outbound webhooks,
-- gap→learning, GDPR DSR.
-- ============================================================================

-- ---- Enums (guarded) -------------------------------------------------------
DO $$ BEGIN CREATE TYPE public.objective_level AS ENUM ('company','department','site','team'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE public.calibration_status AS ENUM ('draft','in_progress','finalized','cancelled'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE public.skill_relation AS ENUM ('related','adjacent','prerequisite','broader','narrower'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE public.opportunity_kind AS ENUM ('gig','project','mentorship','role'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE public.opportunity_state AS ENUM ('open','filled','closed'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE public.survey_kind AS ENUM ('engagement','enps','pulse','onboarding','exit'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE public.survey_state AS ENUM ('draft','open','closed'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE public.skill_validation AS ENUM ('self','manager_validated','evidence_backed'); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ---- 1) Goal cascading: org/team objectives + cross-owner alignment --------
CREATE TABLE IF NOT EXISTS public.org_objectives (
    id           bigserial PRIMARY KEY,
    level        public.objective_level NOT NULL,
    title        text NOT NULL,
    description  text,
    site_id      bigint REFERENCES public.sites(id) ON DELETE SET NULL,
    department_id bigint REFERENCES public.departments(id) ON DELETE SET NULL,
    owner_admin_id bigint REFERENCES public.admins(id) ON DELETE SET NULL,
    period       text,
    status       text NOT NULL DEFAULT 'active',
    created_at   timestamptz NOT NULL DEFAULT now()
);
-- Link an employee goal (okr_goals) to a parent org objective (cross-owner allowed).
CREATE TABLE IF NOT EXISTS public.goal_alignment (
    id              bigserial PRIMARY KEY,
    goal_id         bigint NOT NULL,                 -- okr_goals.id (soft ref; goals live in v1 API)
    org_objective_id bigint NOT NULL REFERENCES public.org_objectives(id) ON DELETE CASCADE,
    contribution_weight numeric(4,2) DEFAULT 1.0,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_goal_alignment UNIQUE (goal_id, org_objective_id)
);
CREATE INDEX IF NOT EXISTS idx_goal_alignment_obj ON public.goal_alignment (org_objective_id);

-- ---- 2) Calibration sessions + adjustments (append-only audit) -------------
CREATE TABLE IF NOT EXISTS public.calibration_sessions (
    id           bigserial PRIMARY KEY,
    cycle_id     bigint REFERENCES public.assessment_cycles(id) ON DELETE SET NULL,
    scope_type   text,                               -- 'site' | 'department' | 'service' | 'org'
    scope_id     bigint,
    facilitator_admin_id bigint REFERENCES public.admins(id) ON DELETE SET NULL,
    status       public.calibration_status NOT NULL DEFAULT 'draft',
    target_distribution jsonb,                        -- optional per-box target %
    notes        text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    finalized_at timestamptz
);
CREATE TABLE IF NOT EXISTS public.calibration_adjustments (
    id            bigserial PRIMARY KEY,
    session_id    bigint NOT NULL REFERENCES public.calibration_sessions(id) ON DELETE CASCADE,
    employee_id   bigint NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
    from_box      text,
    to_box        text NOT NULL,
    rationale     text NOT NULL,
    actor_admin_id bigint REFERENCES public.admins(id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_calib_adj_session ON public.calibration_adjustments (session_id);

-- ---- 3) DEI demographics (sealed) + nothing else reads core PII ------------
CREATE TABLE IF NOT EXISTS public.employee_demographics (
    employee_id   bigint PRIMARY KEY REFERENCES public.employees(id) ON DELETE CASCADE,
    gender        text,
    ethnicity     text,
    age_band      text,                               -- store band, not DOB
    disability    boolean,
    nationality   text,
    self_declared boolean NOT NULL DEFAULT true,
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ---- 4) Skills graph + proficiency descriptors -----------------------------
CREATE TABLE IF NOT EXISTS public.skill_relationships (
    id         bigserial PRIMARY KEY,
    skill_a    bigint NOT NULL REFERENCES public.skills(id) ON DELETE CASCADE,
    skill_b    bigint NOT NULL REFERENCES public.skills(id) ON DELETE CASCADE,
    relation   public.skill_relation NOT NULL DEFAULT 'related',
    weight     numeric(4,3) NOT NULL DEFAULT 0.5,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_skill_rel UNIQUE (skill_a, skill_b, relation),
    CONSTRAINT chk_skill_rel_distinct CHECK (skill_a <> skill_b)
);
CREATE INDEX IF NOT EXISTS idx_skill_rel_a ON public.skill_relationships (skill_a);
CREATE INDEX IF NOT EXISTS idx_skill_rel_b ON public.skill_relationships (skill_b);

CREATE TABLE IF NOT EXISTS public.proficiency_descriptors (
    id         bigserial PRIMARY KEY,
    skill_id   bigint REFERENCES public.skills(id) ON DELETE CASCADE,   -- null = applies by category
    category   text,
    level      smallint NOT NULL,
    anchor     text NOT NULL,                          -- "what Level N looks like"
    CONSTRAINT chk_prof_level CHECK (level BETWEEN 0 AND 4)
);
-- Validation state for a skill assessment (self → manager → evidence).
ALTER TABLE public.skill_assessments ADD COLUMN IF NOT EXISTS validation public.skill_validation NOT NULL DEFAULT 'self';

-- ---- 5) Internal mobility marketplace + aspirations ------------------------
CREATE TABLE IF NOT EXISTS public.opportunities (
    id            bigserial PRIMARY KEY,
    kind          public.opportunity_kind NOT NULL DEFAULT 'gig',
    title         text NOT NULL,
    description   text,
    role_id       bigint REFERENCES public.roles(id) ON DELETE SET NULL,
    site_id       bigint REFERENCES public.sites(id) ON DELETE SET NULL,
    department_id bigint REFERENCES public.departments(id) ON DELETE SET NULL,
    skills_sought jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{skillId, level}]
    posted_by_admin_id bigint REFERENCES public.admins(id) ON DELETE SET NULL,
    state         public.opportunity_state NOT NULL DEFAULT 'open',
    closes_on     date,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_opportunities_state ON public.opportunities (state);
CREATE TABLE IF NOT EXISTS public.opportunity_applications (
    id             bigserial PRIMARY KEY,
    opportunity_id bigint NOT NULL REFERENCES public.opportunities(id) ON DELETE CASCADE,
    employee_id    bigint NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
    note           text,
    status         text NOT NULL DEFAULT 'applied',
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_opp_app UNIQUE (opportunity_id, employee_id)
);
CREATE TABLE IF NOT EXISTS public.employee_aspirations (
    employee_id    bigint PRIMARY KEY REFERENCES public.employees(id) ON DELETE CASCADE,
    target_role_id bigint REFERENCES public.roles(id) ON DELETE SET NULL,
    interests      text,
    open_to_mobility boolean NOT NULL DEFAULT true,
    updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ---- 6) Engagement surveys -------------------------------------------------
CREATE TABLE IF NOT EXISTS public.surveys (
    id          bigserial PRIMARY KEY,
    kind        public.survey_kind NOT NULL DEFAULT 'pulse',
    title       text NOT NULL,
    anonymous   boolean NOT NULL DEFAULT true,
    min_responses smallint NOT NULL DEFAULT 4,         -- anonymity suppression threshold
    state       public.survey_state NOT NULL DEFAULT 'draft',
    created_by_admin_id bigint REFERENCES public.admins(id) ON DELETE SET NULL,
    opened_at   timestamptz,
    closed_at   timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.survey_questions (
    id        bigserial PRIMARY KEY,
    survey_id bigint NOT NULL REFERENCES public.surveys(id) ON DELETE CASCADE,
    ord       smallint NOT NULL DEFAULT 0,
    text      text NOT NULL,
    qtype     text NOT NULL DEFAULT 'scale',           -- 'scale'(1-5) | 'nps'(0-10) | 'text'
    category  text
);
CREATE TABLE IF NOT EXISTS public.survey_responses (
    id          bigserial PRIMARY KEY,
    survey_id   bigint NOT NULL REFERENCES public.surveys(id) ON DELETE CASCADE,
    question_id bigint NOT NULL REFERENCES public.survey_questions(id) ON DELETE CASCADE,
    -- employee_id kept ONLY to enforce one-response-per-question + scope rollup;
    -- aggregation suppresses below min_responses so individuals aren't exposed.
    employee_id bigint REFERENCES public.employees(id) ON DELETE SET NULL,
    score       smallint,
    text_answer text,
    site_id     bigint, department_id bigint,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_survey_resp UNIQUE (survey_id, question_id, employee_id)
);
CREATE INDEX IF NOT EXISTS idx_survey_resp_survey ON public.survey_responses (survey_id);

-- ---- 7) Recognition + continuous feedback ----------------------------------
CREATE TABLE IF NOT EXISTS public.recognitions (
    id          bigserial PRIMARY KEY,
    from_employee_id bigint REFERENCES public.employees(id) ON DELETE SET NULL,
    to_employee_id   bigint NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
    value_tag   text,
    message     text NOT NULL,
    visibility  text NOT NULL DEFAULT 'team',          -- 'team' | 'private' | 'org'
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recognitions_to ON public.recognitions (to_employee_id);
CREATE TABLE IF NOT EXISTS public.feedback_notes (
    id          bigserial PRIMARY KEY,
    about_employee_id bigint NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
    author_employee_id bigint REFERENCES public.employees(id) ON DELETE SET NULL,
    author_admin_id    bigint REFERENCES public.admins(id) ON DELETE SET NULL,
    kind        text NOT NULL DEFAULT 'feedback',      -- 'feedback' | 'praise' | 'request'
    body        text NOT NULL,
    visibility  text NOT NULL DEFAULT 'manager',
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_feedback_about ON public.feedback_notes (about_employee_id);

-- ---- 8) Integrated review summary + merit ----------------------------------
CREATE TABLE IF NOT EXISTS public.review_summaries (
    id          bigserial PRIMARY KEY,
    cycle_id    bigint REFERENCES public.assessment_cycles(id) ON DELETE SET NULL,
    employee_id bigint NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
    overall_rating smallint,                            -- 1..5
    goal_score    smallint,
    behavior_score smallint,
    narrative   text,
    signed_by_admin_id bigint REFERENCES public.admins(id) ON DELETE SET NULL,
    signed_at   timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_review_summary UNIQUE (cycle_id, employee_id)
);
CREATE TABLE IF NOT EXISTS public.merit_recommendations (
    id          bigserial PRIMARY KEY,
    cycle_id    bigint REFERENCES public.assessment_cycles(id) ON DELETE SET NULL,
    employee_id bigint NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
    suggested_pct numeric(5,2),
    manager_pct numeric(5,2),
    rationale   text,
    status      text NOT NULL DEFAULT 'proposed',
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_merit UNIQUE (cycle_id, employee_id)
);

-- ---- 9) Outbound event webhooks --------------------------------------------
CREATE TABLE IF NOT EXISTS public.webhook_subscriptions (
    id          bigserial PRIMARY KEY,
    label       text NOT NULL,
    url         text NOT NULL,
    secret      text,                                   -- HMAC signing secret
    events      jsonb NOT NULL DEFAULT '["*"]'::jsonb,   -- event names or ["*"]
    enabled     boolean NOT NULL DEFAULT true,
    created_by_admin_id bigint REFERENCES public.admins(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    last_status text, last_delivery_at timestamptz
);
CREATE TABLE IF NOT EXISTS public.webhook_deliveries (
    id          bigserial PRIMARY KEY,
    subscription_id bigint NOT NULL REFERENCES public.webhook_subscriptions(id) ON DELETE CASCADE,
    event       text NOT NULL,
    payload     jsonb,
    status_code integer,
    ok          boolean,
    attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliv_sub ON public.webhook_deliveries (subscription_id);
