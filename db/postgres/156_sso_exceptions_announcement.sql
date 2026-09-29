-- 156 — SSO exceptions, the go-live announcement, and two 153 trigger fixes
--       (release 3.23.21, 5-day review: EXC, ANN, ST-3)
--
--   EXC  An EMPLOYEE explicitly listed by a SuperAdmin keeps password sign-in
--        while SSO is enforced (never an admin account — the SuperAdmin rule is
--        unchanged). The exception is a STATE on the employee with who/when/why:
--          employees.sso_exception_at / sso_exception_by / sso_exception_reason
--        Set and cleared only by a SuperAdmin (application check: the
--        POST /employees/:id/sso-exception route and AdminSsoService), audited.
--        Honoured only when sso_exception_by names a SuperAdmin at write time.
--
--   ANN  sso_migration_announcements — a sibling LEDGER of the invitation
--        outbox (sso_migration_invites): ONE short « from <date> you will sign
--        in with your <provider> account » notice per migrated account, sent
--        48 h before the planned go-live (setting sso.announceLeadHours, 24-168)
--        while SSO is not yet live. UNIQUE (subject_type, subject_id): the row is
--        claimed BEFORE anything is sent, so reruns and concurrent ticks never
--        send twice. Settings sso.goLiveAt (planned go-live, local time) and
--        sso.announceLeadHours.
--
--   ST-3 (a) fn_admins_superadmin_guard: when the guard actually NULLs a linked
--            person (an admin becoming SuperAdmin), an audit row is written.
--        (b) the two outbox triggers skip queueing while the transaction set
--            `SET LOCAL app.skip_sso_invite = 'on'` (an employee merge or an
--            identity move is not a migration — SsoInviteService.withoutInvites).
--
-- Additive and idempotent. Nothing is deleted.

-- ---------------------------------------------------------------------------
-- EXC — the employee SSO exception
-- ---------------------------------------------------------------------------
ALTER TABLE employees ADD COLUMN IF NOT EXISTS sso_exception_at timestamptz;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS sso_exception_by bigint;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS sso_exception_reason text;
CREATE INDEX IF NOT EXISTS ix_employees_sso_exception
    ON employees (id) WHERE sso_exception_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- ANN — the announcement ledger
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sso_migration_announcements (
    id           bigserial   PRIMARY KEY,
    subject_type text        NOT NULL,
    subject_id   bigint      NOT NULL,
    provider     text,
    go_live_at   timestamptz NOT NULL,
    status       text        NOT NULL DEFAULT 'sending',
    last_error   text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    sent_at      timestamptz,
    CONSTRAINT uq_sso_migration_announcements UNIQUE (subject_type, subject_id),
    CONSTRAINT chk_sso_announce_subject CHECK (subject_type IN ('employee', 'admin')),
    CONSTRAINT chk_sso_announce_status CHECK (status IN (
        'sending', 'sent', 'inapp_only', 'skipped_no_email', 'failed'))
);

INSERT INTO app_settings (setting_key, setting_value, setting_type, description, category)
VALUES ('sso.goLiveAt', '', 'string',
        'Planned SSO go-live (local date and time, YYYY-MM-DDTHH:MM). Migrated users receive one short announcement before it.',
        'sso')
ON CONFLICT (setting_key) DO NOTHING;
INSERT INTO app_settings (setting_key, setting_value, setting_type, description, category)
VALUES ('sso.announceLeadHours', '48', 'number',
        'How many hours before the planned SSO go-live the announcement is sent (24-168).',
        'sso')
ON CONFLICT (setting_key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- ST-3 (a) — the SuperAdmin guard leaves a trace when it unlinks a person
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_admins_superadmin_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.role = 'superadmin' THEN
        IF NEW.linked_employee_id IS NOT NULL THEN
            -- An audit row, only when the link is ACTUALLY removed. Best-effort:
            -- the guard itself must never fail because the trail could not be written.
            BEGIN
                INSERT INTO system_logs (admin_id, action, entity_type, entity_id, details,
                                         severity, category, actor_ref)
                VALUES (NULL, 'ADMIN_SUPERADMIN_UNLINKED_PERSON', 'admin', NEW.id,
                        to_jsonb(format(
                            'SuperAdmin guard: admin %s (%s) is a SuperAdmin — its linked person (employee #%s) was removed; a SuperAdmin never has a linked person (no SSO route leads to it)',
                            COALESCE(NEW.id::text, '(new)'), COALESCE(NEW.username, '?'),
                            NEW.linked_employee_id)),
                        'warning', 'security', 'system:trigger');
            EXCEPTION WHEN OTHERS THEN
                NULL;
            END;
        END IF;
        NEW.linked_employee_id := NULL;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.role = 'superadmin' AND NEW.role IS DISTINCT FROM 'superadmin' THEN
        NEW.demoted_from_superadmin_at := now();
    END IF;
    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- ST-3 (b) — the outbox triggers honour app.skip_sso_invite
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_sso_invite_from_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_variant text;
BEGIN
    IF COALESCE(current_setting('app.skip_sso_invite', true), '') = 'on' THEN
        RETURN NULL; -- an employee merge / identity move: not a migration
    END IF;
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

CREATE OR REPLACE FUNCTION public.fn_sso_invite_from_mapping()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF COALESCE(current_setting('app.skip_sso_invite', true), '') = 'on' THEN
        RETURN NULL;
    END IF;
    IF NEW.status = 'pending' THEN
        INSERT INTO sso_migration_invites (subject_type, subject_id, provider, trigger, variant)
        VALUES ('employee', NEW.employee_id, NEW.provider, 'mapping', 'standard')
        ON CONFLICT (subject_type, subject_id, provider) DO NOTHING;
    END IF;
    RETURN NULL;
END;
$$;
