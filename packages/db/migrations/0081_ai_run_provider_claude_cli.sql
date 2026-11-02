-- ADR-017: `claude-cli` becomes a provider kind in the AI audit trail (dev/POC only; the app refuses
-- AI_PROVIDER=claude-cli in production). Only the CHECK on ai_run changes; kb_embedding_index keeps
-- its list because embeddings never use this provider.
-- Reversible: see 0081_ai_run_provider_claude_cli.down.sql.

ALTER TABLE ai_run DROP CONSTRAINT ai_run_provider_check;
ALTER TABLE ai_run ADD CONSTRAINT ai_run_provider_check
  CHECK (provider IN ('mock', 'anthropic', 'vertex', 'claude-cli'));
