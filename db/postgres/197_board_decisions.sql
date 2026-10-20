-- 197 — the decisions taken on a board pack, and their follow-up (4.0.0 port, wave 9)
--
-- The board pack ended on empty lines for « decisions taken »: what the
-- committee decided was written on paper and nobody followed it. Two tables
-- make the pack a loop:
--
--   board_decisions        one row per decision, for ONE pack scope. The
--                          decision itself (its text, the pack and decision
--                          dates, the owner ROLE, the due date, the linked
--                          indicator, who recorded it) never changes once
--                          written: a different decision is a new row. Only
--                          the follow-up state moves (state, state_changed_at,
--                          closed_at), and every move is also an event below.
--                          Never deleted: a decision that will not be carried
--                          out is « dropped », with a reason.
--   board_decision_events  the append-only history of a decision: its
--                          creation, each change of state (from, to, note) and
--                          each follow-up note.
--
-- scope_key — which pack a decision belongs to:
--   'org' (an unrestricted reader's whole organisation), 'site:<id>',
--   'site:none', 'dept:<id>', 'site:<id>/dept:<id>', 'svc:<id>', or
--   'reader:<admin|employee|manager>:<id>[/<unit>]' — a reader who does not
--   see the whole of a unit keeps their decisions under their OWN key, so a
--   line manager never reads nor moves the committee's decisions of that
--   site, and the committee never reads theirs. Only whole numbers.
--
-- The owner is a ROLE from a fixed list (exec_committee, hr_director, hse,
-- site, training, hr_local, managers, finance), never a person: the board
-- pack names nobody. The text is checked by the application for a person's
-- name before it is written (src/utils/boardNameGuard.js), because a text in
-- this table can never be redacted afterwards; the person's access export
-- lists any board text that names them (DSRService.export).
--
-- Guards:
--   - board_decisions_guard (BEFORE UPDATE): only the follow-up state may
--     change;
--   - the shared append-only trigger public.block_mutation (migration 170)
--     refuses a DELETE on board_decisions and any UPDATE or DELETE on
--     board_decision_events, so the database cleanup, the SQL console and
--     public.append_only_tables() find both tables the way they find every
--     append-only table. The go-live reset empties them with the other
--     operational data (TRUNCATE, which no row trigger sees).
--
-- Additive and idempotent: safe to re-run. Nothing is deleted.

CREATE TABLE IF NOT EXISTS public.board_decisions (
    id               bigserial   PRIMARY KEY,
    scope_key        text        NOT NULL,
    pack_date        date        NOT NULL,
    decided_at       date        NOT NULL,
    decision_text    text        NOT NULL,
    owner_role       text        NOT NULL,
    due_date         date,
    kpi_id           text,
    state            text        NOT NULL DEFAULT 'open',
    state_changed_at timestamptz NOT NULL DEFAULT now(),
    closed_at        timestamptz,
    created_by_ref   text        NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'chk_board_decisions_scope'
                      AND conrelid = 'public.board_decisions'::regclass) THEN
        ALTER TABLE public.board_decisions ADD CONSTRAINT chk_board_decisions_scope CHECK (
            scope_key ~ '^(org|site:(none|[0-9]{1,9})|dept:[0-9]{1,9}|site:[0-9]{1,9}/dept:[0-9]{1,9}|svc:[0-9]{1,9}|reader:(admin|employee|manager):[0-9]{1,12}(/(site:(none|[0-9]{1,9})|dept:[0-9]{1,9}|site:[0-9]{1,9}/dept:[0-9]{1,9}|svc:[0-9]{1,9}))?)$'
        );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'chk_board_decisions_text'
                      AND conrelid = 'public.board_decisions'::regclass) THEN
        ALTER TABLE public.board_decisions ADD CONSTRAINT chk_board_decisions_text
            CHECK (length(btrim(decision_text)) BETWEEN 1 AND 2000);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'chk_board_decisions_owner_role'
                      AND conrelid = 'public.board_decisions'::regclass) THEN
        ALTER TABLE public.board_decisions ADD CONSTRAINT chk_board_decisions_owner_role CHECK (
            owner_role IN ('exec_committee', 'hr_director', 'hse', 'site', 'training',
                           'hr_local', 'managers', 'finance')
        );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'chk_board_decisions_kpi'
                      AND conrelid = 'public.board_decisions'::regclass) THEN
        ALTER TABLE public.board_decisions ADD CONSTRAINT chk_board_decisions_kpi
            CHECK (kpi_id IS NULL OR kpi_id ~ '^K[0-9]{1,2}$');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'chk_board_decisions_state'
                      AND conrelid = 'public.board_decisions'::regclass) THEN
        ALTER TABLE public.board_decisions ADD CONSTRAINT chk_board_decisions_state
            CHECK (state IN ('open', 'in_progress', 'done', 'dropped'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'chk_board_decisions_closed'
                      AND conrelid = 'public.board_decisions'::regclass) THEN
        ALTER TABLE public.board_decisions ADD CONSTRAINT chk_board_decisions_closed
            CHECK ((state IN ('done', 'dropped')) = (closed_at IS NOT NULL));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'chk_board_decisions_dates'
                      AND conrelid = 'public.board_decisions'::regclass) THEN
        ALTER TABLE public.board_decisions ADD CONSTRAINT chk_board_decisions_dates
            CHECK (due_date IS NULL OR due_date >= decided_at);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'chk_board_decisions_ref'
                      AND conrelid = 'public.board_decisions'::regclass) THEN
        ALTER TABLE public.board_decisions ADD CONSTRAINT chk_board_decisions_ref
            CHECK (char_length(created_by_ref) BETWEEN 1 AND 64);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_board_decisions_scope
    ON public.board_decisions (scope_key, decided_at DESC, id DESC);

-- A recorded decision never changes; only its follow-up state moves.
CREATE OR REPLACE FUNCTION public.board_decisions_guard() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.scope_key IS DISTINCT FROM OLD.scope_key
       OR NEW.pack_date IS DISTINCT FROM OLD.pack_date
       OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
       OR NEW.decision_text IS DISTINCT FROM OLD.decision_text
       OR NEW.owner_role IS DISTINCT FROM OLD.owner_role
       OR NEW.due_date IS DISTINCT FROM OLD.due_date
       OR NEW.kpi_id IS DISTINCT FROM OLD.kpi_id
       OR NEW.created_by_ref IS DISTINCT FROM OLD.created_by_ref
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'IMMUTABLE_TABLE: board_decisions — only the follow-up state may change'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$fn$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger
                    WHERE tgname = 'trg_board_decisions_guard'
                      AND tgrelid = 'public.board_decisions'::regclass) THEN
        CREATE TRIGGER trg_board_decisions_guard
            BEFORE UPDATE ON public.board_decisions
            FOR EACH ROW EXECUTE FUNCTION public.board_decisions_guard();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger
                    WHERE tgname = 'trg_board_decisions_no_delete'
                      AND tgrelid = 'public.board_decisions'::regclass) THEN
        CREATE TRIGGER trg_board_decisions_no_delete
            BEFORE DELETE ON public.board_decisions
            FOR EACH ROW EXECUTE FUNCTION public.block_mutation();
    END IF;
END $$;

COMMENT ON TABLE public.board_decisions IS
    'Decisions taken on a board pack (migration 197): one immutable decision per row, the owner is a role, never a person; only the follow-up state changes (history in board_decision_events). Never deleted.';

CREATE TABLE IF NOT EXISTS public.board_decision_events (
    id          bigserial   PRIMARY KEY,
    decision_id bigint      NOT NULL REFERENCES public.board_decisions (id),
    kind        text        NOT NULL,
    from_state  text,
    to_state    text,
    note        text,
    actor_ref   text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'chk_board_decision_events_kind'
                      AND conrelid = 'public.board_decision_events'::regclass) THEN
        ALTER TABLE public.board_decision_events ADD CONSTRAINT chk_board_decision_events_kind
            CHECK (kind IN ('created', 'state', 'note'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'chk_board_decision_events_from_state'
                      AND conrelid = 'public.board_decision_events'::regclass) THEN
        ALTER TABLE public.board_decision_events ADD CONSTRAINT chk_board_decision_events_from_state
            CHECK (from_state IS NULL OR from_state IN ('open', 'in_progress', 'done', 'dropped'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'chk_board_decision_events_to_state'
                      AND conrelid = 'public.board_decision_events'::regclass) THEN
        ALTER TABLE public.board_decision_events ADD CONSTRAINT chk_board_decision_events_to_state
            CHECK (to_state IS NULL OR to_state IN ('open', 'in_progress', 'done', 'dropped'));
    END IF;
    -- created: a first state; state: a real move, and dropping says why;
    -- note: some text.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'chk_board_decision_events_shape'
                      AND conrelid = 'public.board_decision_events'::regclass) THEN
        ALTER TABLE public.board_decision_events ADD CONSTRAINT chk_board_decision_events_shape CHECK (
            (kind = 'created' AND to_state IS NOT NULL)
            OR (kind = 'state' AND from_state IS NOT NULL AND to_state IS NOT NULL
                AND from_state <> to_state
                AND (to_state <> 'dropped' OR length(btrim(coalesce(note, ''))) > 0))
            OR (kind = 'note' AND length(btrim(coalesce(note, ''))) > 0)
        );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'chk_board_decision_events_note'
                      AND conrelid = 'public.board_decision_events'::regclass) THEN
        ALTER TABLE public.board_decision_events ADD CONSTRAINT chk_board_decision_events_note
            CHECK (note IS NULL OR length(note) <= 2000);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'chk_board_decision_events_ref'
                      AND conrelid = 'public.board_decision_events'::regclass) THEN
        ALTER TABLE public.board_decision_events ADD CONSTRAINT chk_board_decision_events_ref
            CHECK (char_length(actor_ref) BETWEEN 1 AND 64);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_board_decision_events_decision
    ON public.board_decision_events (decision_id, id);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger
                    WHERE tgname = 'trg_board_decision_events_immutable'
                      AND tgrelid = 'public.board_decision_events'::regclass) THEN
        CREATE TRIGGER trg_board_decision_events_immutable
            BEFORE UPDATE OR DELETE ON public.board_decision_events
            FOR EACH ROW EXECUTE FUNCTION public.block_mutation();
    END IF;
END $$;

COMMENT ON TABLE public.board_decision_events IS
    'Append-only history of the board decisions (migration 197): creation, each change of state with its note, each follow-up note.';

-- The SQL console reader stays in step with the schema (migration 168).
SELECT public.fn_console_reader_sync();
