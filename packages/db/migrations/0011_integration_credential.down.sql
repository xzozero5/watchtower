-- Reverts 0010. Lossy on purpose: every stored integration credential is dropped (the people who
-- own the integrations enter them again). channel_account.config_encrypted comes back empty.
ALTER TABLE channel_account ADD COLUMN config_encrypted bytea;
DROP TABLE IF EXISTS integration_credential;
