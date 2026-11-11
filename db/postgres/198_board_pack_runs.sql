-- 198 — a board pack recorded as presented (4.0.0 port, wave 9)
--
-- The board pack compared itself with a fixed window of snapshots, never with
-- the pack the committee actually read last time, so « what has changed since
-- our last meeting? » had no answer.
--
--   board_pack_runs   one row each time a reader RECORDS a pack as presented
--                     (an explicit action, POST /exec/board-pack/record:
--                     opening or printing the pack writes nothing). It keeps
--                     what the pack said at that moment, so the next pack
--                     compares with THAT, never with a reconstruction:
--                       kpi_values      {"K1": {"value", "status", "unit"}, …}
--                                       as printed; null = not measured
--                       population_ids  the internal ids of the people of the
--                                       scope then (whole numbers, never a
--                                       name), for the exact entries and exits
--                       coverage        the coverage (K3) then, null = not measured
--                       kpi_contract    KpiService.CONTRACT_VERSION then: under
--                                       another contract the next pack says the
--                                       definitions changed and prints no delta
--                       snapshot_date   the latest daily snapshot of the scope
--                                       then, or null
--                     scope_key as in board_decisions (migration 197).
--
-- Append-only: the shared trigger public.block_mutation (migration 170)
-- refuses UPDATE and DELETE, so the database cleanup, the SQL console and
-- public.append_only_tables() find the table. The go-live reset empties it
-- with the other operational data. The erasure keeps population_ids: an
-- erased person's id resolves to the pseudonymised row.
--
-- Additive and idempotent: safe to re-run. Nothing is deleted.

CREATE TABLE IF NOT EXISTS public.board_pack_runs (
    id               bigserial   PRIMARY KEY,
    scope_key        text        NOT NULL,
    generated_at     timestamptz NOT NULL DEFAULT now(),
    pack_date        date        NOT NULL,
    kpi_contract     text        NOT NULL,
    snapshot_date    date,
    population       integer     NOT NULL,
    population_ids   bigint[]    NOT NULL DEFAULT '{}',
    coverage         numeric,
    kpi_values       jsonb       NOT NULL DEFAULT '{}'::jsonb,
    generated_by_ref text        NOT NULL
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'chk_board_pack_runs_scope'
                      AND conrelid = 'public.board_pack_runs'::regclass) THEN
        ALTER TABLE public.board_pack_runs ADD CONSTRAINT chk_board_pack_runs_scope CHECK (
            scope_key ~ '^(org|site:(none|[0-9]{1,9})|dept:[0-9]{1,9}|site:[0-9]{1,9}/dept:[0-9]{1,9}|svc:[0-9]{1,9}|reader:(admin|employee|manager):[0-9]{1,12}(/(site:(none|[0-9]{1,9})|dept:[0-9]{1,9}|site:[0-9]{1,9}/dept:[0-9]{1,9}|svc:[0-9]{1,9}))?)$'
        );
    END IF;
    -- the population is the number of ids, and every id is a real whole number
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'chk_board_pack_runs_population'
                      AND conrelid = 'public.board_pack_runs'::regclass) THEN
        ALTER TABLE public.board_pack_runs ADD CONSTRAINT chk_board_pack_runs_population CHECK (
            population >= 0
            AND population = coalesce(array_length(population_ids, 1), 0)
            AND array_position(population_ids, NULL) IS NULL
        );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'chk_board_pack_runs_coverage'
                      AND conrelid = 'public.board_pack_runs'::regclass) THEN
        ALTER TABLE public.board_pack_runs ADD CONSTRAINT chk_board_pack_runs_coverage
            CHECK (coverage IS NULL OR (coverage >= 0 AND coverage <= 100));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'chk_board_pack_runs_values'
                      AND conrelid = 'public.board_pack_runs'::regclass) THEN
        ALTER TABLE public.board_pack_runs ADD CONSTRAINT chk_board_pack_runs_values
            CHECK (jsonb_typeof(kpi_values) = 'object');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'chk_board_pack_runs_contract'
                      AND conrelid = 'public.board_pack_runs'::regclass) THEN
        ALTER TABLE public.board_pack_runs ADD CONSTRAINT chk_board_pack_runs_contract
            CHECK (char_length(kpi_contract) BETWEEN 1 AND 32
                   AND char_length(generated_by_ref) BETWEEN 1 AND 64);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_board_pack_runs_scope
    ON public.board_pack_runs (scope_key, generated_at DESC, id DESC);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger
                    WHERE tgname = 'trg_board_pack_runs_immutable'
                      AND tgrelid = 'public.board_pack_runs'::regclass) THEN
        CREATE TRIGGER trg_board_pack_runs_immutable
            BEFORE UPDATE OR DELETE ON public.board_pack_runs
            FOR EACH ROW EXECUTE FUNCTION public.block_mutation();
    END IF;
END $$;

COMMENT ON TABLE public.board_pack_runs IS
    'Board packs recorded as presented (migration 198): what the pack said then (values as printed, population ids, coverage, KPI contract); the next pack compares with it. Append-only.';

-- The SQL console reader stays in step with the schema (migration 168).
SELECT public.fn_console_reader_sync();
