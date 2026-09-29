-- 158 — Webhook payload format (Slack / Microsoft Teams)
--
-- An outbound webhook can now deliver a chat-ready message instead of the raw
-- signed JSON event, so a subscription can point straight at a Slack incoming
-- webhook or a Teams workflow and nudge people in the flow of work.
--
--   json   the signed event envelope, unchanged (default)
--   slack  Slack Block Kit message
--   teams  Adaptive Card message (Teams "Post to a channel" workflow)
--
-- Additive and idempotent. Existing subscriptions keep 'json'.

ALTER TABLE webhook_subscriptions ADD COLUMN IF NOT EXISTS format text NOT NULL DEFAULT 'json';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_webhook_subscriptions_format') THEN
        ALTER TABLE webhook_subscriptions
            ADD CONSTRAINT chk_webhook_subscriptions_format CHECK (format IN ('json', 'slack', 'teams'));
    END IF;
END $$;
