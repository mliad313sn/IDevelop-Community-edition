-- 168 — reusable re-grant of the SQL console read-only role
--
-- Migration 167 grants the `sqlconsole_reader` role table by table (and column
-- by column on the tables that carry a secret column). A table created by a
-- later migration, or a new column on a column-granted table (employees,
-- admins, api_keys, app_settings, ...), stays unreadable from the console until
-- the grants are repeated. This migration turns 167's DO block into a function
-- so a later migration only has to end with:
--
--     SELECT public.fn_console_reader_sync();
--
-- The function has the same three lists as 167 (keep them in step with
-- SqlConsoleService.SECRET_TABLES, SECRET_COLUMNS and GUARDED_TABLES;
-- migration167ConsoleReaderRole-db.test.js checks both files). It is
-- idempotent, runs with the caller's rights (never SECURITY DEFINER), and never
-- fails a migration: without CREATEROLE, or on a relation the caller does not
-- own, it raises a NOTICE and the console keeps its application-level guard.
--
-- Arguments (defaults are what production uses; the test passes a private
-- schema and role so it never touches the shared tables):
--   p_schema  schema whose relations are granted   (default 'public')
--   p_role    the read-only role                   (default 'sqlconsole_reader')
-- Returns a one-line summary.

CREATE OR REPLACE FUNCTION public.fn_console_reader_sync(
    p_schema text DEFAULT 'public',
    p_role text DEFAULT 'sqlconsole_reader'
) RETURNS text
LANGUAGE plpgsql
AS $console_reader_sync$
DECLARE
    secret_tables CONSTANT text[] := ARRAY[
        'session', 'mfa_secrets', 'mfa_backup_codes', 'mfa_used_codes',
        'admin_mfa_enrol_codes', 'password_reset_tokens', 'password_history',
        'saml_request_cache'];
    secret_cols CONSTANT text[] := ARRAY[
        'password_hash', 'key_hash', 'token_hash', 'code_hash', 'secret_enc',
        'auth_config', 'webhook_secret', 'sess'];
    guarded CONSTANT jsonb := '{
        "admins": ["password_hash"],
        "employees": ["password_hash"],
        "onboarding_requests": ["password_hash"],
        "api_keys": ["key_hash"],
        "lms_integrations": ["auth_config", "webhook_secret"],
        "safety_gate_settings": ["webhook_secret"],
        "webhook_subscriptions": ["secret"],
        "app_settings": ["setting_value"],
        "hris_connectors": ["credentials"]
    }'::jsonb;
    tainted oid[] := ARRAY[]::oid[];
    added_oids oid[];
    r record;
    col_list text;
    n_tables int := 0;
    n_partial int := 0;
    n_views int := 0;
    summary text;
BEGIN
    -- 1. The role.
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = p_role) THEN
        BEGIN
            EXECUTE format('CREATE ROLE %I NOLOGIN', p_role);
        EXCEPTION WHEN insufficient_privilege THEN
            RAISE NOTICE 'console reader sync: cannot create role % (no CREATEROLE); the SQL console keeps its application-level guard only. A DBA may run: CREATE ROLE % NOLOGIN; then SELECT public.fn_console_reader_sync();', p_role, p_role;
            RETURN 'role missing';
        END;
    END IF;

    BEGIN
        EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', p_schema, p_role);
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'console reader sync: GRANT USAGE ON SCHEMA % refused; relying on the PUBLIC default.', p_schema;
    END;

    -- 2. Relations that must stay unreadable: the secret tables, then (to a fixed
    --    point) every view that reads one of them, a secret column, or an
    --    already withheld view. Column-level, like the application guard.
    SELECT coalesce(array_agg(c.oid), ARRAY[]::oid[]) INTO tainted
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = p_schema AND c.relname = ANY (secret_tables);

    LOOP
        added_oids := ARRAY(
            SELECT DISTINCT rw.ev_class
              FROM pg_rewrite rw
              JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass AND d.objid = rw.oid
                              AND d.refclassid = 'pg_class'::regclass
              JOIN pg_class rc ON rc.oid = d.refobjid
              LEFT JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
                                      AND d.refobjsubid > 0
             WHERE d.refobjid <> rw.ev_class
               AND NOT (rw.ev_class = ANY (tainted))
               AND (d.refobjid = ANY (tainted)
                    OR a.attname = ANY (secret_cols)
                    OR coalesce((guarded -> rc.relname::text) ? a.attname::text, false)));
        EXIT WHEN coalesce(array_length(added_oids, 1), 0) = 0;
        tainted := tainted || added_oids;
    END LOOP;

    -- 3. Grants, relation by relation (a failure on one never stops the rest).
    FOR r IN
        SELECT c.oid, c.relname, c.relkind
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = p_schema AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
         ORDER BY c.relname
    LOOP
        BEGIN
            EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM %I', p_schema, r.relname, p_role);
            IF r.oid = ANY (tainted) THEN
                CONTINUE;
            END IF;
            SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) INTO col_list
              FROM pg_attribute a
             WHERE a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped
               AND NOT (a.attname = ANY (secret_cols))
               AND NOT coalesce((guarded -> r.relname::text) ? a.attname::text, false);
            IF EXISTS (SELECT 1 FROM pg_attribute a
                        WHERE a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped
                          AND (a.attname = ANY (secret_cols)
                               OR coalesce((guarded -> r.relname::text) ? a.attname::text, false))) THEN
                IF col_list IS NOT NULL THEN
                    EXECUTE format('GRANT SELECT (%s) ON TABLE %I.%I TO %I', col_list, p_schema, r.relname, p_role);
                    n_partial := n_partial + 1;
                END IF;
            ELSE
                EXECUTE format('GRANT SELECT ON TABLE %I.%I TO %I', p_schema, r.relname, p_role);
                IF r.relkind IN ('v', 'm') THEN n_views := n_views + 1; ELSE n_tables := n_tables + 1; END IF;
            END IF;
        EXCEPTION WHEN insufficient_privilege THEN
            RAISE NOTICE 'console reader sync: no grant on % (not its owner); unreadable from the console role.', r.relname;
        END;
    END LOOP;

    -- 4. The application role may switch to it (SET LOCAL ROLE needs membership).
    BEGIN
        IF NOT pg_has_role(CURRENT_USER, p_role, 'MEMBER') THEN
            EXECUTE format('GRANT %I TO %I', p_role, CURRENT_USER);
        END IF;
    EXCEPTION WHEN insufficient_privilege OR invalid_grant_operation THEN
        RAISE NOTICE 'console reader sync: cannot grant % to %; the console will not use the role (a DBA may run: GRANT % TO %).', p_role, CURRENT_USER, p_role, CURRENT_USER;
    END;

    summary := format('%s ready: %s table(s) and %s view(s) readable, %s table(s) column-restricted, %s relation(s) withheld',
        p_role, n_tables, n_views, n_partial, coalesce(array_length(tainted, 1), 0));
    RAISE NOTICE 'console reader sync: %', summary;
    RETURN summary;
END
$console_reader_sync$;

COMMENT ON FUNCTION public.fn_console_reader_sync(text, text) IS
    'Re-grants the SQL console read-only role on every relation of the schema except secrets. Every migration that adds a table or a column ends with SELECT public.fn_console_reader_sync().';

REVOKE ALL ON FUNCTION public.fn_console_reader_sync(text, text) FROM PUBLIC;

SELECT public.fn_console_reader_sync();
