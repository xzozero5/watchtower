-- T-174: CSAT survey by email that is really delivered (R-10.1 to R-10.4).
--   1. Three instance settings an admin can change: surveys on/off, hours to the one reminder
--      (0 = no reminder), days between two surveys to one contact (0 = no limit). The delay setting
--      csat.delay_minutes already exists (0031). A missing row reads as the default, so these inserts
--      only make the values visible.
--   2. csat_email_dispatch: the at-most-once ledger of a survey (or reminder) that goes out through a
--      Gmail mailbox. A Gmail send has no idempotency key (ADR-010 section 6), so a worker claims the
--      (survey, kind) pair before the send: a second claim finds the row and sends nothing. A send that
--      certainly did not leave (no token, not connected, refused before the body) is released for a
--      retry; one that may have left stays claimed and is never repeated. Holds ids, codes and times
--      only: no address, no subject, no link, no body.
-- Reversible: see 0084_csat_gmail_delivery.down.sql.

ALTER TABLE instance_setting ADD CONSTRAINT instance_setting_csat_enabled_check CHECK (
  key <> 'csat.enabled' OR jsonb_typeof(value) = 'boolean'
);
ALTER TABLE instance_setting ADD CONSTRAINT instance_setting_csat_reminder_check CHECK (
  key <> 'csat.reminder_hours'
  OR CASE
       WHEN jsonb_typeof(value) = 'number' AND (value #>> '{}') ~ '^[0-9]{1,3}$'
         THEN (value #>> '{}')::integer BETWEEN 0 AND 720
       ELSE false
     END
);
ALTER TABLE instance_setting ADD CONSTRAINT instance_setting_csat_cooldown_check CHECK (
  key <> 'csat.cooldown_days'
  OR CASE
       WHEN jsonb_typeof(value) = 'number' AND (value #>> '{}') ~ '^[0-9]{1,2}$'
         THEN (value #>> '{}')::integer BETWEEN 0 AND 90
       ELSE false
     END
);
INSERT INTO instance_setting (key, value) VALUES
  ('csat.enabled', 'true'::jsonb),
  ('csat.reminder_hours', '48'::jsonb),
  ('csat.cooldown_days', '7'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE csat_email_dispatch (
  survey_id uuid NOT NULL REFERENCES csat_survey (id) ON DELETE RESTRICT,
  kind text NOT NULL,
  state text NOT NULL DEFAULT 'claimed',
  attempts integer NOT NULL DEFAULT 1,
  channel_account_id uuid REFERENCES channel_account (id) ON DELETE SET NULL,
  provider_message_id text,
  -- A stable code for a release or an unknown outcome (never provider text).
  error_code text,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  PRIMARY KEY (survey_id, kind),
  CONSTRAINT csat_email_dispatch_kind_check CHECK (kind IN ('survey', 'reminder')),
  CONSTRAINT csat_email_dispatch_state_check CHECK (state IN ('claimed', 'sent', 'released')),
  CONSTRAINT csat_email_dispatch_attempts_check CHECK (attempts BETWEEN 1 AND 20),
  CONSTRAINT csat_email_dispatch_sent_check CHECK (state <> 'sent' OR finished_at IS NOT NULL)
);
CREATE INDEX csat_email_dispatch_account_idx ON csat_email_dispatch (channel_account_id)
  WHERE channel_account_id IS NOT NULL;
-- The ledger is never deleted: a claim that stays 'claimed' is the record of an unknown outcome.
REVOKE DELETE ON csat_email_dispatch FROM watchtower_app, PUBLIC;
