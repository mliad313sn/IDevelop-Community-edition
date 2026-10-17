-- 182 — Notification e-mail DELIVERY state: retry, suppression, digest marking.
--
-- The email-channel rows of `notifications` were a write-once audit: a send
-- that failed stayed 'failed' forever, a mail to someone who had left was
-- attempted like any other, and the daily digest could not tell which in-app
-- items the person had already received by e-mail. Four columns now carry the
-- delivery state (NotificationService, SA-47):
--
--   email_status     on an EMAIL row: 'sent' | 'retry' | 'sending' | 'abandoned'
--                    | 'skipped' (SMTP off or not configured: a configuration
--                    fact, never retried) | 'suppressed' (the recipient has
--                    left, was voided or erased, or the admin account is
--                    deactivated). On an IN-APP row: 'emailed' (the event went
--                    out by e-mail on its own) | 'digested' (listed in a sent
--                    daily digest). NULL = nothing sent for it (yet).
--   email_attempts   attempts made so far (3 over 24 hours, then 'abandoned').
--   next_attempt_at  when the release tick retries a 'retry' row.
--   last_error       the last transport error, every address masked
--                    (« a***@domain »), at most 500 characters.
--
-- Suppression needs no column: the recipient's state (employees.is_active,
-- cancelled_at, erased_at; admins.is_active) is read at every attempt.
--
-- Personal data: these columns live on rows that already belong to one
-- recipient (user_type, user_id). An erasure deletes the person's own rows and
-- strips the rendered body (payload.__pendingEmail) from rows about them that
-- were addressed to someone else (erasureRegistry, DSRService). last_error
-- holds masked addresses only.
--
-- Text + CHECK rather than a new enum: adding enum values needs ALTER TYPE,
-- which cannot run inside the migrator's transaction on every supported
-- PostgreSQL version.
--
-- Additive and idempotent: safe to re-run. Nothing is deleted or rewritten.

ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS email_status    text;
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS email_attempts  integer NOT NULL DEFAULT 0;
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS last_error      text;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'notifications_email_status_check'
           AND conrelid = 'public.notifications'::regclass
    ) THEN
        ALTER TABLE public.notifications
            ADD CONSTRAINT notifications_email_status_check
            CHECK (email_status IS NULL OR email_status IN (
                'sent', 'retry', 'sending', 'abandoned', 'skipped', 'suppressed',
                'emailed', 'digested'));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'notifications_last_error_len'
           AND conrelid = 'public.notifications'::regclass
    ) THEN
        ALTER TABLE public.notifications
            ADD CONSTRAINT notifications_last_error_len
            CHECK (last_error IS NULL OR char_length(last_error) <= 500);
    END IF;
END $$;

-- Rows written before this migration: an email row that went out is 'sent';
-- one that failed is left NULL (it is not retried: its body was never kept).
UPDATE public.notifications
   SET email_status = 'sent', email_attempts = 1
 WHERE channel = 'email' AND state = 'sent' AND email_status IS NULL;

COMMENT ON COLUMN public.notifications.email_status IS
    'E-mail delivery state. Email rows: sent|retry|sending|abandoned|skipped|suppressed. In-app rows: emailed|digested (the daily digest skips them). NULL = nothing sent.';
COMMENT ON COLUMN public.notifications.email_attempts IS
    'E-mail delivery attempts so far (3 attempts over 24 hours, then abandoned).';
COMMENT ON COLUMN public.notifications.next_attempt_at IS
    'When the release tick retries an email row whose email_status = ''retry''.';
COMMENT ON COLUMN public.notifications.last_error IS
    'Last e-mail transport error (addresses masked, at most 500 characters).';

-- The release tick claims due retries with exactly this predicate.
CREATE INDEX IF NOT EXISTS idx_notifications_email_retry
    ON public.notifications (next_attempt_at)
    WHERE channel = 'email' AND email_status IN ('retry', 'sending');

-- The daily digest reads a person's unread, not-yet-e-mailed in-app rows.
CREATE INDEX IF NOT EXISTS idx_notifications_digest_pending
    ON public.notifications (user_type, user_id, created_at)
    WHERE channel = 'inapp' AND read_at IS NULL AND email_status IS NULL;

-- One language per e-mail: the language used when the recipient's own is not
-- known (App Settings → E-mail). French, the language mails were sent in until
-- now, so an upgrade changes nothing until an administrator chooses English.
INSERT INTO public.app_settings (setting_key, setting_value, setting_type, description, category)
SELECT 'mailDefaultLanguage', 'fr', 'string',
       'Language of e-mails when the recipient''s own language is not known: fr or en. Every e-mail is written in one language.',
       'email'
 WHERE NOT EXISTS (SELECT 1 FROM public.app_settings WHERE setting_key = 'mailDefaultLanguage');

SELECT public.fn_console_reader_sync();
