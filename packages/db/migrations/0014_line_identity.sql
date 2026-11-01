-- T-103d: LINE identity (PRD section 4.2 R-2.11).
--   line_link_code:      a one-time code a staff member generates for a contact; the customer sends it
--                        in LINE and the LINE user id is linked to that contact. Only a SHA-256 of
--                        the code is stored, so a database copy holds nothing a customer can type.
--   contact.merged_into_contact_id: when a LINE user who already wrote to us is linked to a known
--                        contact, the placeholder contact their first messages created is retired,
--                        not deleted (`message.sender_contact_id` is immutable and RESTRICT). The
--                        placeholder lets go of the LINE user id, which `contact_has_email` would
--                        refuse for a contact without an address, so the check also accepts a
--                        retired placeholder. (`contact_line_user_key` already makes the LINE user
--                        id unique: 0002.)
-- Reversible: see 0014_line_identity.down.sql.

CREATE TABLE line_link_code (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES contact (id) ON DELETE CASCADE,
  -- sha256 of the normalised code, hex. The code itself is shown once to the staff member who asked.
  code_hash text NOT NULL,
  -- The staff member who generated it. No foreign key, like audit_log.actor_id: the record outlives the user.
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  CONSTRAINT line_link_code_hash_check CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT line_link_code_expiry_check CHECK (expires_at > created_at)
);
-- Redemption looks a code up by its hash; two live codes must never share one.
CREATE UNIQUE INDEX line_link_code_hash_key ON line_link_code (code_hash) WHERE used_at IS NULL;
CREATE INDEX line_link_code_contact_idx ON line_link_code (contact_id);
-- Finished codes are deleted by age; this is the retention scan.
CREATE INDEX line_link_code_expiry_idx ON line_link_code (expires_at);

ALTER TABLE contact ADD COLUMN merged_into_contact_id uuid REFERENCES contact (id) ON DELETE RESTRICT;
CREATE INDEX contact_merged_into_idx ON contact (merged_into_contact_id) WHERE merged_into_contact_id IS NOT NULL;
ALTER TABLE contact DROP CONSTRAINT contact_has_email;
ALTER TABLE contact ADD CONSTRAINT contact_has_email CHECK (
  cardinality(emails) >= 1 OR line_user_id IS NOT NULL OR merged_into_contact_id IS NOT NULL
);
