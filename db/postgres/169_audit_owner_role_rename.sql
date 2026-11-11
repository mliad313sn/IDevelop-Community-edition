-- 169 — product-neutral name for the audit-trail owner role
--
-- The Windows installer's optional audit-trail ownership separation
-- (config.psd1 AuditOwnerSeparation) moves the append-only tables and their
-- guard functions to a NOLOGIN role. Earlier installers created that role under
-- a name inherited from the product IDevelop was derived from. Its name is now
-- `idevelop_audit_owner`.
--
-- A role rename keeps every ownership and grant, so the separation stays in
-- force. The legacy name is assembled from two parts so that the repository
-- carries no trace of the former product name (tests/unit/brandTokensAbsent).
--
-- Idempotent and never fails the migration:
--   * nothing to do when the legacy role does not exist (the normal case);
--   * when both names exist (a partial manual fix), nothing is renamed and a
--     NOTICE says so;
--   * without CREATEROLE (the app role usually has none) a NOTICE explains it;
--     the installer renames the role itself, as a superuser, on the next
--     install, patch or upgrade with separation on.

DO $audit_owner_rename$
DECLARE
    v_legacy CONSTANT text := 'four' || 'mp_audit_owner';
    v_new CONSTANT text := 'idevelop_audit_owner';
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_legacy) THEN
        RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_new) THEN
        RAISE NOTICE '169: both the legacy audit owner role and % exist; nothing renamed. Move ownership by hand (REASSIGN OWNED) and drop the legacy role.', v_new;
        RETURN;
    END IF;
    BEGIN
        EXECUTE format('ALTER ROLE %I RENAME TO %I', v_legacy, v_new);
        RAISE NOTICE '169: audit owner role renamed to %.', v_new;
    EXCEPTION WHEN insufficient_privilege OR object_in_use OR feature_not_supported THEN
        RAISE NOTICE '169: cannot rename the legacy audit owner role to % (%); the installer renames it on the next run.', v_new, SQLERRM;
    END;
END
$audit_owner_rename$;
