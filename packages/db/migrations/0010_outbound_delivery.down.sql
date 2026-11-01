-- Reverts 0010. Lossy on purpose: deliveries, drafts, quota counters and the instance setting go away.
-- Messages and their provider identity stay. A message that was `scheduled` becomes `pending` and one
-- that was `cancelled` becomes `failed`, so the older CHECK accepts them; nothing sends them after
-- this revert (the dispatcher is gone with the table). Apply the migration again to resume.
DROP INDEX IF EXISTS inbound_message_reply_token_idx;
ALTER TABLE inbound_message DROP COLUMN IF EXISTS reply_token_sealed;

REVOKE UPDATE (external_id, thread_key) ON message FROM watchtower_app;
UPDATE message SET delivery_status = 'pending' WHERE delivery_status = 'scheduled';
UPDATE message SET delivery_status = 'failed' WHERE delivery_status = 'cancelled';
ALTER TABLE message DROP CONSTRAINT message_delivery_check;
ALTER TABLE message ADD CONSTRAINT message_delivery_check CHECK (
  delivery_status IN ('not_applicable', 'pending', 'delivered', 'failed')
);

DROP TABLE IF EXISTS instance_setting;
DROP TABLE IF EXISTS channel_quota_usage;
DROP TABLE IF EXISTS outbound_delivery;
DROP TABLE IF EXISTS ai_draft;
DROP FUNCTION IF EXISTS ai_draft_set_hash();
