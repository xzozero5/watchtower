-- Reverts 0119.
REVOKE SELECT, INSERT, UPDATE, DELETE ON kb_version_chunk_manifest FROM watchtower_app, PUBLIC;
REVOKE SELECT, INSERT, UPDATE, DELETE ON kb_chunk_embedding FROM watchtower_app, PUBLIC;

DROP TABLE IF EXISTS kb_chunk_embedding;
DROP FUNCTION IF EXISTS kb_chunk_embedding_check();
DROP TABLE IF EXISTS kb_version_chunk_manifest;
DROP INDEX IF EXISTS kb_chunk_fingerprint_idx;
ALTER TABLE kb_chunk DROP COLUMN IF EXISTS chunk_set_fingerprint;
