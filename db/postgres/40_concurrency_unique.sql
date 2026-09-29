-- 40_concurrency_unique.sql — prevent duplicate "open" records that concurrent
-- requests (double-click / two 9-box placements) could create via check-then-act
-- (the services SELECT-then-INSERT with no DB-level guard). Partial UNIQUE indexes
-- make the second insert fail loudly instead of silently duplicating. Verified 0
-- existing violations on prod the production database + dev a development database before adding.

-- One open PIP per employee (open = not yet closed/cancelled). An employee having
-- two concurrent open PIPs is always wrong, so this is a safe business invariant.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pip_open_per_employee
    ON pips (employee_id)
    WHERE state IN ('proposed', 'approved', 'active');

-- NOTE: intentionally NO "one open coaching plan per employee" index — coaching
-- legitimately allows multiple concurrent open plans per employee across contexts
-- (PIP-tied, IDP-tied, manual), keyed by pip_id/context. App-side check-then-act
-- (by employee_id + pip_id) already prevents the duplicate that matters.

-- One open dispute per supervisor review (open = open or escalated).
CREATE UNIQUE INDEX IF NOT EXISTS uq_dispute_open_per_review
    ON assessment_disputes (supervisor_review_id)
    WHERE state IN ('open', 'escalated');

-- One active handover plan per (leaver, lifecycle event).
CREATE UNIQUE INDEX IF NOT EXISTS uq_handover_per_event
    ON handover_plans (outgoing_employee_id, lifecycle_event_id)
    WHERE status <> 'cancelled';

INSERT INTO schema_meta(key, value) VALUES ('40_concurrency_unique', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();
