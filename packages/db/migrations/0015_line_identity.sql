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
--   contact.line_linked_via / line_linked_at / line_verified_at: how a LINE user id got attached to a
--                        contact and whether that link is verified. Kept apart from `verified_at`
--                        (the contact's own verification, e.g. a confirmed email): a LINE account that
--                        was linked to an email-verified contact must not inherit "verified".
--                          staff_code  a staff member generated the code and told the customer: linked,
--                                      LINE identity stays UNVERIFIED (line_verified_at NULL)
--                          line_login  the contact's own signed-in portal session proved the LINE account
--                          email_code  the code went only to the contact's verified email (T-103e, not built)
--                        `[ASSUMED]` po decision, reviewed by the owner at T-115.
-- Reversible: see 0015_line_identity.down.sql.

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
ALTER TABLE contact ADD COLUMN line_linked_via text;
ALTER TABLE contact ADD COLUMN line_linked_at timestamptz;
ALTER TABLE contact ADD COLUMN line_verified_at timestamptz;
ALTER TABLE contact ADD CONSTRAINT contact_line_linked_via_check
  CHECK (line_linked_via IS NULL OR line_linked_via IN ('staff_code', 'line_login', 'email_code'));
-- A verified LINE identity says how it was verified, and a staff-issued code never verifies.
ALTER TABLE contact ADD CONSTRAINT contact_line_verified_check CHECK (
  line_verified_at IS NULL OR (line_linked_via IS NOT NULL AND line_linked_via <> 'staff_code')
);
-- The link facts describe the LINE user id on the row: with no id there is nothing to describe.
ALTER TABLE contact ADD CONSTRAINT contact_line_facts_need_id_check CHECK (
  line_user_id IS NOT NULL
  OR (line_linked_via IS NULL AND line_linked_at IS NULL AND line_verified_at IS NULL)
);
-- A new or removed LINE user id starts unlinked (C-8). A staff edit of `line_user_id` (the contacts
-- API) must not leave the old id's "verified" on the new one, so the link facts are cleared whenever
-- the id changes unless the same statement sets them (the LINE link code and LINE Login do).
CREATE FUNCTION contact_line_facts_reset() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.line_user_id IS DISTINCT FROM OLD.line_user_id
     AND NEW.line_linked_via IS NOT DISTINCT FROM OLD.line_linked_via
     AND NEW.line_linked_at IS NOT DISTINCT FROM OLD.line_linked_at
     AND NEW.line_verified_at IS NOT DISTINCT FROM OLD.line_verified_at THEN
    NEW.line_linked_via := NULL;
    NEW.line_linked_at := NULL;
    NEW.line_verified_at := NULL;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER contact_line_facts_reset
  BEFORE UPDATE OF line_user_id ON contact
  FOR EACH ROW EXECUTE FUNCTION contact_line_facts_reset();
ALTER TABLE contact DROP CONSTRAINT contact_has_email;
ALTER TABLE contact ADD CONSTRAINT contact_has_email CHECK (
  cardinality(emails) >= 1 OR line_user_id IS NOT NULL OR merged_into_contact_id IS NOT NULL
);
