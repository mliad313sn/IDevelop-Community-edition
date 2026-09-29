-- 46: accent-insensitive search.
-- The unaccent extension itself needs superuser, so the installer creates it
-- (like citext/pg_trgm). This migration is guarded so it also succeeds when the
-- app role reruns it without the privilege — search then simply stays
-- accent-sensitive until the extension exists.
DO $do$
BEGIN
    BEGIN
        CREATE EXTENSION IF NOT EXISTS unaccent;
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'unaccent extension not created (%) — accent-insensitive search disabled until an admin creates it', SQLERRM;
    END;

    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'unaccent') THEN
        -- IMMUTABLE wrapper (unaccent is only STABLE) so it can back
        -- expression indexes later if search volume ever demands them.
        EXECUTE 'CREATE OR REPLACE FUNCTION public.f_unaccent(text) '
             || 'RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT '
             || 'AS ''SELECT public.unaccent(''''public.unaccent'''', $1)''';
    END IF;
END
$do$;

INSERT INTO schema_meta(key, value) VALUES ('46_search_unaccent', 'applied')
ON CONFLICT (key) DO NOTHING;
