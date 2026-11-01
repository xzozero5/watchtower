-- T-116a: integration credential store (ADR-012, amends ADR-004).
--   integration_credential: one row per (integration, field). The value is encrypted with a data key
--   of its own (AES-256-GCM, done by the application); the data key is wrapped by a key-encryption
--   key derived from APP_ENCRYPTION_KEY. key_version says which one. There is no plaintext column,
--   no hash of the value and no length. Which integrations and fields exist is decided by the code
--   (INTEGRATION_CATALOG in @watchtower/shared); the check constraints only keep names sane.
--   channel_account.config_encrypted is dropped: nothing ever wrote or read it, and a second place
--   for ciphertext with no key version would invite someone to use it. The migration refuses to run
--   if any row holds data there, rather than lose it silently.
-- The application role gets SELECT, INSERT, UPDATE and DELETE from the default privileges of 0001.
-- Reversible: see 0010_integration_credential.down.sql.

CREATE TABLE integration_credential (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration text NOT NULL,
  field text NOT NULL,
  -- AES-256-GCM of the value under the data key: v1.<iv>.<ciphertext>.<tag>.
  value_sealed text NOT NULL,
  -- The data key, AES-256-GCM under the key-encryption key of key_version.
  dek_wrapped text NOT NULL,
  key_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT integration_credential_integration_check CHECK (integration ~ '^[a-z][a-z0-9_]{0,39}$'),
  CONSTRAINT integration_credential_field_check CHECK (field ~ '^[A-Za-z][A-Za-z0-9]{0,59}$'),
  CONSTRAINT integration_credential_key_version_check CHECK (key_version >= 1)
);
CREATE UNIQUE INDEX integration_credential_field_key ON integration_credential (integration, field);
-- `credentials rotate` looks for rows that are not on the current key version.
CREATE INDEX integration_credential_key_version_idx ON integration_credential (key_version);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM channel_account WHERE config_encrypted IS NOT NULL) THEN
    RAISE EXCEPTION 'channel_account.config_encrypted holds data; move it to integration_credential before applying 0010'
      USING ERRCODE = 'restrict_violation';
  END IF;
END
$$;
ALTER TABLE channel_account DROP COLUMN config_encrypted;
