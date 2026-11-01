-- T-201d: escalation of alerts (PRD R-3.8, ADR-015 section 2). Reversible: 0042_alert_escalation.down.sql.
--
--   alert.acked_via       where an acknowledgment came from (web or Discord).
--   alert_escalation      one row per step of an escalation policy that was carried out: who was told
--                         (ids only) and how the chat post of that step went. UNIQUE (alert_id, level)
--                         means a step is carried out once, however many times a sweep runs.
--   notification kinds    alert.fired (you are on shift and an alert needs you) and alert.escalated
--                         (nobody acknowledged it in time and it reached you).
--
-- Clock: alert.next_escalation_at and alert_escalation.created_at are written with the database clock.
-- The chat columns follow the discord_notification ledger (migration 0017): a post is claimed
-- (`sending`) before it is made; a mock transport can never record `sent`; ids and codes only.

ALTER TABLE notification DROP CONSTRAINT notification_kind_check;
ALTER TABLE notification ADD CONSTRAINT notification_kind_check
  CHECK (kind IN ('ticket.p1', 'ticket.assigned', 'shift.handoff_overdue', 'shift.no_show', 'alert.fired', 'alert.escalated'));
ALTER TABLE notification_preference DROP CONSTRAINT notification_preference_kind_check;
ALTER TABLE notification_preference ADD CONSTRAINT notification_preference_kind_check
  CHECK (kind IN ('ticket.p1', 'ticket.assigned', 'shift.handoff_overdue', 'shift.no_show', 'alert.fired', 'alert.escalated'));

ALTER TABLE alert ADD COLUMN acked_via text;
ALTER TABLE alert ADD CONSTRAINT alert_acked_via_check
  CHECK (acked_via IS NULL OR acked_via IN ('web', 'discord'));
-- An acknowledged alert has an acknowledger's channel; an open one has none.
ALTER TABLE alert ADD CONSTRAINT alert_acked_via_state CHECK (acked_via IS NULL OR acked_at IS NOT NULL);

CREATE TABLE alert_escalation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id uuid NOT NULL REFERENCES alert (id) ON DELETE CASCADE,
  -- Index of the step in the policy (0 = the first).
  level smallint NOT NULL,
  target text NOT NULL,
  -- 'lead' when nobody was on shift and the leads were told in place of the on-shift people.
  fallback text,
  recipient_ids uuid[] NOT NULL DEFAULT '{}',
  recipient_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- The chat post of this step (Discord).
  chat_state text NOT NULL DEFAULT 'pending',
  chat_next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  chat_claimed_at timestamptz,
  chat_attempts integer NOT NULL DEFAULT 0,
  chat_error_code text,
  chat_channel_id text,
  chat_message_id text,
  chat_sent_at timestamptz,
  CONSTRAINT alert_escalation_level_check CHECK (level BETWEEN 0 AND 10),
  CONSTRAINT alert_escalation_target_check CHECK (target IN ('on_shift', 'lead', 'head')),
  CONSTRAINT alert_escalation_fallback_check CHECK (fallback IS NULL OR fallback = 'lead'),
  CONSTRAINT alert_escalation_count_check CHECK (recipient_count = cardinality(recipient_ids)),
  CONSTRAINT alert_escalation_chat_state_check
    CHECK (chat_state IN ('pending', 'sending', 'sent', 'mock', 'skipped', 'failed')),
  CONSTRAINT alert_escalation_chat_claim_check CHECK ((chat_state = 'sending') = (chat_claimed_at IS NOT NULL)),
  CONSTRAINT alert_escalation_chat_attempts_check CHECK (chat_attempts >= 0),
  -- Only a real, accepted post has a delivery time and a message id. A mock row can claim neither.
  CONSTRAINT alert_escalation_chat_sent CHECK (
    (chat_state = 'sent') = (chat_sent_at IS NOT NULL)
    AND (chat_message_id IS NULL OR chat_state = 'sent')
  ),
  CONSTRAINT alert_escalation_chat_reason CHECK (chat_state NOT IN ('failed', 'skipped') OR chat_error_code IS NOT NULL)
);
CREATE UNIQUE INDEX alert_escalation_step_key ON alert_escalation (alert_id, level);
-- The chat sweep: posts still owed, and claims a dead worker left behind.
CREATE INDEX alert_escalation_chat_due_idx ON alert_escalation (chat_next_attempt_at)
  WHERE chat_state IN ('pending', 'sending');

-- Who and which step never change; the application records the outcome of the chat post. No DELETE
-- (rows go with their alert).
REVOKE UPDATE ON alert_escalation FROM watchtower_app, PUBLIC;
GRANT UPDATE (
  chat_state, chat_next_attempt_at, chat_claimed_at, chat_attempts, chat_error_code,
  chat_channel_id, chat_message_id, chat_sent_at
) ON alert_escalation TO watchtower_app;
