-- T-207a C-7: a status page address that refuses mail for good stops getting mail.
--   bounce_count  hard bounces (a permanent 5xx for this mailbox) in a row, since the last mail it accepted.
--                 The worker adds one on each, resets it on a delivery, and suppresses the subscription at
--                 STATUS_BOUNCE_LIMIT (3 `[ASSUMED]`): `state` becomes `unsubscribed` and `suppressed_at` is set.
--   suppressed_at when the worker stopped mailing the address. While it is set a new subscribe request for the
--                 address sends nothing (the answer to the caller is the same): the address must be
--                 cleared by a person (set it to NULL) once the mailbox works again.
-- Reversible: see 0093_status_subscription_bounces.down.sql.

ALTER TABLE status_subscription ADD COLUMN bounce_count integer NOT NULL DEFAULT 0;
ALTER TABLE status_subscription ADD COLUMN suppressed_at timestamptz;
ALTER TABLE status_subscription ADD CONSTRAINT status_subscription_bounce_check CHECK (
  bounce_count >= 0 AND (suppressed_at IS NULL OR state = 'unsubscribed')
);
