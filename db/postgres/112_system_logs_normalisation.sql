-- / , — one vocabulary for the audit log's facets.
--
-- Measured on a development database before this migration (6 561 rows):
--   actor_ref carried NINE shapes — `admin#N` (966), `manager#N` (534),
--   `employee#N` (362), `manager#N <username>` (261), `employee#N <username>`
--   (142), `admin:N` (42), `manager:N` (16), `employee:N` (4), `anonymous` (77).
--   Employee 84 had 348 rows as an actor across three of those shapes, and
--   `?actor=employee:84` found 1 of them.
--   severity mixed `warn` (476) with `warning` (2 — the maintenance panel), and
--   4 612 rows had NO severity, 4 603 NO category, so "Problèmes uniquement"
--   and the facet filters covered ~30 % of history.
--
-- WHAT IS REWRITTEN, AND WHY IT IS SAFE
--   system_logs is append-only (trg_system_logs_immutable blocks UPDATE) and
--   tamper-evident (trg_system_logs_hashchain). The hash covers admin_id,
--   action, entity_type, entity_id, details and created_at — NOT actor_ref,
--   severity or category. Those three are search facets, and rewriting them
--   leaves every row_hash verifiable. The immutability trigger is suspended
--   for this one transaction only (ALTER TABLE is transactional: a failure
--   rolls the trigger back with everything else), exactly as the guarded reset
--   and cleanup paths already do for their explicit, backup-first runs.
--
-- WHAT IS DELIBERATELY NOT REWRITTEN
--   entity_type IS part of the hash (`employees` vs `employee`, `selfAssessment`
--   vs `self_assessment`). Rewriting it would invalidate the chain, so the
--   legacy spellings stay in the rows; LogService writes the canonical form
--   from now on and SystemLogModel.ENTITY_SYNONYMS makes a filter on the
--   canonical name match the legacy spellings too (see the model).
--
-- Idempotent: every UPDATE is guarded by its own predicate; a second run
-- changes 0 rows.

ALTER TABLE system_logs DISABLE TRIGGER trg_system_logs_immutable;

-- 1) actor_ref → `<type>:<id>`. The username some writers appended after a
--    space is dropped: the id is the key, the name is one JOIN away and changes.
UPDATE system_logs
   SET actor_ref = regexp_replace(actor_ref, '^([a-z]+)#([0-9]+)( .*)?$', '\1:\2')
 WHERE actor_ref ~ '^[a-z]+#[0-9]+( .*)?$';

-- 2) one severity vocabulary: `warning` was written by one caller only.
UPDATE system_logs SET severity = 'warn' WHERE severity = 'warning';

-- 3) rows written before the observability facets existed: classify them from
--    what they DO carry (action prefix, HTTP status). Explicit values are never
--    overwritten — only NULLs are filled. The same rules live in
--    LogService.categoryFor / severityFor for every new row.
UPDATE system_logs
   SET category = CASE
        WHEN action LIKE 'HTTP\_%'                                        THEN 'http'
        WHEN action LIKE 'MAINT\_%'                                       THEN 'maintenance'
        WHEN action LIKE 'LOGIN%' OR action LIKE '%LOGOUT%'
          OR action IN ('ACCOUNT_LOCKED', 'IP_BLOCKED', 'ACCESS_DENIED')
          OR action LIKE '%RATE\_LIMITED' OR action LIKE 'MFA\_%'
          OR action LIKE 'PASSWORD\_%' OR action LIKE 'SESSION%'
          OR action LIKE 'API\_KEY%' OR action LIKE 'SSO\_%'
          OR action LIKE '%UNAUTH%' OR action LIKE '%TAMPER%'            THEN 'security'
        WHEN action LIKE 'SERVER\_ERROR%' OR action LIKE '%\_ERROR'      THEN 'system'
        ELSE 'audit' END
 WHERE category IS NULL;

UPDATE system_logs
   SET severity = CASE
        WHEN status_code >= 500 OR action LIKE 'SERVER\_ERROR%'           THEN 'error'
        WHEN status_code >= 400
          OR action IN ('LOGIN_FAILED', 'ACCOUNT_LOCKED', 'IP_BLOCKED', 'ACCESS_DENIED')
          OR action LIKE '%RATE\_LIMITED' OR action LIKE '%\_FAILED'
          OR action LIKE '%DENIED%' OR action LIKE 'MAINT\_%'
          OR action LIKE '%TAMPER%'                                       THEN 'warn'
        ELSE 'info' END
 WHERE severity IS NULL;

ALTER TABLE system_logs ENABLE TRIGGER trg_system_logs_immutable;

-- The two facet filters and the per-employee "Journal" tab read these.
CREATE INDEX IF NOT EXISTS idx_system_logs_actor_ref ON system_logs (actor_ref);
CREATE INDEX IF NOT EXISTS idx_system_logs_entity ON system_logs (entity_type, entity_id);

INSERT INTO schema_meta(key, value) VALUES ('112_system_logs_normalisation', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();
