-- Email header block of a message (To / Cc / Bcc / Subject) so the ticket timeline can show a mail like
-- a Gmail thread and a reply can keep the recipients the person chose. Nullable: only email messages
-- have it; existing rows stay NULL. Bcc is stored for outbound only (the audit of who was blind-copied).
-- Reversible: see 0082_message_email_meta.down.sql.

ALTER TABLE message ADD COLUMN email_meta jsonb;
ALTER TABLE inbound_message ADD COLUMN email_meta jsonb;
