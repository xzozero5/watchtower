-- Reverses 0082. The recipients shown on old mails are lost; the mails themselves are not touched.
ALTER TABLE inbound_message DROP COLUMN email_meta;
ALTER TABLE message DROP COLUMN email_meta;
