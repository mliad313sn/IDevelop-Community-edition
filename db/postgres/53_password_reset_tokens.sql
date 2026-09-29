-- ============================================================================
-- Self-service password reset tokens. Best-practice storage:
--   * Only the SHA-256 HASH of the token is stored (the raw token lives only in
--     the emailed link) — a DB leak yields no usable reset tokens.
--   * Short TTL (expires_at) + single-use (used_at) — enforced in the service.
--   * Works for both admins and employees (subject_type + subject_id).
-- Additive & idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id           bigserial PRIMARY KEY,
    subject_type text        NOT NULL CHECK (subject_type IN ('admin','employee')),
    subject_id   bigint      NOT NULL,
    token_hash   text        NOT NULL,           -- sha256(raw token), hex
    expires_at   timestamptz NOT NULL,
    used_at      timestamptz,
    request_ip   text,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_prt_token_hash ON password_reset_tokens (token_hash);
CREATE INDEX IF NOT EXISTS ix_prt_subject    ON password_reset_tokens (subject_type, subject_id);
CREATE INDEX IF NOT EXISTS ix_prt_expires    ON password_reset_tokens (expires_at);
