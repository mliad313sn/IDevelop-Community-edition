-- 146 — campaign reviewer assignment, honest close, IDP lifecycle (3.23.17)
--
-- Three things the external review proved by reading the code:
--
--   1. "Assign a reviewer" on the campaign console wrote cycle_participants.
--      supervisor_id / reviewer_admin_id — the SAME columns the launch fills
--      with its snapshot. Nothing could tell an explicit choice made on the
--      console from the launch-time snapshot, so the reminder job kept
--      chasing the launch-time reviewer after a manager change, and the
--      review authority ignored the choice altogether. `reviewer_assigned_*`
--      marks an EXPLICIT assignment (NULL = launch snapshot only).
--
--   2. Closing a campaign stamped submitted / under-review rows
--      locked_state = 'finalized' — the value the IDP generator reads as
--      "validated". A row nobody reviewed is now stamped 'closed_unreviewed'.
--      The value is ADDED here and never USED in this file (PostgreSQL
--      forbids using an enum value in the transaction that adds it).
--
--   3. An IDP could never complete: only draft -> active existed. Plans now
--      carry who closed them, when and why, and every lifecycle move is kept
--      in an append-only journal (idp_plan_events). Nothing is ever deleted.
--
-- Additive and idempotent.

ALTER TYPE locked_state ADD VALUE IF NOT EXISTS 'closed_unreviewed';

ALTER TABLE cycle_participants ADD COLUMN IF NOT EXISTS reviewer_assigned_at          timestamptz;
ALTER TABLE cycle_participants ADD COLUMN IF NOT EXISTS reviewer_assigned_by_admin_id bigint REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE cycle_participants ADD COLUMN IF NOT EXISTS reviewer_assigned_by_ref      text;

ALTER TABLE idp_plans ADD COLUMN IF NOT EXISTS closed_at      timestamptz;
ALTER TABLE idp_plans ADD COLUMN IF NOT EXISTS closed_by_type text;
ALTER TABLE idp_plans ADD COLUMN IF NOT EXISTS closed_by_id   bigint;
ALTER TABLE idp_plans ADD COLUMN IF NOT EXISTS close_reason   text;

CREATE TABLE IF NOT EXISTS idp_plan_events (
    id            bigserial   PRIMARY KEY,
    idp_id        bigint      NOT NULL REFERENCES idp_plans(id),
    objective_id  bigint      REFERENCES idp_objectives(id),
    action        text        NOT NULL,
    from_state    text,
    to_state      text,
    actor_type    text,
    actor_id      bigint,
    reason        text,
    detail        jsonb,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_idp_plan_events_idp ON idp_plan_events (idp_id, created_at);
