-- Reverses 0114. ai_run is append-only, so the ai_run part fails by design while any row says
-- `local` (audit evidence is not rewritten). kb_embedding_index rows of `local` are derived data:
-- their chunks are detached and the index rows removed first, so a later `reembed_all` refills them.
UPDATE kb_chunk SET embedding = NULL, embedding_index_id = NULL
  WHERE embedding_index_id IN (SELECT id FROM kb_embedding_index WHERE provider = 'local');
DELETE FROM kb_embedding_index WHERE provider = 'local';

ALTER TABLE kb_embedding_index DROP CONSTRAINT kb_embedding_index_provider_check;
ALTER TABLE kb_embedding_index ADD CONSTRAINT kb_embedding_index_provider_check
  CHECK (provider IN ('mock', 'anthropic', 'vertex'));

ALTER TABLE ai_run DROP CONSTRAINT ai_run_provider_check;
ALTER TABLE ai_run ADD CONSTRAINT ai_run_provider_check
  CHECK (provider IN ('mock', 'anthropic', 'vertex', 'claude-cli'));
