-- 183 — Notification MEASUREMENT and per-person PREFERENCES (SA-48).
--
-- Migration 182 gave every e-mail a delivery state. This one lets a person
-- choose what reaches their mailbox, and lets an administrator see whether a
-- kind of notification is useful at all:
--
--   1) Measurement columns on `notifications`:
--        event_id   one id per notify() call, shared by the in-app row and the
--                   e-mail row of the same event. A row WITHOUT event_id was
--                   written before this migration: it is outside every figure
--                   (it was never measurable), never counted as "not opened".
--        ref_type / ref_id   the object the notification is about (a campaign,
--                   a skill…), identifiers only, so the action that closes it
--                   can stamp acted_at.
--        opened_at  set ONLY when the owner follows the notification's link
--                   (GET /notifications/:id/go). "Mark all as read" never sets
--                   it, and no tracking pixel exists.
--        acted_at   set by NotificationService.markActed() when the action the
--                   notification asked for is done (self-assessment submitted,
--                   review decided, certificate recorded, successor named).
--
--   2) notification_user_settings — one row per person, a NULL column meaning
--      "the default":
--        digest_cadence   'daily' | 'weekly' | 'off' for the personal summary
--                         (default: daily, the behaviour before this migration)
--        email_locale     'fr' | 'en': the language of the person's e-mails
--                         (default: the site's mailDefaultLanguage)
--        ics_enabled      attach an .ics calendar file to mails that announce a
--                         deadline (default on)
--        digest_stepdown_at / digest_stepdown_from   eight summaries in a row
--                         left unopened slow the cadence down one notch
--                         (daily → weekly → off); the preferences page offers
--                         to turn it back on.
--        digest_streak_from  the unopened count starts here (a step-down, a
--                         reactivation or a cadence change restarts it).
--
--   3) notification_category_prefs — the category × channel grid. Channel is
--      TEXT ('email' only today), not the notif_channel enum, so a later channel
--      needs no ALTER TYPE. The in-app channel is always on and never stored;
--      mandatory kinds (workplace safety, account security) ignore this table.
--
--   4) sites.quiet_hours_start / quiet_hours_end — a site's default quiet hours
--      for the people who have not set their own. Sites carry no time zone: the
--      window is read in the server's local time, like the personal one.
--
-- Personal data: both tables hold one person's own settings, nothing about
-- anyone else. They are returned in the personal-data export and deleted on
-- erasure (erasureRegistry, DSRService), kept by the go-live reset like
-- notification_preferences. The new notifications columns live on rows that
-- already belong to one recipient and go with them.
--
-- Additive and idempotent: safe to re-run. Nothing is deleted or rewritten.

-- ---- 1) Measurement columns -------------------------------------------------
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS event_id  uuid;
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS ref_type  text;
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS ref_id    text;
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS opened_at timestamptz;
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS acted_at  timestamptz;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'notifications_ref_shape'
           AND conrelid = 'public.notifications'::regclass
    ) THEN
        -- Identifiers only: a reference can never carry free text.
        ALTER TABLE public.notifications
            ADD CONSTRAINT notifications_ref_shape
            CHECK ((ref_type IS NULL OR char_length(ref_type) <= 32)
               AND (ref_id IS NULL OR char_length(ref_id) <= 64));
    END IF;
END $$;

COMMENT ON COLUMN public.notifications.event_id IS
    'One id per notify() call, shared by its in-app and e-mail rows. NULL = written before migration 183 (outside the measurements).';
COMMENT ON COLUMN public.notifications.ref_type IS
    'Type of the object the notification is about (cycle, skill…), matched by NotificationService.markActed().';
COMMENT ON COLUMN public.notifications.ref_id IS
    'Id of the object the notification is about (an identifier, never text).';
COMMENT ON COLUMN public.notifications.opened_at IS
    'First time the owner followed the notification link (GET /notifications/:id/go). Never set by mark-all-read.';
COMMENT ON COLUMN public.notifications.acted_at IS
    'When the action the notification asked for was done (NotificationService.markActed).';

-- markActed() looks for still-open rows about one object…
CREATE INDEX IF NOT EXISTS idx_notifications_ref_open
    ON public.notifications (ref_type, ref_id)
    WHERE acted_at IS NULL AND ref_type IS NOT NULL;
-- …and the effectiveness page reads 30 days of measurable rows per kind.
CREATE INDEX IF NOT EXISTS idx_notifications_metrics
    ON public.notifications (created_at, kind)
    WHERE event_id IS NOT NULL;

-- ---- 2) Per-person settings -------------------------------------------------
CREATE TABLE IF NOT EXISTS public.notification_user_settings (
    user_type             text        NOT NULL,
    user_id               bigint      NOT NULL,
    digest_cadence        text,
    email_locale          text,
    ics_enabled           boolean     NOT NULL DEFAULT true,
    digest_stepdown_at    timestamptz,
    digest_stepdown_from  text,
    digest_streak_from    timestamptz,
    updated_at            timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_type, user_id),
    CONSTRAINT notification_user_settings_user_type_check
        CHECK (user_type IN ('admin', 'employee')),
    CONSTRAINT notification_user_settings_cadence_check
        CHECK (digest_cadence IS NULL OR digest_cadence IN ('daily', 'weekly', 'off')),
    CONSTRAINT notification_user_settings_locale_check
        CHECK (email_locale IS NULL OR email_locale IN ('fr', 'en')),
    CONSTRAINT notification_user_settings_stepdown_from_check
        CHECK (digest_stepdown_from IS NULL OR digest_stepdown_from IN ('daily', 'weekly'))
);

COMMENT ON TABLE public.notification_user_settings IS
    'Per-person notification settings (migration 183): summary cadence, e-mail language, .ics attachments, summary step-down. NULL column = the default.';

-- ---- 3) Category × channel grid ---------------------------------------------
CREATE TABLE IF NOT EXISTS public.notification_category_prefs (
    user_type   text        NOT NULL,
    user_id     bigint      NOT NULL,
    category    text        NOT NULL,
    channel     text        NOT NULL,
    enabled     boolean     NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_type, user_id, category, channel),
    CONSTRAINT notification_category_prefs_user_type_check
        CHECK (user_type IN ('admin', 'employee')),
    CONSTRAINT notification_category_prefs_channel_check
        CHECK (channel IN ('email')),
    CONSTRAINT notification_category_prefs_category_check
        CHECK (char_length(category) BETWEEN 1 AND 32
               AND category = lower(category)
               AND translate(category, 'abcdefghijklmnopqrstuvwxyz_', '') = '')
);

COMMENT ON TABLE public.notification_category_prefs IS
    'Category x channel notification switches (migration 183). No row = default (e-mail on). In-app is always on; mandatory kinds ignore this table.';

-- The effectiveness page counts e-mail opt-outs per category.
CREATE INDEX IF NOT EXISTS idx_notification_category_prefs_off
    ON public.notification_category_prefs (category, channel)
    WHERE enabled = false;

-- ---- 4) Site default quiet hours --------------------------------------------
ALTER TABLE public.sites ADD COLUMN IF NOT EXISTS quiet_hours_start time without time zone;
ALTER TABLE public.sites ADD COLUMN IF NOT EXISTS quiet_hours_end   time without time zone;

COMMENT ON COLUMN public.sites.quiet_hours_start IS
    'Default quiet-hours start for the people of this site (server local time). A personal window wins.';
COMMENT ON COLUMN public.sites.quiet_hours_end IS
    'Default quiet-hours end for the people of this site (server local time).';

SELECT public.fn_console_reader_sync();
