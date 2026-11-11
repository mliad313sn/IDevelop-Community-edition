-- 165: Privacy notice, self-service "my data" download and objection to profiling.
--
-- GDPR art. 13/14 (information), 15 (access) and 21 (objection), and the
-- equivalent national data-protection laws.
--
--   privacy_notice_versions   the controller-editable notice (FR + EN). Each
--                             edit is a NEW row; a published version is never
--                             rewritten (append-only by design).
--   privacy_notice_acks       who acknowledged which version, and when. Keyed on
--                             the signed-in identity (a kiosk acknowledges per
--                             person, not per device).
--   profiling_objections      the person's objection to automated profiling
--                             (set / withdrawn, with reasons and the HR review
--                             stamp). Withdrawal closes the row; nothing is
--                             deleted.
--   privacy_paused_triggers   automatic 9-box development triggers held for HR
--                             review because the person objected.
--   privacy_self_exports      every self-service download (audit + rate limit).
--
-- Additive and idempotent. Nothing is deleted.

CREATE TABLE IF NOT EXISTS privacy_notice_versions (
    id            bigserial   PRIMARY KEY,
    version       integer     NOT NULL,
    title_fr      text        NOT NULL,
    title_en      text        NOT NULL,
    body_fr       text        NOT NULL,
    body_en       text        NOT NULL,
    change_note   text,
    published_by  text,
    published_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_privacy_notice_version ON privacy_notice_versions (version);

CREATE TABLE IF NOT EXISTS privacy_notice_acks (
    id               bigserial   PRIMARY KEY,
    subject_type     text        NOT NULL CHECK (subject_type IN ('admin', 'employee')),
    subject_id       bigint      NOT NULL,
    version          integer     NOT NULL,
    locale           text,
    acknowledged_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_privacy_notice_ack
    ON privacy_notice_acks (subject_type, subject_id, version);

CREATE TABLE IF NOT EXISTS profiling_objections (
    id                bigserial   PRIMARY KEY,
    employee_id       bigint      NOT NULL,
    reason            text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    withdrawn_at      timestamptz,
    withdrawn_reason  text,
    hr_reviewed_at    timestamptz,
    hr_reviewed_by    text,
    hr_note           text
);
-- At most ONE open objection per person (a second "set" is a no-op).
CREATE UNIQUE INDEX IF NOT EXISTS uq_profiling_objection_open
    ON profiling_objections (employee_id) WHERE withdrawn_at IS NULL;

CREATE TABLE IF NOT EXISTS privacy_paused_triggers (
    id                    bigserial   PRIMARY KEY,
    employee_id           bigint      NOT NULL,
    zone                  text        NOT NULL CHECK (zone IN ('red', 'blue')),
    performance           text,
    potential             text,
    origin_evaluation_id  bigint,
    created_at            timestamptz NOT NULL DEFAULT now(),
    resolved_at           timestamptz,
    resolved_by           text,
    resolution            text        CHECK (resolution IS NULL OR resolution IN ('proceed', 'dismiss')),
    resolution_reason     text,
    CONSTRAINT chk_paused_trigger_resolved
        CHECK ((resolved_at IS NULL AND resolution IS NULL)
            OR (resolved_at IS NOT NULL AND resolution IS NOT NULL
                AND length(btrim(COALESCE(resolution_reason, ''))) > 0))
);
-- One open hold per (person, zone): a re-approval does not stack holds.
CREATE UNIQUE INDEX IF NOT EXISTS uq_privacy_paused_trigger_open
    ON privacy_paused_triggers (employee_id, zone) WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS privacy_self_exports (
    id            bigserial   PRIMARY KEY,
    subject_type  text        NOT NULL CHECK (subject_type IN ('admin', 'employee')),
    subject_id    bigint      NOT NULL,
    format        text        NOT NULL CHECK (format IN ('json', 'html')),
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_privacy_self_exports_subject
    ON privacy_self_exports (subject_type, subject_id, created_at);
