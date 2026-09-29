-- Append-only audit tables: refuse TRUNCATE at the database level.
--
-- The three append-only tables (system_logs — the hash-chained audit trail —,
-- assessment_history and review_signatures) are protected by
-- trg_*_immutable, a BEFORE DELETE OR UPDATE ... FOR EACH ROW trigger on
-- block_mutation. TRUNCATE is not a row-level event: it never fires a
-- row-level trigger, so a plain `TRUNCATE system_logs` erased the whole trail
-- with no trigger ever running. Measured on a clone: 6 085 -> 0 rows, committed.
-- The SQL console's app-layer guard refused the verb — until a leading comment
-- hid it — but the database itself promised nothing.
--
-- This adds the statement-level guard the row-level one cannot give:
-- BEFORE TRUNCATE ... FOR EACH STATEMENT on the same three tables. It raises the
-- same IMMUTABLE_TABLE error (check_violation) so every existing handler reads it
-- the same way. Table owners can still disable it deliberately (and audibly —
-- ALTER TABLE ... DISABLE TRIGGER is itself refused from the console), which is
-- what scripts/reset-for-golive.js does for its documented pre-go-live wipe.
--
-- Also removes the orphan setting `assessmentHistoryRetention`: it was displayed
-- (365 days) but nothing has ever read it, and assessment_history cannot be pruned
-- by row deletes — the trigger above forbids exactly that. A retention number that
-- enforces nothing is an unenforced policy presented as enforced.
--
-- Idempotent: safe to re-run.

CREATE OR REPLACE FUNCTION public.block_truncate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'IMMUTABLE_TABLE: % is append-only (TRUNCATE refused)', TG_TABLE_NAME
        USING ERRCODE = 'check_violation';
END;
$$;

DROP TRIGGER IF EXISTS trg_system_logs_no_truncate ON public.system_logs;
CREATE TRIGGER trg_system_logs_no_truncate
    BEFORE TRUNCATE ON public.system_logs
    FOR EACH STATEMENT EXECUTE FUNCTION public.block_truncate();

DROP TRIGGER IF EXISTS trg_assessment_history_no_truncate ON public.assessment_history;
CREATE TRIGGER trg_assessment_history_no_truncate
    BEFORE TRUNCATE ON public.assessment_history
    FOR EACH STATEMENT EXECUTE FUNCTION public.block_truncate();

DROP TRIGGER IF EXISTS trg_review_signatures_no_truncate ON public.review_signatures;
CREATE TRIGGER trg_review_signatures_no_truncate
    BEFORE TRUNCATE ON public.review_signatures
    FOR EACH STATEMENT EXECUTE FUNCTION public.block_truncate();

DELETE FROM public.app_settings WHERE setting_key = 'assessmentHistoryRetention';
