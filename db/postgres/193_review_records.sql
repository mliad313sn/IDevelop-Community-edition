-- 193 — the end-of-campaign record (4.0.0 port, wave 5)
--
-- Once a campaign is locked or closed, the person can read what was decided
-- about them in it — their own rating, the validated level, whether it was
-- adjusted, a dispute still open, their development plans — and say they have
-- READ it. Reading is never agreement. They may add a comment, and change it.
--
-- review_records keeps, per person and campaign, what was shown when they
-- acknowledged it, the date, and their comment.
--
-- What the snapshot holds (owner decision 8 of the 4.0.0 port): ids, levels,
-- states and dates only. No free text — not the reviewer's reason for an
-- adjusted rating, not a skill or a person's name. The page reads the reasons
-- and the names live, so an erasure of the person (or of the reason) leaves
-- nothing behind here and needs no way round the guard below. The only free
-- text is the person's own comment, which the erasure redacts (the guard lets
-- the comment change) and which is in the erasure registry
-- (src/services/erasureRegistry.js) in the same change.
--
-- Guards:
--   - a record is never deleted by the application: the shared append-only
--     trigger (public.block_mutation, migration 170) refuses a DELETE, so the
--     cleanup, the data reset and the SQL console find the table the way they
--     find every append-only table, and suspend it the same way;
--   - once written, only the comment and its date may change
--     (review_records_guard). The go-live reset empties the table with the
--     other assessment data (TRUNCATE, which no row trigger sees).
--
-- The setting newInRoleMonths (default 6, 0 = off) says for how long after
-- employees.role_start_date (migration 188) a person is shown as « new in the
-- role » on the 9-box and PIP screens (src/utils/newInRole.js). It is an
-- ordinary setting, not security-class.
--
-- Additive and idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS public.review_records (
    id                bigserial   PRIMARY KEY,
    employee_id       bigint      NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
    cycle_id          bigint      NOT NULL REFERENCES public.assessment_cycles(id),
    snapshot          jsonb       NOT NULL,
    acknowledged_at   timestamptz NOT NULL DEFAULT now(),
    employee_comment  text,
    comment_at        timestamptz,
    CONSTRAINT uq_review_records_person_cycle UNIQUE (employee_id, cycle_id),
    CONSTRAINT chk_review_records_comment CHECK (employee_comment IS NULL OR length(employee_comment) <= 4000),
    CONSTRAINT chk_review_records_snapshot CHECK (jsonb_typeof(snapshot) = 'object')
);

CREATE INDEX IF NOT EXISTS ix_review_records_cycle ON public.review_records (cycle_id);

-- Only the comment (and its date) may change once the record is written.
CREATE OR REPLACE FUNCTION public.review_records_guard() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.employee_id IS DISTINCT FROM OLD.employee_id
       OR NEW.cycle_id IS DISTINCT FROM OLD.cycle_id
       OR NEW.snapshot IS DISTINCT FROM OLD.snapshot
       OR NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at THEN
        RAISE EXCEPTION 'IMMUTABLE_TABLE: review_records — only the comment may change'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$fn$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger
                    WHERE tgname = 'trg_review_records_guard'
                      AND tgrelid = 'public.review_records'::regclass) THEN
        CREATE TRIGGER trg_review_records_guard
            BEFORE UPDATE ON public.review_records
            FOR EACH ROW EXECUTE FUNCTION public.review_records_guard();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger
                    WHERE tgname = 'trg_review_records_no_delete'
                      AND tgrelid = 'public.review_records'::regclass) THEN
        CREATE TRIGGER trg_review_records_no_delete
            BEFORE DELETE ON public.review_records
            FOR EACH ROW EXECUTE FUNCTION public.block_mutation();
    END IF;
END $$;

COMMENT ON TABLE public.review_records IS
    'End-of-campaign record per person and campaign (migration 193): ids, levels, states and dates shown when the person acknowledged reading it, and their own comment (erased with them). Never deleted; only the comment changes.';

INSERT INTO public.app_settings (setting_key, setting_value, setting_type, description, category)
VALUES ('newInRoleMonths',
        '6',
        'number',
        'For how many months after the recorded start date in the role a person is shown as « new in the role » on the 9-box and PIP screens (0 = never). Without a recorded start date, nobody is.',
        'readiness')
ON CONFLICT (setting_key) DO NOTHING;

-- The SQL console reader stays in step with the schema (migration 168).
SELECT public.fn_console_reader_sync();
