-- Reverts 0003. Lossy in two places, both on purpose: pending outbox rows (jobs not yet handed to
-- Redis) are dropped, and organizations or SLA policies on a tier that is not gold/silver/standard
-- are moved to `standard` / detached so the old CHECK constraints can be restored.
DROP TABLE IF EXISTS outbox;

DROP INDEX IF EXISTS ticket_intent_idx;
DROP INDEX IF EXISTS ticket_queue_id_idx;
DROP INDEX IF EXISTS message_sender_user_idx;
DROP INDEX IF EXISTS message_sender_contact_idx;

REVOKE UPDATE (delivery_status, body_redacted) ON message FROM watchtower_app;
GRANT UPDATE, DELETE ON message TO watchtower_app;

ALTER TABLE message DROP CONSTRAINT message_sender_contact_id_fkey;
ALTER TABLE message
  ADD CONSTRAINT message_sender_contact_id_fkey
  FOREIGN KEY (sender_contact_id) REFERENCES contact (id) ON DELETE SET NULL;
ALTER TABLE ticket DROP CONSTRAINT ticket_queue_id_fkey;
ALTER TABLE ticket
  ADD CONSTRAINT ticket_queue_id_fkey
  FOREIGN KEY (queue_id) REFERENCES team_queue (id) ON DELETE SET NULL;
ALTER TABLE ticket DROP CONSTRAINT ticket_requester_contact_id_fkey;
ALTER TABLE ticket
  ADD CONSTRAINT ticket_requester_contact_id_fkey
  FOREIGN KEY (requester_contact_id) REFERENCES contact (id) ON DELETE SET NULL;

ALTER TABLE sla_policy DROP CONSTRAINT sla_policy_tier_fkey;
ALTER TABLE organization DROP CONSTRAINT organization_tier_fkey;
UPDATE organization SET tier = 'standard' WHERE tier NOT IN ('gold', 'silver', 'standard');
UPDATE sla_policy SET tier = NULL WHERE tier IS NOT NULL AND tier NOT IN ('gold', 'silver', 'standard');
ALTER TABLE organization
  ADD CONSTRAINT organization_tier_check CHECK (tier IN ('gold', 'silver', 'standard'));
ALTER TABLE sla_policy
  ADD CONSTRAINT sla_policy_tier_check CHECK (tier IS NULL OR tier IN ('gold', 'silver', 'standard'));
DROP TABLE IF EXISTS org_tier;
