-- 153 — SuperAdmin never through SSO + SSO migration invitations
--       (release 3.23.20, Amendment C: C1e, C3a, C3b)
--
--   C1e  DEFENCE IN DEPTH for « a SuperAdmin never signs in through SSO » (the
--        application check, AdminSsoService.assertNotSuperadmin, is the
--        guarantee):
--          * user_identities: an INSERT, or an UPDATE of its owner / link
--            method, naming a SuperAdmin admin is REFUSED (check_violation).
--            Rows recorded before this release are left in place — ignored at
--            sign-in, listed in red by the readiness report, never deleted.
--          * admins: a SuperAdmin carries no linked person (linked_employee_id
--            is forced to NULL on insert/update), and a demotion FROM
--            SuperAdmin is stamped (demoted_from_superadmin_at) so the
--            readiness report can flag a demoted admin that regains an SSO path.
--
--   C3a  sso_migration_invites — the OUTBOX and ledger of the « SSO migration »
--        invitation: one row per (account, provider), created by the triggers
--        below, sent by the jobs/sso-invites dispatcher only while SSO is live.
--
--   C3b  Rows are created by TRIGGERS, atomic with the link itself (a rolled
--        back link leaves no row; a crash loses nothing):
--          * user_identities INSERT / UPDATE OF subject_type, subject_id,
--            link_method — link methods superadmin_link, onboarding_merge,
--            delegated_link (standard) and sso_email (security_notice); an
--            identity on an employee also queues the ACTIVE non-superadmin
--            admin accounts whose linked person that employee is. Not queued:
--            migration_mapping (queued at mapping time), legacy, unknown.
--          * sso_pending_links INSERT with status 'pending' (a mapping created
--            from the SSO-migration console, one row per migrated employee).
--        INSERT … ON CONFLICT DO NOTHING — a re-link / alias of the same account
--        and provider never queues twice; a NEW provider may. No backfill.
--        Superadmins and inactive accounts are skipped at DISPATCH time.
--
-- Additive and idempotent. Nothing is deleted.

-- ---------------------------------------------------------------------------
-- C1e — SuperAdmin guards
-- ---------------------------------------------------------------------------
ALTER TABLE admins ADD COLUMN IF NOT EXISTS demoted_from_superadmin_at timestamptz;

CREATE OR REPLACE FUNCTION public.fn_admins_superadmin_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.role = 'superadmin' THEN
        NEW.linked_employee_id := NULL;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.role = 'superadmin' AND NEW.role IS DISTINCT FROM 'superadmin' THEN
        NEW.demoted_from_superadmin_at := now();
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_admins_superadmin_guard ON public.admins;
CREATE TRIGGER trg_admins_superadmin_guard
    BEFORE INSERT OR UPDATE ON public.admins
    FOR EACH ROW EXECUTE FUNCTION public.fn_admins_superadmin_guard();

CREATE OR REPLACE FUNCTION public.fn_user_identities_no_superadmin()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.subject_type = 'admin' AND EXISTS (
        SELECT 1 FROM admins a WHERE a.id = NEW.subject_id AND a.role = 'superadmin'
    ) THEN
        RAISE EXCEPTION 'superadmin_sso_forbidden: a SuperAdmin account never carries an SSO identity'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_user_identities_no_superadmin ON public.user_identities;
CREATE TRIGGER trg_user_identities_no_superadmin
    BEFORE INSERT OR UPDATE OF subject_type, subject_id, link_method ON public.user_identities
    FOR EACH ROW EXECUTE FUNCTION public.fn_user_identities_no_superadmin();

-- ---------------------------------------------------------------------------
-- C3a — the invitation outbox + ledger
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sso_migration_invites (
    id               bigserial   PRIMARY KEY,
    subject_type     text        NOT NULL,
    subject_id       bigint      NOT NULL,
    provider         text        NOT NULL,
    trigger          text        NOT NULL,
    variant          text        NOT NULL DEFAULT 'standard',
    status           text        NOT NULL DEFAULT 'pending',
    attempts         integer     NOT NULL DEFAULT 0,
    next_attempt_at  timestamptz,
    claimed_at       timestamptz,
    last_error       text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    sent_at          timestamptz,
    reminded_at      timestamptz,
    handed_over_at   timestamptz,
    handed_over_by   bigint,
    CONSTRAINT uq_sso_migration_invites UNIQUE (subject_type, subject_id, provider),
    CONSTRAINT chk_sso_invite_subject CHECK (subject_type IN ('employee', 'admin')),
    CONSTRAINT chk_sso_invite_variant CHECK (variant IN ('standard', 'security_notice')),
    CONSTRAINT chk_sso_invite_status CHECK (status IN (
        'waiting_sso', 'pending', 'sending', 'sent', 'inapp_only', 'skipped_no_email',
        'skipped_superadmin', 'cancelled', 'failed', 'reminded'))
);
CREATE INDEX IF NOT EXISTS ix_sso_invites_due
    ON sso_migration_invites (status, next_attempt_at) WHERE status IN ('pending', 'waiting_sso');
CREATE INDEX IF NOT EXISTS ix_sso_invites_subject
    ON sso_migration_invites (subject_type, subject_id);

-- ---------------------------------------------------------------------------
-- C3b — the outbox triggers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_sso_invite_from_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_variant text;
BEGIN
    IF TG_OP = 'UPDATE'
       AND NEW.subject_type IS NOT DISTINCT FROM OLD.subject_type
       AND NEW.subject_id   IS NOT DISTINCT FROM OLD.subject_id
       AND NEW.link_method  IS NOT DISTINCT FROM OLD.link_method THEN
        RETURN NULL;
    END IF;
    IF NEW.link_method IN ('superadmin_link', 'onboarding_merge', 'delegated_link') THEN
        v_variant := 'standard';
    ELSIF NEW.link_method = 'sso_email' THEN
        v_variant := 'security_notice';
    ELSE
        RETURN NULL; -- migration_mapping (queued at mapping time), legacy, unknown
    END IF;
    INSERT INTO sso_migration_invites (subject_type, subject_id, provider, trigger, variant)
    VALUES (NEW.subject_type, NEW.subject_id, NEW.sso_provider, NEW.link_method, v_variant)
    ON CONFLICT (subject_type, subject_id, provider) DO NOTHING;
    -- The admin accounts reached through this person (linked-person route) are
    -- migrated too — only through a TRUSTED link, never a SuperAdmin.
    IF NEW.subject_type = 'employee' AND NEW.link_method IN ('superadmin_link', 'onboarding_merge') THEN
        INSERT INTO sso_migration_invites (subject_type, subject_id, provider, trigger, variant)
        SELECT 'admin', a.id, NEW.sso_provider, NEW.link_method, 'standard'
          FROM admins a
         WHERE a.linked_employee_id = NEW.subject_id
           AND a.is_active = true
           AND a.role <> 'superadmin'
        ON CONFLICT (subject_type, subject_id, provider) DO NOTHING;
    END IF;
    RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_sso_invite_from_identity ON public.user_identities;
CREATE TRIGGER trg_sso_invite_from_identity
    AFTER INSERT OR UPDATE OF subject_type, subject_id, link_method ON public.user_identities
    FOR EACH ROW EXECUTE FUNCTION public.fn_sso_invite_from_identity();

CREATE OR REPLACE FUNCTION public.fn_sso_invite_from_mapping()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status = 'pending' THEN
        INSERT INTO sso_migration_invites (subject_type, subject_id, provider, trigger, variant)
        VALUES ('employee', NEW.employee_id, NEW.provider, 'mapping', 'standard')
        ON CONFLICT (subject_type, subject_id, provider) DO NOTHING;
    END IF;
    RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_sso_invite_from_mapping ON public.sso_pending_links;
CREATE TRIGGER trg_sso_invite_from_mapping
    AFTER INSERT ON public.sso_pending_links
    FOR EACH ROW EXECUTE FUNCTION public.fn_sso_invite_from_mapping();

-- Settings: the help contact printed on the login page and in every invitation,
-- and the dispatcher's batch size.
INSERT INTO app_settings (setting_key, setting_value, setting_type, description, category)
VALUES ('sso.helpContact', '', 'string',
        'Who to contact for a sign-in problem (name, e-mail or phone). Shown under the SSO button on the sign-in page and in the SSO migration invitation.',
        'sso')
ON CONFLICT (setting_key) DO NOTHING;
INSERT INTO app_settings (setting_key, setting_value, setting_type, description, category)
VALUES ('ssoInvite.batchSize', '50', 'number',
        'How many SSO migration invitations the dispatcher sends per run (every 5 minutes).',
        'sso')
ON CONFLICT (setting_key) DO NOTHING;
