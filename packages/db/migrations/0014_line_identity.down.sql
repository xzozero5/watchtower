-- Reverts 0014. Lossy on purpose: pending link codes are dropped (a customer asks for a new one).
-- A retired placeholder contact (one that was merged into a known contact) gets a tombstone LINE id so
-- the older `contact_has_email` check accepts it again; the link to the contact it merged into goes.
UPDATE contact SET line_user_id = 'retired:' || id::text
WHERE merged_into_contact_id IS NOT NULL AND line_user_id IS NULL AND cardinality(emails) = 0;
ALTER TABLE contact DROP CONSTRAINT contact_has_email;
ALTER TABLE contact ADD CONSTRAINT contact_has_email CHECK (cardinality(emails) >= 1 OR line_user_id IS NOT NULL);
DROP TRIGGER IF EXISTS contact_line_facts_reset ON contact;
DROP FUNCTION IF EXISTS contact_line_facts_reset();
ALTER TABLE contact DROP CONSTRAINT IF EXISTS contact_line_facts_need_id_check;
ALTER TABLE contact DROP CONSTRAINT IF EXISTS contact_line_verified_check;
ALTER TABLE contact DROP CONSTRAINT IF EXISTS contact_line_linked_via_check;
ALTER TABLE contact DROP COLUMN IF EXISTS line_verified_at;
ALTER TABLE contact DROP COLUMN IF EXISTS line_linked_at;
ALTER TABLE contact DROP COLUMN IF EXISTS line_linked_via;
DROP INDEX IF EXISTS contact_merged_into_idx;
ALTER TABLE contact DROP COLUMN IF EXISTS merged_into_contact_id;
DROP TABLE IF EXISTS line_link_code;
