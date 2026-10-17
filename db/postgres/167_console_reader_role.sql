-- 167 — SQL console read-only role (second layer of the console secret guard)
--
-- The SQL console refuses, in the application, every statement that reads or
-- writes a secret (SqlConsoleService._secretAccessViolation). This migration
-- adds the DATABASE-side layer: a NOLOGIN role `sqlconsole_reader` that the
-- console switches to (SET LOCAL ROLE) for pure-read scripts. The role can
-- SELECT every relation of the public schema EXCEPT the secrets:
--
--   * no privilege at all on the secret tables (SqlConsoleService.SECRET_TABLES);
--   * on a table that carries a secret column, a COLUMN-level SELECT on every
--     other column (SECRET_COLUMNS by name, anywhere, plus GUARDED_TABLES'
--     table-specific ones: app_settings.setting_value, webhook_subscriptions.secret,
--     hris_connectors.credentials);
--   * no privilege on a view / materialised view that reads a secret table, a
--     secret column, or another such view (views run with their owner's rights,
--     so they would be a way round). Column-level, like the application guard.
--
-- Keep the three lists below in step with SqlConsoleService (SECRET_TABLES,
-- SECRET_COLUMNS, GUARDED_TABLES).
--
-- Consequence for the console: a pure read of a secret-bearing table must name
-- its columns (`SELECT *` on employees/admins/… is refused by PostgreSQL once
-- the role exists, and the console says so). A relation created by a LATER
-- migration is not readable through the role until it is granted (fail
-- closed): this file keeps the highest number on purpose, and a later migration
-- that adds tables must repeat the DO block below (see CONTRIBUTING.md).
--
-- Idempotent. Never fails the migration: a database owner without CREATEROLE
-- (or a table it does not own) gets a NOTICE and the console keeps working
-- without the role (SqlConsoleService uses the role only when the current user
-- is a member of it and it has grants in THIS database).

DO $console_reader$
DECLARE
    v_role CONSTANT text := 'sqlconsole_reader';
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
BEGIN
    -- 1. The role.
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
        BEGIN
            EXECUTE format('CREATE ROLE %I NOLOGIN', v_role);
        EXCEPTION WHEN insufficient_privilege THEN
            RAISE NOTICE '167: cannot create role % (no CREATEROLE) — the SQL console keeps its application-level guard only. A DBA may create it: CREATE ROLE % NOLOGIN; then re-run this file.', v_role, v_role;
            RETURN;
        END;
    END IF;

    BEGIN
        EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', v_role);
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE '167: GRANT USAGE ON SCHEMA public refused — relying on the PUBLIC default.';
    END;

    -- 2. Relations that must stay unreadable: the secret tables, then (to a fixed
    --    point) every view that reads one of them, a secret column, or an
    --    already withheld view.
    SELECT coalesce(array_agg(c.oid), ARRAY[]::oid[]) INTO tainted
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = ANY (secret_tables);

    -- (Column-level, like the application guard: pg_depend cannot tell a
    -- whole-row reference from the plain "uses this table" dependency, so a
    -- view is withheld when it reads a secret COLUMN or a withheld relation.)
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
         WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
         ORDER BY c.relname
    LOOP
        BEGIN
            -- Start clean (idempotent re-run; also drops any older table-level grant).
            EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', r.relname, v_role);
            IF r.oid = ANY (tainted) THEN
                CONTINUE; -- secret table or a view over secrets: nothing
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
                    EXECUTE format('GRANT SELECT (%s) ON TABLE public.%I TO %I', col_list, r.relname, v_role);
                    n_partial := n_partial + 1;
                END IF;
            ELSE
                EXECUTE format('GRANT SELECT ON TABLE public.%I TO %I', r.relname, v_role);
                IF r.relkind IN ('v', 'm') THEN n_views := n_views + 1; ELSE n_tables := n_tables + 1; END IF;
            END IF;
        EXCEPTION WHEN insufficient_privilege THEN
            RAISE NOTICE '167: no grant on % (not its owner) — unreadable from the console role.', r.relname;
        END;
    END LOOP;

    -- 4. The application role may switch to it (SET LOCAL ROLE needs membership).
    BEGIN
        IF NOT pg_has_role(CURRENT_USER, v_role, 'MEMBER') THEN
            EXECUTE format('GRANT %I TO %I', v_role, CURRENT_USER);
        END IF;
    EXCEPTION WHEN insufficient_privilege OR invalid_grant_operation THEN
        RAISE NOTICE '167: cannot grant % to % — the console will not use the role (a DBA may run: GRANT % TO %).', v_role, CURRENT_USER, v_role, CURRENT_USER;
    END;

    RAISE NOTICE '167: % ready — % table(s) and % view(s) readable, % table(s) column-restricted, % relation(s) withheld.',
        v_role, n_tables, n_views, n_partial, coalesce(array_length(tainted, 1), 0);
END
$console_reader$;
