-- 179 — the schema says what the code writes.
--
-- opportunity_applications.status had no CHECK, while the code writes exactly
-- four values (MobilityService apply / withdraw / decide, LifecycleService
-- leaver and its revert): applied | withdrawn | accepted | declined. The CHECK
-- pins that vocabulary so a fifth spelling can never reach the table unnoticed.
--
-- An existing install could in theory hold another value written by hand or by
-- an old import. The migration never fails on that, and never rewrites a row:
-- when such a row exists the constraint is added NOT VALID (enforced for every
-- new or changed row, the old rows left as they are) and a NOTICE names how
-- many rows to review. Once they are corrected, a DBA can run
--   ALTER TABLE opportunity_applications VALIDATE CONSTRAINT chk_opportunity_applications_status;
--
-- supervisor_reviews.priority_index (migration 03, DEFAULT 0) was never
-- computed: the hourly `priority-index.refresh` job required a service that
-- does not exist. The job is removed from src/jobs/index.js; the column stays
-- (nothing is dropped) and is marked deprecated, so nobody reads its 0 as a
-- measurement.
--
-- Additive and idempotent (guarded by pg_constraint). Nothing is deleted.

DO $$
DECLARE
    n_other bigint;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'chk_opportunity_applications_status'
           AND conrelid = 'public.opportunity_applications'::regclass
    ) THEN
        SELECT count(*) INTO n_other
          FROM public.opportunity_applications
         WHERE status IS NULL OR status NOT IN ('applied', 'withdrawn', 'accepted', 'declined');
        IF n_other = 0 THEN
            ALTER TABLE public.opportunity_applications
                ADD CONSTRAINT chk_opportunity_applications_status
                CHECK (status IN ('applied', 'withdrawn', 'accepted', 'declined'));
        ELSE
            ALTER TABLE public.opportunity_applications
                ADD CONSTRAINT chk_opportunity_applications_status
                CHECK (status IN ('applied', 'withdrawn', 'accepted', 'declined')) NOT VALID;
            RAISE NOTICE 'opportunity_applications: % row(s) hold a status outside applied/withdrawn/accepted/declined; the CHECK was added NOT VALID. Correct them, then VALIDATE CONSTRAINT chk_opportunity_applications_status.', n_other;
        END IF;
    END IF;
END $$;

COMMENT ON COLUMN public.opportunity_applications.status IS
    'applied | withdrawn | accepted | declined (CHECK since migration 179). A withdrawal is a state, never a deletion.';

COMMENT ON COLUMN public.supervisor_reviews.priority_index IS
    'DEPRECATED (migration 179): never computed, so its DEFAULT 0 is not a measurement. The refresh job was removed; do not read, sort or display this column.';
