-- 166: Erasure under legal hold, two-person override (GDPR art. 17 and 18).
--
-- An erasure is REFUSED while the person (or their retention job) is under
-- legal hold. A SuperAdmin may override only with a written reason AND the
-- approval of a SECOND, different SuperAdmin. Each step is a row here plus an
-- audit line; the erasure itself runs only from an approved request, and
-- DSRService re-checks the request (approved, same employee, approver is not
-- the requester) before it acts: a caller cannot just pass "true".
--
-- One open request per employee. Nothing is ever deleted: a request ends
-- 'executed', 'refused', 'withdrawn' or 'expired', with who and when.
-- Ids only (admin ids, employee id): no names, no employee number.
--
-- Additive and idempotent.

CREATE TABLE IF NOT EXISTS erasure_override_requests (
    id                     bigserial   PRIMARY KEY,
    employee_id            bigint      NOT NULL,
    requested_by_admin_id  bigint      NOT NULL,
    reason                 text        NOT NULL,
    hold_snapshot          jsonb,
    state                  text        NOT NULL DEFAULT 'pending',
    requested_at           timestamptz NOT NULL DEFAULT now(),
    decided_by_admin_id    bigint,
    decided_at             timestamptz,
    decision_note          text,
    executed_at            timestamptz,
    CONSTRAINT chk_eor_state CHECK (state IN ('pending', 'approved', 'executed', 'refused', 'withdrawn', 'expired')),
    CONSTRAINT chk_eor_reason CHECK (length(btrim(reason)) > 0),
    CONSTRAINT chk_eor_two_people CHECK (decided_by_admin_id IS NULL OR decided_by_admin_id <> requested_by_admin_id OR state = 'withdrawn'),
    CONSTRAINT chk_eor_decided CHECK (state IN ('pending', 'expired') OR (decided_by_admin_id IS NOT NULL AND decided_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_eor_one_open
    ON erasure_override_requests (employee_id) WHERE state IN ('pending', 'approved');
CREATE INDEX IF NOT EXISTS idx_eor_state ON erasure_override_requests (state, requested_at);
