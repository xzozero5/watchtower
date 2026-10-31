-- Reverts 0007. Lossy on purpose: the received-message log and the event log go away. Tickets and
-- messages created from them stay (they do not depend on these tables). A provider that redelivers
-- a message after the revert would create a duplicate ticket, so apply the migration again first.
DROP INDEX IF EXISTS message_thread_key_idx;
DROP TABLE IF EXISTS inbound_message;
DROP TABLE IF EXISTS inbound_event;
