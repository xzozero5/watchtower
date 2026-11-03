-- Reverts 0083. Lossy on purpose: the references on notes and handoffs and the upload rows go away.
-- The stored objects are not touched (the database cannot reach the object store); they are orphans
-- that a storage lifecycle rule removes. Apply the migration again to resume.
ALTER TABLE handoff DROP CONSTRAINT IF EXISTS handoff_attachments_check;
ALTER TABLE handoff DROP COLUMN IF EXISTS attachments;
ALTER TABLE shift_note DROP CONSTRAINT IF EXISTS shift_note_attachments_check;
ALTER TABLE shift_note DROP COLUMN IF EXISTS attachments;
DROP TABLE IF EXISTS staff_upload;
