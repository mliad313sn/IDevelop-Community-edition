-- ============================================================================
-- 170 — Audit log: erasure redaction, monthly seals, sealed-purge retention and
--       one verifier. Additive and idempotent: every object is CREATE OR
--       REPLACE / IF NOT EXISTS; NO existing row is re-hashed or rewritten here.
--
-- The chain (migrations 30/52): row_hash = sha256(prev_hash | admin_id | action
-- | entity_type | entity_id | details | created_at). system_logs is append-only
-- (trg_system_logs_immutable → block_mutation, trg_system_logs_no_truncate).
--
-- 1. REDACTION (right to erasure). fn_system_logs_redact() replaces the erased
--    person's names / e-mails / login inside `details` by their ref
--    (`employee:<id>`), which the system-logs page prints as "Erased person
--    #<id>" in the reader's language. Before touching a row it APPENDS a chained
--    AUDIT_REDACTION entry listing, for every row it will change, {id, h0 = the
--    row's original row_hash, h1 = the hash of the redacted content}. The row
--    keeps its ORIGINAL row_hash (so the chain links are untouched); the
--    verifier accepts a row whose content no longer matches its row_hash ONLY
--    if a redaction entry — itself a chained, hash-protected row written AFTER
--    it — vouches for exactly that original hash and exactly the current
--    content. Any other edit is still detected.
--    block_mutation() lets an UPDATE of system_logs through only inside that
--    path: transaction-local setting idevelop.audit_path = 'redact', only
--    `details` changed, the vouching entry named by idevelop.audit_redaction_entry
--    lists {id, h0, h1} for this very row, and that entry is about an employee
--    who IS erased. Every other UPDATE still raises.
--
-- 2. SEALS. fn_system_logs_seal() appends one AUDIT_SEAL entry per complete
--    calendar month (UTC): first/last id, row count, sha256 of the month's
--    row_hashes in id order, and the previous seal's row_hash (seal chain).
--
-- 3. SEALED PURGE (retention, default 5 years, setting auditLogRetentionYears
--    1-10). fn_system_logs_purge() deletes rows older than the retention window
--    ONLY in whole sealed months, never an AUDIT_SEAL / AUDIT_REDACTION /
--    AUDIT_PURGE entry, never a row about a person under legal hold (employees
--    .legal_hold_at or an open pii_cleanup_jobs hold), and only after the chain
--    verifies. It first appends an AUDIT_PURGE entry recording the boundary id,
--    the rows kept below it ({id: row_hash}) and the links it cuts ({id:
--    prev_hash}) so the verifier can still prove what remains.
--    block_mutation() lets a DELETE through only with idevelop.audit_path =
--    'purge' and within the boundary / cutoff of the named AUDIT_PURGE entry.
--
-- 4. fn_system_logs_verify() — the one verifier (GET /v2/cap/audit/verify, the
--    « verify integrity » button of the system-logs page, and the purge
--    pre-check). It follows hash LINKS (not id order): content, links, forks,
--    genesis, purged region, seals.
--
-- 5. The chain trigger now draws the row id UNDER its advisory lock, so id
--    order == chain order. Before, two concurrent writers could take ids in one
--    order and the lock in the other, and the chain forked: the late writer's
--    row (lower id) became a second successor of the row written just before
--    it. Existing rows are untouched; the verifier reports those historic forks
--    as `benignForks` when every successor but one is a leaf whose id is lower
--    than its parent's (the race's signature — a burst of simultaneous sign-ins
--    can leave several such leaves under one parent) and flags any other fork.
--
-- Privileges: the redaction and purge functions are SECURITY DEFINER (with
-- the installer's audit-owner separation the application role holds SELECT +
-- INSERT only on system_logs). EXECUTE on them is revoked from PUBLIC — the SQL
-- console's read-only role must never reach a deleting function — and granted
-- to the role running this migration (the application role). When system_logs
-- is owned by another role (separation on), the functions are handed to that
-- owner when this role may do so; otherwise a NOTICE says the installer does it.
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- The row hash, one definition (identical to the chain trigger's formula).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_system_logs_rowhash(
    p_prev text, p_admin bigint, p_action text, p_etype text, p_eid bigint,
    p_details jsonb, p_created timestamptz)
RETURNS text LANGUAGE sql STABLE
-- No SET clause: it would stop the planner inlining this into the verifier's
-- scan. digest() resolves like the chain trigger's own call.
AS $fn$
    SELECT encode(digest(
        coalesce(p_prev, '') || '|' ||
        coalesce(p_admin::text, '') || '|' ||
        coalesce(p_action, '') || '|' ||
        coalesce(p_etype, '') || '|' ||
        coalesce(p_eid::text, '') || '|' ||
        coalesce(p_details::text, '') || '|' ||
        coalesce(p_created::text, now()::text), 'sha256'), 'hex')
$fn$;

-- ---------------------------------------------------------------------------
-- Chain trigger: id drawn under the lock (see 5.). Same hash formula.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_system_logs_hashchain()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE p text;
BEGIN
    -- Serialize concurrent appends so the predecessor read below is authoritative.
    PERFORM pg_advisory_xact_lock(hashtext('system_logs_hashchain')::bigint);
    -- The id is drawn HERE, under the lock, so a writer that took its default
    -- id before another writer's lock can no longer be chained after a row with
    -- a HIGHER id. Ids stay unique; a gap of one per row (the discarded
    -- default) is harmless.
    NEW.id := nextval(pg_get_serial_sequence('public.system_logs', 'id'));

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
END $fn$;

-- ---------------------------------------------------------------------------
-- The narrow exception, decided per row. Anything not matched here raises.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_system_logs_mutation_allowed(
    p_op text, p_old public.system_logs, p_new public.system_logs)
RETURNS boolean LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
AS $fn$
DECLARE
    mode text := coalesce(current_setting('idevelop.audit_path', true), '');
    entry_id bigint;
    h1 text;
    lim bigint;
    cutoff timestamptz;
BEGIN
    IF p_old.action IN ('AUDIT_REDACTION', 'AUDIT_SEAL', 'AUDIT_PURGE') THEN
        RETURN false;                       -- the proofs themselves never change
    END IF;
    IF p_op = 'UPDATE' AND mode = 'redact' THEN
        -- Only `details` may change; everything hashed or linking stays.
        IF p_new.id IS DISTINCT FROM p_old.id
           OR p_new.prev_hash IS DISTINCT FROM p_old.prev_hash
           OR p_new.row_hash IS DISTINCT FROM p_old.row_hash
           OR p_new.admin_id IS DISTINCT FROM p_old.admin_id
           OR p_new.action IS DISTINCT FROM p_old.action
           OR p_new.entity_type IS DISTINCT FROM p_old.entity_type
           OR p_new.entity_id IS DISTINCT FROM p_old.entity_id
           OR p_new.created_at IS DISTINCT FROM p_old.created_at
           OR p_new.actor_ref IS DISTINCT FROM p_old.actor_ref
           OR p_new.ip_address IS DISTINCT FROM p_old.ip_address
           OR p_new.user_agent IS DISTINCT FROM p_old.user_agent
           OR p_new.request_id IS DISTINCT FROM p_old.request_id THEN
            RETURN false;
        END IF;
        entry_id := nullif(current_setting('idevelop.audit_redaction_entry', true), '')::bigint;
        IF entry_id IS NULL OR entry_id <= p_old.id THEN
            RETURN false;
        END IF;
        h1 := CASE WHEN p_old.row_hash IS NULL THEN NULL
                   ELSE public.fn_system_logs_rowhash(p_new.prev_hash, p_new.admin_id, p_new.action,
                            p_new.entity_type, p_new.entity_id, p_new.details, p_new.created_at) END;
        -- The vouching entry lists this very row, and it is about a person who
        -- IS erased: a hand-written AUDIT_REDACTION row cannot open the path
        -- for anyone else.
        RETURN EXISTS (
            SELECT 1 FROM public.system_logs r
              JOIN public.employees e ON e.id = r.entity_id AND e.erased_at IS NOT NULL
             WHERE r.id = entry_id AND r.action = 'AUDIT_REDACTION' AND r.row_hash IS NOT NULL
               AND r.entity_type = 'employee'
               AND r.details->'rows' @> jsonb_build_array(
                     jsonb_build_object('id', p_old.id, 'h0', p_old.row_hash, 'h1', h1)));
    ELSIF p_op = 'DELETE' AND mode = 'purge' THEN
        entry_id := nullif(current_setting('idevelop.audit_purge_entry', true), '')::bigint;
        lim := nullif(current_setting('idevelop.audit_purge_boundary', true), '')::bigint;
        cutoff := nullif(current_setting('idevelop.audit_purge_cutoff', true), '')::timestamptz;
        IF entry_id IS NULL OR lim IS NULL OR cutoff IS NULL
           OR p_old.id > lim OR p_old.created_at >= cutoff OR entry_id <= p_old.id THEN
            RETURN false;
        END IF;
        -- The settings must be the ones the chained AUDIT_PURGE entry recorded.
        RETURN EXISTS (
            SELECT 1 FROM public.system_logs r
             WHERE r.id = entry_id AND r.action = 'AUDIT_PURGE' AND r.row_hash IS NOT NULL
               AND (r.details->>'boundaryId')::bigint = lim
               AND (r.details->>'cutoff')::timestamptz = cutoff);
    END IF;
    RETURN false;
END $fn$;

-- block_mutation() is shared by every append-only table (and several code
-- paths find those tables BY this function name). Same message, same errcode;
-- the only addition is the system_logs exception above.
CREATE OR REPLACE FUNCTION public.block_mutation()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    IF TG_TABLE_SCHEMA = 'public' AND TG_TABLE_NAME = 'system_logs'
       AND coalesce(current_setting('idevelop.audit_path', true), '') IN ('redact', 'purge') THEN
        IF TG_OP = 'UPDATE' AND public.fn_system_logs_mutation_allowed('UPDATE', OLD::public.system_logs, NEW::public.system_logs) THEN
            RETURN NEW;
        ELSIF TG_OP = 'DELETE' AND public.fn_system_logs_mutation_allowed('DELETE', OLD::public.system_logs, NULL) THEN
            RETURN OLD;
        END IF;
    END IF;
    RAISE EXCEPTION 'IMMUTABLE_TABLE: % is append-only', TG_TABLE_NAME
        USING ERRCODE = 'check_violation';
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 1. Redaction on erasure.
--    p_needles: identifiers read by the caller BEFORE the erasure pseudonymised
--    the person (names, e-mail, login). The subject must be erased (erased_at
--    set) — this is never a general-purpose rewrite. Needles shorter than 3
--    characters or without a letter are ignored (a bare number would corrupt
--    ids and dates), as are the erasure's own pseudonyms ("Erased …", "erased-…").
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_system_logs_redact(
    p_employee_id bigint, p_needles text[], p_actor text DEFAULT NULL, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
    label text := 'employee:' || p_employee_id;
    alts text;
    rx text;
    r record;
    newd jsonb;
    pend jsonb := '[]'::jsonb;
    vouch jsonb := '[]'::jsonb;
    n int := 0;
    total int := 0;
    entries bigint[] := '{}';
    entry_id bigint;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.employees WHERE id = p_employee_id AND erased_at IS NOT NULL) THEN
        RAISE EXCEPTION 'AUDIT_REDACTION_REFUSED: employee % is not erased', p_employee_id
            USING ERRCODE = 'check_violation';
    END IF;
    -- JSON-escaped, regex-escaped, longest first (a full name before its parts).
    SELECT string_agg(
               regexp_replace(substr(j, 2, length(j) - 2), '([.^$*+?(){}|\\/\[\]-])', '\\\1', 'g'),
               '|' ORDER BY length(j) DESC)
      INTO alts
      FROM (SELECT DISTINCT to_jsonb(btrim(x))::text AS j
              FROM unnest(coalesce(p_needles, '{}')) AS x
             WHERE length(btrim(x)) >= 3 AND btrim(x) ~ '[[:alpha:]]'
               AND btrim(x) !~* '^erased') s;
    IF alts IS NULL THEN
        RETURN jsonb_build_object('rows', 0, 'entries', '[]'::jsonb);
    END IF;
    rx := '(?<![[:alnum:]_])(' || alts || ')(?![[:alnum:]_])';

    FOR r IN
        SELECT s.id, s.prev_hash, s.row_hash, s.admin_id, s.action, s.entity_type, s.entity_id,
               s.details, s.created_at
          FROM public.system_logs s
         WHERE s.details IS NOT NULL
           AND s.action NOT IN ('AUDIT_REDACTION', 'AUDIT_SEAL', 'AUDIT_PURGE')
           AND s.details::text ~* rx
         ORDER BY s.id
    LOOP
        newd := regexp_replace(r.details::text, rx, label, 'gi')::jsonb;
        pend := pend || jsonb_build_array(jsonb_build_object('id', r.id, 'd', newd));
        vouch := vouch || jsonb_build_array(jsonb_build_object(
            'id', r.id, 'h0', r.row_hash,
            'h1', CASE WHEN r.row_hash IS NULL THEN NULL ELSE public.fn_system_logs_rowhash(
                     r.prev_hash, r.admin_id, r.action, r.entity_type, r.entity_id, newd, r.created_at) END));
        n := n + 1;
        IF n >= 500 THEN
            entry_id := public._fn_system_logs_redact_flush(p_employee_id, p_actor, p_reason, pend, vouch);
            entries := entries || entry_id; total := total + n;
            pend := '[]'::jsonb; vouch := '[]'::jsonb; n := 0;
        END IF;
    END LOOP;
    IF n > 0 THEN
        entry_id := public._fn_system_logs_redact_flush(p_employee_id, p_actor, p_reason, pend, vouch);
        entries := entries || entry_id; total := total + n;
    END IF;
    RETURN jsonb_build_object('rows', total, 'entries', to_jsonb(entries));
END $fn$;

-- One batch: append the vouching entry (chained), then change exactly the
-- rows it lists, then close the path again.
CREATE OR REPLACE FUNCTION public._fn_system_logs_redact_flush(
    p_employee_id bigint, p_actor text, p_reason text, p_pend jsonb, p_vouch jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE entry_id bigint; changed int;
BEGIN
    INSERT INTO public.system_logs (action, entity_type, entity_id, details, severity, category, actor_ref)
    VALUES ('AUDIT_REDACTION', 'employee', p_employee_id,
            jsonb_build_object('subject', 'employee:' || p_employee_id,
                               'reason', coalesce(p_reason, 'erasure'),
                               'label', 'employee:' || p_employee_id,
                               'count', jsonb_array_length(p_vouch),
                               'rows', p_vouch),
            'warn', 'audit', p_actor)
    RETURNING id INTO entry_id;
    PERFORM set_config('idevelop.audit_path', 'redact', true);
    PERFORM set_config('idevelop.audit_redaction_entry', entry_id::text, true);
    UPDATE public.system_logs s SET details = (x->'d')
      FROM jsonb_array_elements(p_pend) x
     WHERE s.id = (x->>'id')::bigint;
    GET DIAGNOSTICS changed = ROW_COUNT;
    PERFORM set_config('idevelop.audit_path', '', true);
    PERFORM set_config('idevelop.audit_redaction_entry', '', true);
    IF changed <> jsonb_array_length(p_pend) THEN
        RAISE EXCEPTION 'AUDIT_REDACTION_INCOMPLETE: % of % row(s)', changed, jsonb_array_length(p_pend);
    END IF;
    RETURN entry_id;
END $fn$;

-- ---------------------------------------------------------------------------
-- 4. The verifier. Returns a JSON report; `intact` is the verdict.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_system_logs_verify(p_limit int DEFAULT 20)
RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
AS $fn$
DECLARE
    lp record;
    kept jsonb := '{}'::jsonb;
    cut jsonb := '{}'::jsonb;
    boundary bigint := 0;
    b_content bigint[]; b_link bigint[]; b_fork bigint[]; b_genesis bigint[];
    b_purged bigint[]; b_seal bigint[];
    n_redacted int; n_hashed bigint; n_unhashed bigint; n_benign int; n_seals int;
    last_seal jsonb;
BEGIN
    SELECT id, details INTO lp FROM system_logs
     WHERE action = 'AUDIT_PURGE' AND row_hash IS NOT NULL ORDER BY id DESC LIMIT 1;
    IF FOUND THEN
        kept := coalesce(lp.details->'kept', '{}'::jsonb);
        cut := coalesce(lp.details->'cut', '{}'::jsonb);
        boundary := coalesce((lp.details->>'boundaryId')::bigint, 0);
    END IF;

    SELECT count(*) FILTER (WHERE row_hash IS NOT NULL), count(*) FILTER (WHERE row_hash IS NULL)
      INTO n_hashed, n_unhashed FROM system_logs;

    -- (a) content: recomputed == row_hash, or vouched by a LATER redaction entry.
    WITH v AS (
        SELECT (e->>'id')::bigint AS id, e->>'h0' AS h0, e->>'h1' AS h1, r.id AS rid
          FROM system_logs r CROSS JOIN LATERAL jsonb_array_elements(
                   CASE WHEN jsonb_typeof(r.details->'rows') = 'array' THEN r.details->'rows' ELSE '[]'::jsonb END) e
         WHERE r.action = 'AUDIT_REDACTION' AND r.row_hash IS NOT NULL
    ), c AS (
        SELECT s.id, s.row_hash,
               fn_system_logs_rowhash(s.prev_hash, s.admin_id, s.action, s.entity_type,
                                      s.entity_id, s.details, s.created_at) AS h
          FROM system_logs s WHERE s.row_hash IS NOT NULL
    )
    SELECT (array_agg(c.id ORDER BY c.id) FILTER (WHERE c.h <> c.row_hash AND NOT EXISTS (
                SELECT 1 FROM v WHERE v.id = c.id AND v.h0 = c.row_hash AND v.h1 = c.h AND v.rid > c.id))),
           count(*) FILTER (WHERE c.h <> c.row_hash AND EXISTS (
                SELECT 1 FROM v WHERE v.id = c.id AND v.h0 = c.row_hash AND v.h1 = c.h AND v.rid > c.id))
      INTO b_content, n_redacted FROM c;

    -- (b) links: every prev_hash names an existing row (or a link a purge cut).
    SELECT array_agg(c.id ORDER BY c.id) INTO b_link
      FROM system_logs c
     WHERE c.row_hash IS NOT NULL AND c.prev_hash IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM system_logs p WHERE p.row_hash = c.prev_hash)
       AND (cut->>(c.id::text)) IS DISTINCT FROM c.prev_hash;

    -- (c) forks: one predecessor, several successors. Benign only when EVERY
    --     successor but one is a leaf whose id is LOWER than its parent's (the
    --     historic id/lock race, which a burst of simultaneous sign-ins can
    --     repeat more than once on the same parent); anything else is flagged.
    WITH ch AS (
        SELECT c.id, c.row_hash, p.id AS pid,
               EXISTS (SELECT 1 FROM system_logs k WHERE k.prev_hash = c.row_hash) AS has_child
          FROM system_logs c JOIN system_logs p ON p.row_hash = c.prev_hash
         WHERE c.prev_hash IN (SELECT prev_hash FROM system_logs WHERE prev_hash IS NOT NULL
                                GROUP BY prev_hash HAVING count(*) > 1)
    ), grp AS (
        SELECT pid, array_agg(id ORDER BY id) AS ids,
               count(*) AS n,
               count(*) FILTER (WHERE NOT has_child AND id < pid) AS benign_leaves
          FROM ch GROUP BY pid
    )
    SELECT count(*) FILTER (WHERE benign_leaves >= n - 1),
           (SELECT array_agg(x ORDER BY x) FROM grp g2, unnest(g2.ids) x
             WHERE NOT (g2.benign_leaves >= g2.n - 1))
      INTO n_benign, b_fork FROM grp;

    -- (d) genesis: at most one chained row without a predecessor.
    SELECT (array_agg(id ORDER BY id))[2:] INTO b_genesis
      FROM system_logs WHERE row_hash IS NOT NULL AND prev_hash IS NULL;

    -- (e) purged region: below the last purge boundary only the rows that purge
    --     recorded as kept may exist, with the hash it recorded.
    IF boundary > 0 THEN
        SELECT array_agg(id ORDER BY id) INTO b_purged
          FROM system_logs
         WHERE row_hash IS NOT NULL AND id <= boundary
           AND (kept->>(id::text)) IS DISTINCT FROM row_hash;
    END IF;

    -- (f) seals: digest re-computed while the month is still present; the seal
    --     chain (each seal names the previous seal's row_hash) always.
    WITH s AS (
        SELECT id, row_hash, details,
               LAG(row_hash) OVER (ORDER BY id) AS prev_seal_hash
          FROM system_logs WHERE action = 'AUDIT_SEAL' AND row_hash IS NOT NULL
    )
    SELECT array_agg(s.id ORDER BY s.id) INTO b_seal FROM s
     WHERE (s.details->>'prevSealHash') IS DISTINCT FROM s.prev_seal_hash
        OR ((s.details->>'lastId')::bigint > boundary AND (
              SELECT coalesce(encode(digest(string_agg(x.row_hash, '' ORDER BY x.id), 'sha256'), 'hex'), '')
                FROM system_logs x
               WHERE x.row_hash IS NOT NULL
                 AND x.created_at >= (s.details->>'from')::timestamptz
                 AND x.created_at < (s.details->>'to')::timestamptz
                 AND x.id <= (s.details->>'lastId')::bigint
             ) IS DISTINCT FROM coalesce(s.details->>'digest', ''));

    SELECT count(*) INTO n_seals FROM system_logs WHERE action = 'AUDIT_SEAL' AND row_hash IS NOT NULL;
    SELECT jsonb_build_object('id', id, 'period', details->>'period') INTO last_seal
      FROM system_logs WHERE action = 'AUDIT_SEAL' AND row_hash IS NOT NULL ORDER BY id DESC LIMIT 1;

    RETURN jsonb_build_object(
        'intact', coalesce(cardinality(b_content), 0) + coalesce(cardinality(b_link), 0)
                  + coalesce(cardinality(b_fork), 0) + coalesce(cardinality(b_genesis), 0)
                  + coalesce(cardinality(b_purged), 0) + coalesce(cardinality(b_seal), 0) = 0,
        'hashedRows', n_hashed,
        'unhashedRows', n_unhashed,
        'redactedRows', coalesce(n_redacted, 0),
        'benignForks', coalesce(n_benign, 0),
        'seals', n_seals,
        'lastSeal', last_seal,
        'lastPurgeId', lp.id,
        'purgeBoundaryId', nullif(boundary, 0),
        'broken', jsonb_build_object(
            'content', to_jsonb(coalesce(b_content[1:p_limit], '{}')),
            'link', to_jsonb(coalesce(b_link[1:p_limit], '{}')),
            'fork', to_jsonb(coalesce(b_fork[1:p_limit], '{}')),
            'genesis', to_jsonb(coalesce(b_genesis[1:p_limit], '{}')),
            'purged', to_jsonb(coalesce(b_purged[1:p_limit], '{}')),
            'seal', to_jsonb(coalesce(b_seal[1:p_limit], '{}'))));
END $fn$;

-- ---------------------------------------------------------------------------
-- 2. Monthly seals (UTC months). Seals every complete month that holds rows
--    and has no seal yet, oldest first. Returns the number of seals written.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_system_logs_seal(p_now timestamptz DEFAULT now())
RETURNS int LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
    this_month timestamptz := date_trunc('month', p_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
    m_from timestamptz;
    m_to timestamptz;
    last_to timestamptz;
    prev_hash text;
    agg record;
    written int := 0;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('system_logs_seal')::bigint);
    SELECT (details->>'to')::timestamptz INTO last_to
      FROM system_logs WHERE action = 'AUDIT_SEAL' AND row_hash IS NOT NULL ORDER BY id DESC LIMIT 1;
    LOOP
        -- Every month that holds rows, the pre-chain (unhashed) ones included:
        -- the purge works on sealed months only, so they need a seal too.
        SELECT min(created_at) INTO m_from FROM system_logs
         WHERE action <> 'AUDIT_SEAL'
           AND (last_to IS NULL OR created_at >= last_to) AND created_at < this_month;
        EXIT WHEN m_from IS NULL;
        m_from := date_trunc('month', m_from AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
        m_to := (date_trunc('month', m_from AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC';
        SELECT count(*) FILTER (WHERE row_hash IS NOT NULL) AS n,
               count(*) FILTER (WHERE row_hash IS NULL) AS unhashed,
               min(id) AS first_id, max(id) AS last_id,
               encode(digest(string_agg(row_hash, '' ORDER BY id), 'sha256'), 'hex') AS digest
          INTO agg
          FROM system_logs
         WHERE created_at >= m_from AND created_at < m_to;
        SELECT row_hash INTO prev_hash FROM system_logs
         WHERE action = 'AUDIT_SEAL' AND row_hash IS NOT NULL ORDER BY id DESC LIMIT 1;
        INSERT INTO system_logs (action, entity_type, details, severity, category, actor_ref)
        VALUES ('AUDIT_SEAL', 'audit_seal',
                jsonb_build_object('period', to_char(m_from AT TIME ZONE 'UTC', 'YYYY-MM'),
                                   'from', m_from, 'to', m_to,
                                   'count', agg.n, 'unhashed', agg.unhashed, 'firstId', agg.first_id, 'lastId', agg.last_id,
                                   'digest', agg.digest, 'prevSealHash', prev_hash),
                'info', 'audit', 'system:audit-seal');
        written := written + 1;
        last_to := m_to;
    END LOOP;
    RETURN written;
END $fn$;

-- ---------------------------------------------------------------------------
-- 3. Sealed purge. p_years is clamped by the caller to 1..10 and re-checked
--    here. Refused (exception) when the chain does not verify first.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_system_logs_purge(
    p_years int, p_actor text DEFAULT NULL, p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
    cutoff timestamptz;
    upto timestamptz;
    unsealed timestamptz;
    held_ids bigint[];
    held_refs text[];
    held_admins bigint[];
    v jsonb;
    boundary bigint;
    to_delete bigint;
    kept jsonb;
    cut jsonb;
    entry_id bigint;
    deleted int;
    max_last bigint;
BEGIN
    IF p_years IS NULL OR p_years < 1 OR p_years > 10 THEN
        RAISE EXCEPTION 'AUDIT_PURGE_REFUSED: retention % year(s) outside 1..10', p_years
            USING ERRCODE = 'check_violation';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtext('system_logs_seal')::bigint);
    cutoff := (date_trunc('month', p_now AT TIME ZONE 'UTC') - make_interval(years => p_years)) AT TIME ZONE 'UTC';
    -- Whole sealed months only: stop at the end of the last seal, and before
    -- the first month that holds rows but no seal.
    SELECT (details->>'to')::timestamptz INTO upto
      FROM system_logs WHERE action = 'AUDIT_SEAL' AND row_hash IS NOT NULL ORDER BY id DESC LIMIT 1;
    IF upto IS NULL THEN
        RETURN jsonb_build_object('deleted', 0, 'skipped', 'no_seal');
    END IF;
    upto := least(upto, cutoff);
    SELECT min(date_trunc('month', s.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') INTO unsealed
      FROM system_logs s
     WHERE s.created_at < upto AND s.action NOT IN ('AUDIT_REDACTION', 'AUDIT_SEAL', 'AUDIT_PURGE')
       AND NOT EXISTS (SELECT 1 FROM system_logs z
                        WHERE z.action = 'AUDIT_SEAL' AND z.row_hash IS NOT NULL
                          AND s.created_at >= (z.details->>'from')::timestamptz
                          AND s.created_at < (z.details->>'to')::timestamptz);
    IF unsealed IS NOT NULL THEN upto := least(upto, unsealed); END IF;
    SELECT max((details->>'lastId')::bigint) INTO max_last
      FROM system_logs WHERE action = 'AUDIT_SEAL' AND row_hash IS NOT NULL
       AND (details->>'to')::timestamptz <= upto;
    IF max_last IS NULL THEN
        RETURN jsonb_build_object('deleted', 0, 'skipped', 'nothing_expired', 'cutoff', cutoff);
    END IF;

    -- Legal holds: the employee flag or an open retention-job hold; the
    -- person's linked admin accounts are held with them.
    SELECT coalesce(array_agg(DISTINCT x), '{}') INTO held_ids FROM (
        SELECT id AS x FROM employees WHERE legal_hold_at IS NOT NULL
        UNION SELECT employee_id FROM pii_cleanup_jobs
               WHERE legal_hold_at IS NOT NULL AND completed_at IS NULL AND employee_id IS NOT NULL) h;
    SELECT coalesce(array_agg(id), '{}') INTO held_admins FROM admins WHERE linked_employee_id = ANY(held_ids);
    SELECT coalesce(array_agg(r), '{}') INTO held_refs FROM (
        SELECT t || ':' || i AS r FROM unnest(held_ids) i, unnest(ARRAY['employee', 'manager', 'supervisor']) t
        UNION ALL SELECT 'admin:' || a FROM unnest(held_admins) a) q;

    CREATE TEMP TABLE IF NOT EXISTS _audit_purge_ids (id bigint PRIMARY KEY) ON COMMIT DROP;
    TRUNCATE _audit_purge_ids;
    INSERT INTO _audit_purge_ids (id)
    SELECT s.id FROM system_logs s
     WHERE s.created_at < upto AND s.id <= max_last
       AND s.action NOT IN ('AUDIT_REDACTION', 'AUDIT_SEAL', 'AUDIT_PURGE')
       -- `IS NOT TRUE`: a NULL column (no actor, no entity) is not a hold.
       AND (s.actor_ref = ANY(held_refs)) IS NOT TRUE
       AND (s.admin_id = ANY(held_admins)) IS NOT TRUE
       AND (s.entity_type IN ('employee', 'employees') AND s.entity_id = ANY(held_ids)) IS NOT TRUE
       AND (s.entity_type IN ('admin', 'admins', 'localAdmins') AND s.entity_id = ANY(held_admins)) IS NOT TRUE
       AND ((s.details->>'subject') = ANY(held_refs)) IS NOT TRUE
       AND ((s.details->>'employeeId') = ANY(held_ids::text[])) IS NOT TRUE;
    SELECT count(*) INTO to_delete FROM _audit_purge_ids;
    IF to_delete = 0 THEN
        RETURN jsonb_build_object('deleted', 0, 'skipped', 'nothing_expired', 'cutoff', cutoff,
                                  'heldEmployees', cardinality(held_ids));
    END IF;
    -- The chain must verify before anything goes (a purge must never launder
    -- an earlier tampering into an "attested" cut).
    v := fn_system_logs_verify(5);
    IF NOT (v->>'intact')::boolean THEN
        RAISE EXCEPTION 'AUDIT_PURGE_REFUSED: the audit chain does not verify (%)', v->'broken'
            USING ERRCODE = 'check_violation';
    END IF;
    -- The boundary is the last SEALED id, not the last deleted one: a held row
    -- at the end of a purged month must not make that month look "present"
    -- to the verifier's seal re-computation.
    boundary := greatest(max_last, coalesce((SELECT (details->>'boundaryId')::bigint FROM system_logs
                                                WHERE action = 'AUDIT_PURGE' AND row_hash IS NOT NULL
                                                ORDER BY id DESC LIMIT 1), 0));
    -- What remains at or below the boundary, and the links the purge cuts
    -- (cumulative: earlier purges' kept rows and cuts are recomputed too).
    SELECT coalesce(jsonb_object_agg(s.id::text, s.row_hash), '{}'::jsonb) INTO kept
      FROM system_logs s
     WHERE s.row_hash IS NOT NULL AND s.id <= boundary
       AND NOT EXISTS (SELECT 1 FROM _audit_purge_ids d WHERE d.id = s.id);
    SELECT coalesce(jsonb_object_agg(c.id::text, c.prev_hash), '{}'::jsonb) INTO cut
      FROM system_logs c
     WHERE c.row_hash IS NOT NULL AND c.prev_hash IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM _audit_purge_ids d WHERE d.id = c.id)
       AND NOT EXISTS (SELECT 1 FROM system_logs p
                        WHERE p.row_hash = c.prev_hash
                          AND NOT EXISTS (SELECT 1 FROM _audit_purge_ids d2 WHERE d2.id = p.id));

    INSERT INTO system_logs (action, entity_type, details, severity, category, actor_ref)
    VALUES ('AUDIT_PURGE', 'audit_purge',
            jsonb_build_object('retentionYears', p_years, 'cutoff', upto,
                               'boundaryId', boundary, 'deleted', to_delete,
                               'heldEmployees', to_jsonb(held_ids),
                               'kept', kept, 'cut', cut),
            'warn', 'audit', coalesce(p_actor, 'system:audit-retention'))
    RETURNING id INTO entry_id;

    PERFORM set_config('idevelop.audit_path', 'purge', true);
    PERFORM set_config('idevelop.audit_purge_entry', entry_id::text, true);
    PERFORM set_config('idevelop.audit_purge_boundary', boundary::text, true);
    PERFORM set_config('idevelop.audit_purge_cutoff', upto::text, true);
    DELETE FROM system_logs s USING _audit_purge_ids d WHERE s.id = d.id;
    GET DIAGNOSTICS deleted = ROW_COUNT;
    PERFORM set_config('idevelop.audit_path', '', true);
    PERFORM set_config('idevelop.audit_purge_entry', '', true);
    PERFORM set_config('idevelop.audit_purge_boundary', '', true);
    PERFORM set_config('idevelop.audit_purge_cutoff', '', true);
    IF deleted <> to_delete THEN
        RAISE EXCEPTION 'AUDIT_PURGE_INCOMPLETE: % of % row(s)', deleted, to_delete;
    END IF;
    RETURN jsonb_build_object('deleted', deleted, 'entryId', entry_id, 'boundaryId', boundary,
                              'cutoff', upto, 'kept', (SELECT count(*) FROM jsonb_object_keys(kept)),
                              'heldEmployees', cardinality(held_ids));
END $fn$;

-- The proofs are read by the verifier and the seal / purge jobs.
CREATE INDEX IF NOT EXISTS idx_system_logs_audit_meta ON public.system_logs (action, id)
    WHERE action IN ('AUDIT_REDACTION', 'AUDIT_SEAL', 'AUDIT_PURGE');
-- Link checks (prev_hash → row_hash) and the fork scan.
CREATE INDEX IF NOT EXISTS idx_system_logs_row_hash ON public.system_logs (row_hash);
CREATE INDEX IF NOT EXISTS idx_system_logs_prev_hash ON public.system_logs (prev_hash);

-- Who may call the writing functions (see "Privileges" above).
DO $audit_privs$
DECLARE
    v_owner text;
    v_fn text;
    v_fns CONSTANT text[] := ARRAY[
        'public.fn_system_logs_redact(bigint, text[], text, text)',
        'public._fn_system_logs_redact_flush(bigint, text, text, jsonb, jsonb)',
        'public.fn_system_logs_purge(integer, text, timestamptz)'];
BEGIN
    SELECT pg_get_userbyid(c.relowner) INTO v_owner
      FROM pg_class c WHERE c.oid = 'public.system_logs'::regclass;
    FOREACH v_fn IN ARRAY v_fns LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', v_fn, current_user);
        IF v_owner IS NOT NULL AND v_owner <> current_user THEN
            BEGIN
                EXECUTE format('ALTER FUNCTION %s OWNER TO %I', v_fn, v_owner);
            EXCEPTION WHEN insufficient_privilege THEN
                RAISE NOTICE '170: % stays owned by %; the installer hands it to % (audit-owner separation).',
                    v_fn, current_user, v_owner;
            END;
        END IF;
    END LOOP;
END
$audit_privs$;

-- Retention setting (security class through ^auditLog in utils/securitySettings → SuperAdmin only).
INSERT INTO public.app_settings (setting_key, setting_value, setting_type, description, category)
SELECT 'auditLogRetentionYears', '5', 'number',
       'Years the audit log is kept (1-10, default 5). Older rows are deleted by whole sealed months only; seals, redaction and purge entries and rows about a person under legal hold are always kept.',
       'jobs'
 WHERE NOT EXISTS (SELECT 1 FROM public.app_settings WHERE setting_key = 'auditLogRetentionYears');
