-- 187 — Department snapshots and the « What changed » digests.
--
--   1) kpi_snapshots.scope_type gains 'department' (scope_id = the department
--      id). Same daily contract, same idempotency key, NULL never coalesced
--      (migration 82). The CHECK is widened, never narrowed: every existing
--      'org' and 'site' row stays valid.
--   2) kpi_snapshots.safety_fit_n: the K9 denominator behind safety_fit_pct,
--      so a « What changed » sentence on K9 can apply the small-n rule (fewer
--      than 5 people, no sentence). NULL on every row written before this
--      migration: an unknown n is never assumed large, so no K9 sentence is
--      written against those rows.
--   3) persona_digests: the ARCHIVE of every « What changed » digest (in-app
--      page /digests/:id, works with SMTP off). Aggregates and unit ids only,
--      never a person's name. state 'silent' = the period was evaluated and
--      there was nothing to say (no message sent); it is kept so the job never
--      evaluates the same period twice and so the read-rate rule ignores it.
--   4) persona_digest_prefs: per account, the cadence (NULL = the default),
--      the read-rate step-down (eight digests in a row left unopened: daily,
--      then weekly, then off) and « Turn back on ».
--
-- The digests are OPT-IN: nothing is sent until an administrator switches
-- personaDigestsEnabled on (App Settings → Scheduled jobs; absent = off). The
-- existing weekly manager digest and the department digests are untouched.
--
-- Additive and idempotent: safe to re-run. Nothing is deleted or rewritten.

-- ---- 1) department scope ---------------------------------------------------
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'chk_kpi_snapshot_scope'
           AND conrelid = 'public.kpi_snapshots'::regclass
           AND pg_get_constraintdef(oid) NOT LIKE '%department%'
    ) THEN
        ALTER TABLE public.kpi_snapshots DROP CONSTRAINT chk_kpi_snapshot_scope;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'chk_kpi_snapshot_scope'
           AND conrelid = 'public.kpi_snapshots'::regclass
    ) THEN
        ALTER TABLE public.kpi_snapshots
            ADD CONSTRAINT chk_kpi_snapshot_scope
            CHECK (scope_type IN ('org', 'site', 'department'));
    END IF;
END $$;

-- ---- 2) K9 denominator -----------------------------------------------------
ALTER TABLE public.kpi_snapshots ADD COLUMN IF NOT EXISTS safety_fit_n integer;
COMMENT ON COLUMN public.kpi_snapshots.safety_fit_n IS
    'K9 denominator: people on a safety-gated role with every blocking requirement evidenced. NULL = unknown (a row written before migration 187): no « What changed » sentence on K9 is written against it.';
COMMENT ON COLUMN public.kpi_snapshots.scope_type IS
    'org (scope_id 0) | site (scope_id = site id) | department (scope_id = department id, from migration 187).';

-- ---- 3) digest archive -----------------------------------------------------
CREATE TABLE IF NOT EXISTS public.persona_digests (
    id           bigserial   PRIMARY KEY,
    user_type    text        NOT NULL,
    user_id      bigint      NOT NULL,
    persona      text        NOT NULL,
    cadence      text        NOT NULL,
    window_days  integer     NOT NULL,
    period_key   date        NOT NULL,
    state        text        NOT NULL DEFAULT 'sent',
    payload      jsonb       NOT NULL DEFAULT '{}'::jsonb,
    opened_at    timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_persona_digest_user_type CHECK (user_type IN ('admin', 'employee')),
    CONSTRAINT chk_persona_digest_persona
        CHECK (persona IN ('executive', 'hr', 'manager', 'employee')),
    CONSTRAINT chk_persona_digest_cadence CHECK (cadence IN ('daily', 'weekly')),
    CONSTRAINT chk_persona_digest_state CHECK (state IN ('sent', 'silent')),
    CONSTRAINT chk_persona_digest_window CHECK (window_days BETWEEN 1 AND 366),
    CONSTRAINT chk_persona_digest_payload CHECK (jsonb_typeof(payload) = 'object'),
    CONSTRAINT uq_persona_digest_period UNIQUE (user_type, user_id, period_key)
);
CREATE INDEX IF NOT EXISTS idx_persona_digests_owner
    ON public.persona_digests (user_type, user_id, created_at DESC);
COMMENT ON TABLE public.persona_digests IS
    'Archived « What changed » digests (migration 187). Aggregates and unit ids only, never a name. state silent = evaluated, nothing to say, no message. opened_at = first time the owner opened the archived page.';

-- ---- 4) per-account cadence and read-rate step-down --------------------------
CREATE TABLE IF NOT EXISTS public.persona_digest_prefs (
    user_type       text        NOT NULL,
    user_id         bigint      NOT NULL,
    cadence         text,
    stepdown_at     timestamptz,
    stepdown_from   text,
    reactivated_at  timestamptz,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_type, user_id),
    CONSTRAINT chk_persona_digest_pref_user_type CHECK (user_type IN ('admin', 'employee')),
    CONSTRAINT chk_persona_digest_pref_cadence
        CHECK (cadence IS NULL OR cadence IN ('daily', 'weekly', 'off')),
    CONSTRAINT chk_persona_digest_pref_from
        CHECK (stepdown_from IS NULL OR stepdown_from IN ('daily', 'weekly'))
);
COMMENT ON TABLE public.persona_digest_prefs IS
    'Cadence of the « What changed » digest per account (NULL = weekly). stepdown_* = eight digests in a row left unopened; reactivated_at = « Turn back on » (migration 187).';

SELECT public.fn_console_reader_sync();
