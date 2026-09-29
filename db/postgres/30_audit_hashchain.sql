-- ============================================================================
-- Tamper-evident audit: hash-chain the append-only system_logs. Each row's
-- row_hash = sha256(prev_row_hash || canonical payload), so altering or removing
-- any past row breaks the chain from that point — detectable even by someone
-- with direct DB access who disables the immutability trigger. Additive & idempotent.
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE public.system_logs ADD COLUMN IF NOT EXISTS prev_hash text;
ALTER TABLE public.system_logs ADD COLUMN IF NOT EXISTS row_hash  text;

CREATE OR REPLACE FUNCTION public.fn_system_logs_hashchain()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p text;
BEGIN
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

DROP TRIGGER IF EXISTS trg_system_logs_hashchain ON public.system_logs;
CREATE TRIGGER trg_system_logs_hashchain
    BEFORE INSERT ON public.system_logs
    FOR EACH ROW EXECUTE FUNCTION public.fn_system_logs_hashchain();
