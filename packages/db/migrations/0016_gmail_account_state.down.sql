-- Reverts 0014. Lossy on purpose: the sync cursor, watch state and push heartbeat of every mailbox go away.
-- The next sync after re-applying the migration is a bounded full sync; messages already received are
-- not duplicated (inbound_message is unique per Gmail message id).
DROP TABLE IF EXISTS gmail_account_state;
