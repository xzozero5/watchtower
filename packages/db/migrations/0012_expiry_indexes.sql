-- T-117: the worker's cleanup job (processors/cleanup.ts) deletes sessions, refresh tokens,
-- magic-link tokens, tracking links and break-glass counters that are past their expiry. These are
-- the columns it filters on. portal_access_token already has its expiry index (0004).
--   The partial indexes on revoked_at / consumed_at cover the second half of each OR condition and
--   only contain the rows that have the column set.
-- No GRANT: the application role already holds DELETE on all of these tables (default privileges of
-- 0001), which the integration tests check. Reversible: see 0012_expiry_indexes.down.sql.

CREATE INDEX sessions_expires_idx ON sessions (expires_at);
CREATE INDEX sessions_revoked_idx ON sessions (revoked_at) WHERE revoked_at IS NOT NULL;
CREATE INDEX refresh_tokens_expires_idx ON refresh_tokens (expires_at);
CREATE INDEX magic_link_tokens_expires_idx ON magic_link_tokens (expires_at);
CREATE INDEX magic_link_tokens_consumed_idx ON magic_link_tokens (consumed_at) WHERE consumed_at IS NOT NULL;
CREATE INDEX portal_access_token_revoked_idx ON portal_access_token (revoked_at) WHERE revoked_at IS NOT NULL;
CREATE INDEX break_glass_attempt_last_failed_idx ON break_glass_attempt (last_failed_at);
