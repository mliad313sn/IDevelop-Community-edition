-- ============================================================================
-- 161 — 360° feedback (multi-rater) and the shared one-to-one space.
--
-- Additive and idempotent: new tables, new nullable columns, new indexes.
-- Nothing existing is altered in meaning, nothing is dropped.
--
-- 360° FEEDBACK (development module)
--   feedback360_rounds       one launch: a questionnaire, a deadline, a minimum
--                            number of raters per group and an anonymity floor
--   feedback360_subjects     the person reviewed in a round (one or many = a
--                            campaign), with a snapshot of their role skills
--   feedback360_nominations  who is asked to answer, in which rater group.
--                            `responded` says THAT someone answered (reminders)
--                            and never WHAT they answered.
--   feedback360_responses    one submitted questionnaire. By design it carries
--                            NO rater id and NO timestamp, and its key is a
--                            random UUID (not a sequence), so a response cannot
--                            be joined back to a nomination by id order or time.
--                            Only the rater GROUP is kept — that is what the
--                            report aggregates on, under the anonymity floor.
--   feedback360_answers      the answers of one response. rating NULL means
--                            "not observed" — never 0.
--
-- SHARED ONE-TO-ONE SPACE (engagement module) — reuses check_ins (kind
-- 'one_on_one'): a 'scheduled' row is the next meeting, a 'completed' one is
-- history (TeamRosterService already reads it for "last 1:1").
--   one_on_one_agenda_items  topics either side adds before the meeting
--   one_on_one_notes         notes per author, visibility 'shared' (both see)
--                            or 'private' (only the author, ever)
--   check_in_items           + owner, due date, author and an optional link to
--                            an IDP objective or a goal (action items)
-- ============================================================================

-- ---- 360° feedback ----------------------------------------------------------

CREATE TABLE IF NOT EXISTS feedback360_rounds (
    id                  BIGSERIAL PRIMARY KEY,
    title               TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    kind                TEXT NOT NULL DEFAULT 'individual' CHECK (kind IN ('individual', 'campaign')),
    status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled')),
    deadline            DATE NOT NULL,
    min_raters          INTEGER NOT NULL DEFAULT 3 CHECK (min_raters BETWEEN 1 AND 20),
    -- The anonymity floor. Never below 3: a group of two is never shown.
    anonymity_threshold INTEGER NOT NULL DEFAULT 3 CHECK (anonymity_threshold BETWEEN 3 AND 20),
    -- 'manager': the subject sees the report once the round is closed AND their
    -- manager (or HR) has released it. 'on_close': as soon as the round closes.
    release_mode        TEXT NOT NULL DEFAULT 'manager' CHECK (release_mode IN ('manager', 'on_close')),
    behaviours          JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_by_type     TEXT NOT NULL CHECK (created_by_type IN ('admin', 'employee', 'system')),
    created_by_id       BIGINT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at           TIMESTAMPTZ,
    closed_by_type      TEXT,
    closed_by_id        BIGINT
);
CREATE INDEX IF NOT EXISTS idx_f360_rounds_status ON feedback360_rounds (status, deadline);

CREATE TABLE IF NOT EXISTS feedback360_subjects (
    id                  BIGSERIAL PRIMARY KEY,
    round_id            BIGINT NOT NULL REFERENCES feedback360_rounds(id) ON DELETE CASCADE,
    employee_id         BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    manager_employee_id BIGINT REFERENCES employees(id) ON DELETE SET NULL,
    status              TEXT NOT NULL DEFAULT 'nominating'
                        CHECK (status IN ('nominating', 'awaiting_approval', 'collecting', 'closed')),
    skills              JSONB NOT NULL DEFAULT '[]'::jsonb,
    nominated_at        TIMESTAMPTZ,
    approved_at         TIMESTAMPTZ,
    approved_by_type    TEXT,
    approved_by_id      BIGINT,
    released_at         TIMESTAMPTZ,
    released_by_type    TEXT,
    released_by_id      BIGINT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (round_id, employee_id)
);
CREATE INDEX IF NOT EXISTS idx_f360_subjects_employee ON feedback360_subjects (employee_id);
CREATE INDEX IF NOT EXISTS idx_f360_subjects_manager ON feedback360_subjects (manager_employee_id);

CREATE TABLE IF NOT EXISTS feedback360_nominations (
    id                BIGSERIAL PRIMARY KEY,
    subject_id        BIGINT NOT NULL REFERENCES feedback360_subjects(id) ON DELETE CASCADE,
    rater_employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    rater_group       TEXT NOT NULL CHECK (rater_group IN ('self', 'manager', 'peer', 'direct_report', 'other')),
    status            TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'declined')),
    proposed_by       TEXT NOT NULL DEFAULT 'subject' CHECK (proposed_by IN ('subject', 'manager', 'system')),
    responded         BOOLEAN NOT NULL DEFAULT false,
    invited_at        TIMESTAMPTZ,
    last_reminded_at  TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (subject_id, rater_employee_id)
);
CREATE INDEX IF NOT EXISTS idx_f360_nominations_rater ON feedback360_nominations (rater_employee_id, status, responded);

CREATE TABLE IF NOT EXISTS feedback360_responses (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_id  BIGINT NOT NULL REFERENCES feedback360_subjects(id) ON DELETE CASCADE,
    rater_group TEXT NOT NULL CHECK (rater_group IN ('self', 'manager', 'peer', 'direct_report', 'other'))
);
CREATE INDEX IF NOT EXISTS idx_f360_responses_subject ON feedback360_responses (subject_id);

CREATE TABLE IF NOT EXISTS feedback360_answers (
    response_id UUID NOT NULL REFERENCES feedback360_responses(id) ON DELETE CASCADE,
    item_type   TEXT NOT NULL CHECK (item_type IN ('skill', 'behaviour', 'comment')),
    item_key    TEXT NOT NULL CHECK (length(item_key) BETWEEN 1 AND 64),
    -- 0..4, or NULL = "not observed" (never counted as 0).
    rating      SMALLINT CHECK (rating BETWEEN 0 AND 4),
    body        TEXT CHECK (body IS NULL OR length(body) <= 2000),
    PRIMARY KEY (response_id, item_type, item_key)
);

-- ---- Shared one-to-one space -------------------------------------------------

-- The pair's meetings, newest first.
CREATE INDEX IF NOT EXISTS idx_check_ins_pair ON check_ins (employee_id, manager_id, kind, status);

CREATE TABLE IF NOT EXISTS one_on_one_agenda_items (
    id                 BIGSERIAL PRIMARY KEY,
    check_in_id        BIGINT NOT NULL REFERENCES check_ins(id) ON DELETE CASCADE,
    author_employee_id BIGINT REFERENCES employees(id) ON DELETE SET NULL,
    body               TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
    discussed          BOOLEAN NOT NULL DEFAULT false,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_oo_agenda_checkin ON one_on_one_agenda_items (check_in_id);

CREATE TABLE IF NOT EXISTS one_on_one_notes (
    id                 BIGSERIAL PRIMARY KEY,
    check_in_id        BIGINT NOT NULL REFERENCES check_ins(id) ON DELETE CASCADE,
    author_employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    visibility         TEXT NOT NULL CHECK (visibility IN ('shared', 'private')),
    body               TEXT NOT NULL CHECK (length(body) <= 10000),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (check_in_id, author_employee_id, visibility)
);
CREATE INDEX IF NOT EXISTS idx_oo_notes_checkin ON one_on_one_notes (check_in_id, visibility);

CREATE OR REPLACE TRIGGER trg_one_on_one_notes_updated_at
    BEFORE UPDATE ON one_on_one_notes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Action items: an owner, a due date, who wrote it, and an optional link to an
-- IDP objective or a goal. All nullable — existing items are untouched.
ALTER TABLE check_in_items ADD COLUMN IF NOT EXISTS owner_employee_id BIGINT REFERENCES employees(id) ON DELETE SET NULL;
ALTER TABLE check_in_items ADD COLUMN IF NOT EXISTS author_employee_id BIGINT REFERENCES employees(id) ON DELETE SET NULL;
ALTER TABLE check_in_items ADD COLUMN IF NOT EXISTS due_on DATE;
ALTER TABLE check_in_items ADD COLUMN IF NOT EXISTS idp_objective_id BIGINT REFERENCES idp_objectives(id) ON DELETE SET NULL;
ALTER TABLE check_in_items ADD COLUMN IF NOT EXISTS goal_id BIGINT REFERENCES goals(id) ON DELETE SET NULL;
