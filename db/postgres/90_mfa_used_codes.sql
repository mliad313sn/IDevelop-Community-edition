-- FMEA (criticality 126) — a TOTP code was never consumed.
--
-- `verifyAtLogin` checked the code and returned; nothing recorded that it had been
-- used. With the +/-1 step tolerance a code therefore stayed usable for roughly 90
-- seconds, so one observed over a shoulder, read from a notification, or replayed
-- through a proxy worked a second time. A second factor that can be replayed only
-- proves possession at SOME point in the last minute and a half.
--
-- The unique index is the consumption: a replay loses the insert race rather than
-- being checked and then used, so two simultaneous attempts cannot both succeed.
--
-- Only a HASH is stored, salted with the user id, so the table never holds a live
-- code and the same six digits used by two people are distinct rows.

CREATE TABLE IF NOT EXISTS mfa_used_codes (
    id         BIGSERIAL PRIMARY KEY,
    user_type  TEXT        NOT NULL,
    user_id    BIGINT      NOT NULL,
    code_hash  TEXT        NOT NULL,
    used_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_type, user_id, code_hash)
);

-- Codes only need to be remembered for as long as they could still be accepted;
-- this index makes the housekeeping delete cheap.
CREATE INDEX IF NOT EXISTS idx_mfa_used_codes_used_at ON mfa_used_codes (used_at);
