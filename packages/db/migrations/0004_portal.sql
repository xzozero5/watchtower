-- T-007: client portal (PRD section 4.9, ADR-007).
--   portal_access_token: the tracking links we email to a customer. The token itself is never
--   stored, only its SHA-256, so a database dump cannot open a ticket. A token belongs to one
--   ticket and one contact, expires, and can be revoked by staff.
-- Reversible: see 0004_portal.down.sql.

CREATE TABLE portal_access_token (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES ticket (id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contact (id) ON DELETE CASCADE,
  -- SHA-256 of the whole token (hex). Looked up on every portal request.
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT portal_access_token_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT portal_access_token_expiry_check CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX portal_access_token_hash_key ON portal_access_token (token_hash);
CREATE INDEX portal_access_token_ticket_idx ON portal_access_token (ticket_id);
CREATE INDEX portal_access_token_contact_idx ON portal_access_token (contact_id);
-- Housekeeping: expired rows are deleted when a new link is issued for the same ticket.
CREATE INDEX portal_access_token_expiry_idx ON portal_access_token (expires_at);
