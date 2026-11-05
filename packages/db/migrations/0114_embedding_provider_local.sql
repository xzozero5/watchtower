-- ADR-030 (T-430): `local` becomes a provider kind for knowledge base embeddings: the Ollama
-- `embedder` service of this deployment. It appears in kb_embedding_index (which model made the
-- vectors) and in ai_run (the audit row of each embedding call). Only the two CHECK lists change.
-- Reversible: see 0114_embedding_provider_local.down.sql.

ALTER TABLE kb_embedding_index DROP CONSTRAINT kb_embedding_index_provider_check;
ALTER TABLE kb_embedding_index ADD CONSTRAINT kb_embedding_index_provider_check
  CHECK (provider IN ('mock', 'anthropic', 'vertex', 'local'));

ALTER TABLE ai_run DROP CONSTRAINT ai_run_provider_check;
ALTER TABLE ai_run ADD CONSTRAINT ai_run_provider_check
  CHECK (provider IN ('mock', 'anthropic', 'vertex', 'claude-cli', 'local'));
