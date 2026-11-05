-- Reversal refuses while append-only ai-cli audit rows exist; audit evidence is never rewritten.
ALTER TABLE ai_run DROP CONSTRAINT ai_run_provider_check;
ALTER TABLE ai_run ADD CONSTRAINT ai_run_provider_check
  CHECK (provider IN ('mock', 'anthropic', 'vertex', 'claude-cli', 'local'));
