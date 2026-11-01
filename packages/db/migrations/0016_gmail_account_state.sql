-- T-102 b/c: state of one Gmail mailbox (PRD R-2.1, R-2.8; ADR-009).
--   email_address:     the mailbox the Pub/Sub push names (`emailAddress` in the notification), lower case.
--                      The push receiver finds the channel account through it.
--   history_id:        the cursor of `users.history.list` (a decimal string; text keeps it exact).
--                      NULL = never synced: the next sync is a bounded full sync.
--   watch_*:           when the last `users.watch` ran and when Gmail stops pushing (R-2.1: renew daily).
--   last_push_at:      the last verified push (the heartbeat of R-2.8 reads it).
--   last_sync_at / last_full_sync_at / last_error_code: what the worker did last. A code never holds text from Gmail.
-- The application role has the default grants of 0001 (SELECT, INSERT, UPDATE, DELETE): the receiver (api)
-- writes last_push_at, the worker writes the rest.
-- Reversible: see 0016_gmail_account_state.down.sql.

CREATE TABLE gmail_account_state (
  channel_account_id uuid PRIMARY KEY REFERENCES channel_account (id) ON DELETE CASCADE,
  email_address text NOT NULL,
  history_id text,
  watch_expires_at timestamptz,
  watch_renewed_at timestamptz,
  last_push_at timestamptz,
  last_sync_at timestamptz,
  last_full_sync_at timestamptz,
  last_error_code text,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gmail_account_state_email_check CHECK (email_address = lower(email_address) AND email_address <> ''),
  CONSTRAINT gmail_account_state_history_check CHECK (history_id IS NULL OR history_id ~ '^[0-9]{1,20}$')
);
-- A push names a mailbox by address; two accounts for one address would split its mail.
CREATE UNIQUE INDEX gmail_account_state_email_key ON gmail_account_state (email_address);
