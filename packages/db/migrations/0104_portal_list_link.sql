-- T-152: "email me a link to my requests" (PRD section 4.9, ADR-007).
--   portal_list_link: a one-time link, valid for a short while, that opens the read-only list of the
--   tickets of ONE contact. The token itself is never stored, only its SHA-256. The row is bound to the
--   contact and to a keyed tag (HMAC) of the address it was mailed to, so the link stops working if the
--   contact no longer owns that address. consumed_at is set once, atomically, when the link is opened.
-- Reversible: see 0104_portal_list_link.down.sql.

CREATE TABLE portal_list_link (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES contact (id) ON DELETE CASCADE,
  -- keyed tag of the lower-cased address (EmailTagService); never the address
  email_tag text NOT NULL,
  -- SHA-256 of the whole token (hex)
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT portal_list_link_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT portal_list_link_expiry_check CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX portal_list_link_hash_key ON portal_list_link (token_hash);
CREATE INDEX portal_list_link_contact_idx ON portal_list_link (contact_id) WHERE consumed_at IS NULL;
CREATE INDEX portal_list_link_expiry_idx ON portal_list_link (expires_at);
