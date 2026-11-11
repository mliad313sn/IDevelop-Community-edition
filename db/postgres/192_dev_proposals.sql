-- 192 — the person proposes, the line decides (4.0.0 port, wave 4)
--
-- The person a development plan is for never acts on it (authority ladder),
-- but may PROPOSE an action to their line: a 70-20-10 type, one sentence and,
-- optionally, a skill. The line accepts it into the plan (a draft plan is
-- created when none is open) or declines it with a reason the person reads.
-- With no line, the proposal is routed to HR (the local administrators whose
-- clearance covers the person). A proposal ends accepted, declined or
-- withdrawn; nothing is deleted by the application.
--
-- proposal_text and decision_reason are free text about a person: they are
-- in the erasure registry (src/services/erasureRegistry.js) in the same change.
-- The go-live reset wipes the table and the database cleanup clears it with
-- the plans (scripts/reset-for-golive.js, DatabaseCleanupService).
--
-- Additive and idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS public.dev_proposals (
    id                 bigserial PRIMARY KEY,
    employee_id        bigint NOT NULL REFERENCES public.employees(id),
    skill_id           bigint REFERENCES public.skills(id) ON DELETE SET NULL,
    action_type        text NOT NULL DEFAULT 'training',
    proposal_text      text NOT NULL,
    status             text NOT NULL DEFAULT 'pending',
    routed_to          text NOT NULL DEFAULT 'line',
    idp_id             bigint REFERENCES public.idp_plans(id) ON DELETE SET NULL,
    created_action_id  bigint REFERENCES public.idp_actions(id) ON DELETE SET NULL,
    decided_by_type    text,
    decided_by_id      bigint,
    decided_at         timestamptz,
    decision_reason    text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_dev_proposals_status CHECK (status IN ('pending', 'accepted', 'declined', 'withdrawn')),
    CONSTRAINT chk_dev_proposals_routed CHECK (routed_to IN ('line', 'hr')),
    CONSTRAINT chk_dev_proposals_type CHECK (action_type IN
        ('training', 'coaching', 'mentoring', 'on_the_job', 'self_study', 'certification', 'stretch')),
    CONSTRAINT chk_dev_proposals_decided_by_type CHECK (decided_by_type IS NULL
        OR decided_by_type IN ('employee', 'manager', 'admin')),
    CONSTRAINT chk_dev_proposals_text CHECK (length(btrim(proposal_text)) BETWEEN 1 AND 500)
);

CREATE INDEX IF NOT EXISTS ix_dev_proposals_employee ON public.dev_proposals (employee_id, status);
CREATE INDEX IF NOT EXISTS ix_dev_proposals_pending ON public.dev_proposals (created_at)
    WHERE status = 'pending';

COMMENT ON TABLE public.dev_proposals IS
    'Development actions a person proposed to their line (migration 192). proposal_text and decision_reason are erased with the person.';

-- The SQL console reader stays in step with the schema (migration 168).
SELECT public.fn_console_reader_sync();
