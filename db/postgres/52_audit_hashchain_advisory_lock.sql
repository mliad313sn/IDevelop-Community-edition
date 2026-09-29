-- ============================================================================
-- Serialize the system_logs hash-chain trigger (concurrency integrity fix).
--
-- The BEFORE INSERT trigger in 30_audit_hashchain.sql reads the current "latest"
-- row_hash to compute the next row's hash. Under concurrency (two requests writing
-- an audit row at the same time), BOTH transactions can read the SAME predecessor
-- before either commits — forking the chain: two rows share one prev_hash, and the
-- tamper-evidence guarantee silently breaks. A naive BEFORE INSERT trigger cannot
-- see the other in-flight insert.
--
-- Fix: take a transaction-scoped advisory lock at the TOP of the trigger so appends
-- to system_logs serialize. pg_advisory_xact_lock auto-releases at commit/rollback,
-- so it needs no explicit unlock and never leaks. The lock key is a fixed value
-- derived from the chain's name (any constant works — it only has to be unique to
-- this chain). Additive & idempotent: CREATE OR REPLACE only rewrites the function.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_system_logs_hashchain()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p text;
BEGIN
    -- Serialize concurrent appends so the predecessor read below is authoritative.
    PERFORM pg_advisory_xact_lock(hashtext('system_logs_hashchain')::bigint);

    SELECT row_hash INTO p FROM public.system_logs ORDER BY id DESC LIMIT 1;
    NEW.prev_hash := p;
    NEW.row_hash := encode(digest(
        coalesce(p, '') || '|' ||
        coalesce(NEW.admin_id::text, '') || '|' ||
        coalesce(NEW.action, '') || '|' ||
        coalesce(NEW.entity_type, '') || '|' ||
        coalesce(NEW.entity_id::text, '') || '|' ||
        coalesce(NEW.details::text, '') || '|' ||
        coalesce(NEW.created_at::text, now()::text), 'sha256'), 'hex');
    RETURN NEW;
END $$;

-- Trigger definition itself is unchanged (still BEFORE INSERT FOR EACH ROW from 30_).
