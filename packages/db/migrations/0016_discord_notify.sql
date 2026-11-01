-- T-104: Discord webhook notifications. One ledger row per (event, ticket, destination slot).
-- A post to a Discord webhook has no idempotency key, so this row is what stops a retry of a half
-- finished fan-out from posting to the first channel again, and it is the place that says honestly
-- what happened: `sent` (Discord accepted it) is a different state from `mock` (the in-memory
-- transport recorded it and nothing left the machine) and from `skipped` (no webhook for the slot).
-- Holds ids and codes only: no ticket subject, no customer, no message text, no webhook URL (N1, N4).
-- The application may not delete rows, and may change only the outcome columns.
-- Reversible: see 0016_discord_notify.down.sql.

CREATE TABLE discord_notification (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- '<event>:<ticket id>:<slot>': the same post is recorded once.
  dedupe_key text NOT NULL,
  event text NOT NULL,
  ticket_id uuid NOT NULL REFERENCES ticket (id) ON DELETE RESTRICT,
  -- A destination name from the channel map, never a URL (the URL is a credential, ADR-012).
  slot text NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  -- A stable code (channel error code or kind), never provider text.
  error_code text,
  -- True when Discord may have posted although we did not hear back: another attempt may duplicate it.
  outcome_unknown boolean NOT NULL DEFAULT false,
  -- Discord's message id (a snowflake, not a secret); T-202 uses it for threads.
  provider_message_id text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT discord_notification_dedupe_key UNIQUE (dedupe_key),
  CONSTRAINT discord_notification_event_check CHECK (event IN ('ticket.created')),
  CONSTRAINT discord_notification_slot_check CHECK (slot IN ('default', 'urgent')),
  CONSTRAINT discord_notification_state_check CHECK (state IN ('pending', 'sent', 'mock', 'skipped', 'failed')),
  CONSTRAINT discord_notification_attempts_check CHECK (attempts >= 0),
  -- Only a real, accepted post has a delivery time. A mock row can never claim one.
  CONSTRAINT discord_notification_sent_at CHECK ((state = 'sent') = (sent_at IS NOT NULL)),
  CONSTRAINT discord_notification_message_id CHECK (provider_message_id IS NULL OR state = 'sent'),
  CONSTRAINT discord_notification_reason CHECK (state NOT IN ('failed', 'skipped') OR error_code IS NOT NULL)
);
CREATE INDEX discord_notification_ticket_idx ON discord_notification (ticket_id, created_at);
-- What an operator looks at: posts still owed, and posts that were given up on.
CREATE INDEX discord_notification_open_idx ON discord_notification (created_at)
  WHERE state IN ('pending', 'failed');

-- Who, what and where never change; the application records the outcome. No DELETE.
REVOKE UPDATE, DELETE ON discord_notification FROM watchtower_app, PUBLIC;
GRANT UPDATE (
  state, attempts, error_code, outcome_unknown, provider_message_id, sent_at, updated_at
) ON discord_notification TO watchtower_app;
