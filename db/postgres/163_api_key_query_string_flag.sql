-- 163 — Per-key "allow query-string (legacy Power BI)" flag
--
-- API keys are now accepted from the X-API-Key / Authorization: Bearer headers
-- only. A key in the URL (?apiKey=) leaks into proxy logs, browser history and
-- Referer headers, so it is accepted only from keys that carry this flag.
--
-- NEW keys get the flag OFF. Keys that EXIST at the upgrade keep working
-- (flag ON) so existing Power BI feeds do not break; a SuperAdmin turns it off
-- per key once the feed sends the header. The ON backfill runs only when the
-- column is created, so re-running this file never re-opens a key a
-- SuperAdmin closed. The env shared key (API_KEY) needs API_KEY_QUERY_STRING=1.
--
-- Additive and idempotent. Nothing is deleted.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'api_keys'
           AND column_name = 'allow_query_key'
    ) THEN
        ALTER TABLE api_keys ADD COLUMN allow_query_key boolean NOT NULL DEFAULT false;
        UPDATE api_keys SET allow_query_key = true;
    END IF;
END $$;

COMMENT ON COLUMN api_keys.allow_query_key IS
    'true = this key may also be presented as ?apiKey= (legacy Power BI). New keys: false.';
