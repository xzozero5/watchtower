-- Reverses 0081. ai_run is append-only, so this fails by design while any row says `claude-cli`;
-- those rows are audit evidence and are not rewritten.
ALTER TABLE ai_run DROP CONSTRAINT ai_run_provider_check;
ALTER TABLE ai_run ADD CONSTRAINT ai_run_provider_check
  CHECK (provider IN ('mock', 'anthropic', 'vertex'));
