-- T-105 (live Web Push): one browser's push subscription of one person.
--   The endpoint is a capability URL of a push service (anyone who holds it can push to that browser), so it
--   is never returned by the API, never logged, and the sender only talks to an allow-listed https host.
--   `p256dh` and `auth` are the browser's public key and its auth secret (RFC 8291); they only let a sender
--   encrypt a message for that browser, they do not open anything.
--   `failure_count` counts permanent failures in a row (reset by a success); the sender removes the row at
--   the limit. A 404/410 from the push service removes it at once.
-- Reversible: see 0105_web_push_subscription.down.sql.

CREATE TABLE web_push_subscription (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  endpoint text NOT NULL,
  p256dh text NOT NULL,
  auth text NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_success_at timestamptz,
  failure_count integer NOT NULL DEFAULT 0,
  CONSTRAINT web_push_subscription_endpoint_unique UNIQUE (endpoint),
  CONSTRAINT web_push_subscription_endpoint_https CHECK (endpoint LIKE 'https://%' AND length(endpoint) <= 2048),
  CONSTRAINT web_push_subscription_keys_length CHECK (length(p256dh) BETWEEN 80 AND 100 AND length(auth) BETWEEN 20 AND 30),
  CONSTRAINT web_push_subscription_user_agent_length CHECK (user_agent IS NULL OR length(user_agent) <= 300),
  CONSTRAINT web_push_subscription_failure_count CHECK (failure_count >= 0)
);

CREATE INDEX web_push_subscription_user_idx ON web_push_subscription (user_id);
