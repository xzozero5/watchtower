-- T-010 security fixes (C-1, C-2, C-7).
--   1. users.dev_created: marks accounts created by the mock "dev login", so dev login can never
--      sign in as an account it did not create (a seeded or invited account, a real person).
--   2. outbox.expires_at: a job that carries a secret (magic link, tracking link) stops being
--      worth sending after a while. The relay marks an expired pending row dead and blanks its
--      payload instead of handing it to the queue. The payload's secret part is now encrypted by
--      the application (ADR-006); this column bounds how long even the ciphertext is kept.
--   3. break_glass_attempt: failed break-glass sign-ins per (account, client IP). Replaces the
--      account-wide lock, which let anyone who knew the address lock the admin out. The delay
--      grows exponentially with the failures from that IP only.
-- Reversible: see 0005_security.sql down file.

-- 1. Dev-login provenance. Existing rows are false: dev login refuses them, which is the safe side.
ALTER TABLE users ADD COLUMN dev_created boolean NOT NULL DEFAULT false;

-- 2. Outbox expiry.
ALTER TABLE outbox ADD COLUMN expires_at timestamptz;
CREATE INDEX outbox_expiry_idx ON outbox (expires_at) WHERE status = 'pending' AND expires_at IS NOT NULL;
-- Email rows written before this migration carry their secret in plain text and have no expiry.
-- They cannot be encrypted here (the key lives in the application), so they are given up on:
-- a customer asks for a new link. Anything older than a magic link's lifetime was dead already.
UPDATE outbox
   SET status = 'dead',
       payload = '{}'::jsonb,
       last_error = 'dropped by migration 0005: payload predates encrypted secrets',
       locked_until = NULL,
       finished_at = now()
 WHERE status = 'pending' AND queue = 'email';

-- 3. Break-glass lockout per (account, IP).
CREATE TABLE break_glass_attempt (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- The client address as the api saw it ('unknown' when it could not tell).
  ip text NOT NULL,
  -- Consecutive wrong passwords from this IP since the last success or the last quiet day.
  failed_count integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_failed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, ip),
  CONSTRAINT break_glass_attempt_count_check CHECK (failed_count >= 0)
);
-- The old account-wide lock is gone: release anything it still holds.
UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE is_break_glass;
