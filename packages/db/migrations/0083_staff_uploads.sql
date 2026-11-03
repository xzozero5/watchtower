-- Images and files that staff attach to tickets, shift notes, handoffs and incident notes ("paste a
-- screenshot", everywhere people write). One row per stored object; the object itself is in the
-- object store under a random key, never reachable by URL (downloads go through GET /v1/uploads/{id}).
--   1. staff_upload:        the uploaded file (name, server-decided type, size, sha256, key, who).
--   2. shift_note.attachments / handoff.attachments: references [{id, filename, contentType, size}].
-- Incident notes keep their references in incident_timeline.payload.attachments (no column needed).
-- Reversible: see 0083_staff_uploads.down.sql.

CREATE TABLE staff_upload (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  uploader_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  object_key text NOT NULL UNIQUE,
  filename text NOT NULL,
  content_type text NOT NULL,
  size integer NOT NULL,
  sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_upload_size_check CHECK (size > 0),
  CONSTRAINT staff_upload_name_check CHECK (btrim(filename) <> '')
);
CREATE INDEX staff_upload_uploader_idx ON staff_upload (uploader_id, created_at DESC);
-- A stored file never changes: it is written once and read back.
REVOKE UPDATE ON staff_upload FROM watchtower_app, PUBLIC;

ALTER TABLE shift_note ADD COLUMN attachments jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE shift_note ADD CONSTRAINT shift_note_attachments_check
  CHECK (jsonb_typeof(attachments) = 'array');
ALTER TABLE handoff ADD COLUMN attachments jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE handoff ADD CONSTRAINT handoff_attachments_check
  CHECK (jsonb_typeof(attachments) = 'array');
