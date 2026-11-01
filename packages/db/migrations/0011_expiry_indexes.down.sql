-- Reverts 0011: only indexes, nothing is lost.
DROP INDEX IF EXISTS break_glass_attempt_last_failed_idx;
DROP INDEX IF EXISTS portal_access_token_revoked_idx;
DROP INDEX IF EXISTS magic_link_tokens_consumed_idx;
DROP INDEX IF EXISTS magic_link_tokens_expires_idx;
DROP INDEX IF EXISTS refresh_tokens_expires_idx;
DROP INDEX IF EXISTS sessions_revoked_idx;
DROP INDEX IF EXISTS sessions_expires_idx;
