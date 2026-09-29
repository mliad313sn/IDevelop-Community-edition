-- 145 — SAML replay protection (SSO facilitator, phase 1)
--
-- Two small tables the SAML strategy needs to reject replayed and unsolicited
-- responses, persisted in the database rather than in process memory so a
-- service restart (every upgrade) does not reopen the window:
--
--   saml_request_cache   AuthnRequest ids the app issued, so a response must
--                        answer a request WE sent (InResponseTo). Short-lived;
--                        swept by the strategy on every write.
--   saml_assertion_seen  every assertion ID accepted, per IdP issuer, until its
--                        validity ends — a captured response presented twice is
--                        refused whatever the flow (SP- or IdP-initiated).
--
-- Additive and idempotent. Pure operational state: no personal data.

CREATE TABLE IF NOT EXISTS saml_request_cache (
    request_id  text        PRIMARY KEY,
    value       text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_saml_request_cache_created ON saml_request_cache (created_at);

CREATE TABLE IF NOT EXISTS saml_assertion_seen (
    issuer        text        NOT NULL,
    assertion_id  text        NOT NULL,
    seen_at       timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL,
    PRIMARY KEY (issuer, assertion_id)
);
CREATE INDEX IF NOT EXISTS idx_saml_assertion_seen_expires ON saml_assertion_seen (expires_at);
