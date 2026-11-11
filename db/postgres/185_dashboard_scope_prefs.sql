-- 185 — Dashboard: the last scope a reader chose, remembered on the SERVER.
--
-- The dashboard's scope (a site, a department, or the whole of the reader's
-- clearance) lives in the URL, so a link can be shared and the back button
-- works. When a person opens the dashboard again WITHOUT a scope in the URL,
-- the last scope they chose on that page is restored from this table, never
-- from the browser: a shared computer or a kiosk is used by several people,
-- and browser storage would hand one person's scope to the next.
--
--   user_type       'admin' | 'employee' (a manager signs in as an employee)
--   user_id         admins.id or employees.id
--   page            the page key ('dashboard', 'board_pack')
--   scope           the validated filter, e.g. {"site": 4, "department": 12};
--                   an empty object = "everything I may see", chosen explicitly
--
-- The stored scope is a PREFERENCE, never a clearance: it is re-validated
-- against the reader's population on every read and dropped when it no longer
-- fits (a site that left the reader's clearance is never shown again).
--
-- Personal data: one person's own screen preference, nothing about anyone
-- else. Returned in the personal-data export and deleted on erasure (the
-- employee rows; an administrator account is not a data subject here), kept
-- by the go-live reset like the notification settings.
--
-- Additive and idempotent: safe to re-run. Nothing is deleted or rewritten.

CREATE TABLE IF NOT EXISTS public.dashboard_scope_prefs (
    user_type  text        NOT NULL,
    user_id    bigint      NOT NULL,
    page       text        NOT NULL,
    scope      jsonb       NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_type, user_id, page)
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'dashboard_scope_prefs_shape'
           AND conrelid = 'public.dashboard_scope_prefs'::regclass
    ) THEN
        -- A short fixed vocabulary: two account kinds, a page key, a small
        -- JSON object (ids only, never free text).
        ALTER TABLE public.dashboard_scope_prefs
            ADD CONSTRAINT dashboard_scope_prefs_shape
            CHECK (user_type IN ('admin', 'employee')
               AND char_length(page) BETWEEN 1 AND 32
               AND jsonb_typeof(scope) = 'object'
               AND octet_length(scope::text) <= 256);
    END IF;
END $$;

COMMENT ON TABLE public.dashboard_scope_prefs IS
    'Last dashboard scope per account and page (migration 185). A preference re-validated against the reader''s clearance on every read, never a clearance.';
COMMENT ON COLUMN public.dashboard_scope_prefs.scope IS
    'Validated filter ids, e.g. {"site": 4, "department": 12}. {} = the whole of the reader''s clearance, chosen explicitly.';

SELECT public.fn_console_reader_sync();
