-- 174_safety_gate_waivers_contests.sql — a human path on the safety-competency
-- gate (migration 150).
--
-- Until now the gate computed BLOCKED and nobody could act on the answer. This
-- migration adds:
--
--   safety_gate_rules.legally_mandatory
--       The rule is required by law. No waiver lifts it, and it stays enforced
--       whatever its mode (default false: nothing changes on upgrade).
--
--   safety_gate_waivers
--       A time-limited waiver on ONE critical skill of ONE person, granted by
--       the person's line (supervisor or manager) or by HSE within clearance.
--       A reason is required; the window is 72 hours at most (a CHECK below,
--       not only a form rule); one renewal. While it runs the status is
--       WAIVED, never CLEARED. A row is never deleted: it ends 'expired',
--       'renewed' or 'revoked', with its date (and a reason when revoked).
--
--   safety_gate_contests
--       The person, or their line, contests a BLOCKED status with a reason. An
--       HSE / HR reviewer records the decision with its reason: 'upheld', or
--       'overturned' with a remedy (a waiver, or a pointer to the data to
--       correct). One open contest per person.
--
--   safety_gate_status / _history
--       WAIVED joins the accepted statuses.
--
-- The reasons, the decision and the actor references are personal data:
-- src/services/erasureRegistry.js lists both tables, the DSR export carries
-- them and the go-live reset wipes them.
--
-- Additive and idempotent. Nothing is deleted.

ALTER TABLE safety_gate_rules ADD COLUMN IF NOT EXISTS legally_mandatory boolean NOT NULL DEFAULT false;

ALTER TABLE safety_gate_status DROP CONSTRAINT IF EXISTS chk_safety_gate_status;
ALTER TABLE safety_gate_status
    ADD CONSTRAINT chk_safety_gate_status
    CHECK (status IN ('CLEARED', 'BLOCKED', 'EXPIRING', 'NOT_CONFIGURED', 'WAIVED'));
ALTER TABLE safety_gate_status DROP CONSTRAINT IF EXISTS chk_safety_gate_status_enforced;
ALTER TABLE safety_gate_status
    ADD CONSTRAINT chk_safety_gate_status_enforced
    CHECK (enforced_status IS NULL
           OR enforced_status IN ('CLEARED', 'BLOCKED', 'EXPIRING', 'NOT_CONFIGURED', 'WAIVED'));

CREATE TABLE IF NOT EXISTS safety_gate_waivers (
    id              bigserial   PRIMARY KEY,
    employee_id     bigint      NOT NULL REFERENCES employees(id),
    skill_id        bigint      NOT NULL REFERENCES skills(id),
    rule_id         bigint      REFERENCES safety_gate_rules(id),
    reason          text        NOT NULL,
    granted_by_ref  text        NOT NULL,
    granted_via     text        NOT NULL,
    starts_at       timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL,
    renewal_of      bigint      REFERENCES safety_gate_waivers(id),
    contest_id      bigint,
    state           text        NOT NULL DEFAULT 'active',
    ended_at        timestamptz,
    ended_reason    text,
    revoked_by_ref  text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_sg_waiver_reason CHECK (length(btrim(reason)) > 0),
    CONSTRAINT chk_sg_waiver_via CHECK (granted_via IN ('line', 'hse', 'contest')),
    CONSTRAINT chk_sg_waiver_state CHECK (state IN ('active', 'renewed', 'expired', 'revoked')),
    CONSTRAINT chk_sg_waiver_window
        CHECK (expires_at > starts_at AND expires_at <= starts_at + interval '72 hours'),
    CONSTRAINT chk_sg_waiver_revoked
        CHECK (state <> 'revoked' OR (ended_reason IS NOT NULL AND length(btrim(ended_reason)) > 0))
);
-- One running waiver per person and skill; a waiver is renewed at most once.
CREATE UNIQUE INDEX IF NOT EXISTS ux_sg_waiver_active
    ON safety_gate_waivers (employee_id, skill_id) WHERE state = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS ux_sg_waiver_renewal
    ON safety_gate_waivers (renewal_of) WHERE renewal_of IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_sg_waiver_due
    ON safety_gate_waivers (expires_at) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS ix_sg_waiver_emp ON safety_gate_waivers (employee_id, created_at DESC);

CREATE TABLE IF NOT EXISTS safety_gate_contests (
    id                  bigserial   PRIMARY KEY,
    employee_id         bigint      NOT NULL REFERENCES employees(id),
    contested_by_ref    text        NOT NULL,
    contested_as        text        NOT NULL,
    reason              text        NOT NULL,
    status_at_contest   text        NOT NULL,
    reasons_at_contest  jsonb       NOT NULL DEFAULT '[]'::jsonb,
    state               text        NOT NULL DEFAULT 'open',
    decision_reason     text,
    decided_by_ref      text,
    decided_at          timestamptz,
    remedy              text,
    correction_pointer  text,
    waiver_id           bigint      REFERENCES safety_gate_waivers(id),
    created_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_sg_contest_reason CHECK (length(btrim(reason)) > 0),
    CONSTRAINT chk_sg_contest_as CHECK (contested_as IN ('self', 'line')),
    CONSTRAINT chk_sg_contest_state CHECK (state IN ('open', 'upheld', 'overturned')),
    CONSTRAINT chk_sg_contest_decided
        CHECK (state = 'open'
               OR (decided_by_ref IS NOT NULL AND decided_at IS NOT NULL
                   AND decision_reason IS NOT NULL AND length(btrim(decision_reason)) > 0)),
    CONSTRAINT chk_sg_contest_remedy
        CHECK ((state = 'overturned') = (remedy IS NOT NULL)
               AND (remedy IS NULL OR remedy IN ('waiver', 'data_correction'))),
    CONSTRAINT chk_sg_contest_remedy_detail
        CHECK ((remedy IS DISTINCT FROM 'waiver' OR waiver_id IS NOT NULL)
               AND (remedy IS DISTINCT FROM 'data_correction'
                    OR (correction_pointer IS NOT NULL AND length(btrim(correction_pointer)) > 0)))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_sg_contest_open
    ON safety_gate_contests (employee_id) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS ix_sg_contest_emp ON safety_gate_contests (employee_id, created_at DESC);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sg_waiver_contest') THEN
        ALTER TABLE safety_gate_waivers
            ADD CONSTRAINT fk_sg_waiver_contest
            FOREIGN KEY (contest_id) REFERENCES safety_gate_contests(id);
    END IF;
END $$;

-- The SQL console reader sees the new tables and column (migration 168).
SELECT public.fn_console_reader_sync();
