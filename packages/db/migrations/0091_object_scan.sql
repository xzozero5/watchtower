-- T-155 / ADR-022: malware scan state of the files people upload.
--   object_scan  one row per stored object that a customer or a staff member put in the object store
--                (portal and mail attachments, LINE media, staff uploads). Keyed by the object key, because
--                that is what every download and every outgoing mail already holds, and because
--                message / inbound_message / staff_upload are write-once tables that cannot carry a status
--                that changes.
--   scan_status  pending -> clean | infected | error. With UPLOAD_SCAN=clamav a file is served and
--                forwarded only when its row says `clean` (no row = not clean yet: fail closed). With
--                UPLOAD_SCAN=off nothing reads this table.
--   An infected object is deleted from the store; the row stays (signature name, when) as the record.
-- The worker enrols objects it finds without a row (this is also the one-off scan of files that were
-- stored before the mode was switched on) and scans them with `attempts` / `next_attempt_at` backoff.
-- Reversible: see 0091_object_scan.down.sql.

CREATE TABLE object_scan (
  object_key text PRIMARY KEY,
  source text NOT NULL,
  ticket_id uuid,
  filename text,
  size integer,
  scan_status text NOT NULL DEFAULT 'pending',
  signature text,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  scanned_at timestamptz,
  -- Set when the object itself was deleted from the store (infected, or past the retention).
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT object_scan_status_check CHECK (scan_status IN ('pending', 'clean', 'infected', 'error')),
  CONSTRAINT object_scan_source_check CHECK (source IN ('message', 'inbound_message', 'staff_upload')),
  CONSTRAINT object_scan_attempts_check CHECK (attempts >= 0)
);
-- The scan tick takes the oldest due `pending` / `error` rows.
CREATE INDEX object_scan_due_idx ON object_scan (next_attempt_at)
  WHERE scan_status IN ('pending', 'error');
-- An infected file whose object could not be deleted at once is found again by this index.
CREATE INDEX object_scan_removal_idx ON object_scan (scanned_at)
  WHERE scan_status = 'infected' AND removed_at IS NULL;
-- Retention walks the files of a ticket.
CREATE INDEX object_scan_ticket_idx ON object_scan (ticket_id) WHERE ticket_id IS NOT NULL;
