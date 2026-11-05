-- ADR-031: vendor-neutral CLI bridge. Preserve historical Claude and local embedding audits.
ALTER TABLE ai_run DROP CONSTRAINT ai_run_provider_check;
ALTER TABLE ai_run ADD CONSTRAINT ai_run_provider_check
  CHECK (provider IN ('mock', 'anthropic', 'vertex', 'claude-cli', 'ai-cli', 'local'));
