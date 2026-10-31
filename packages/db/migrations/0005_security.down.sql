-- Reverts 0005. Lossy on purpose: lockout counters and the dev-created marks are dropped, and
-- outbox rows that were dead-lettered by the up migration stay dead.
DROP TABLE IF EXISTS break_glass_attempt;
DROP INDEX IF EXISTS outbox_expiry_idx;
ALTER TABLE outbox DROP COLUMN IF EXISTS expires_at;
ALTER TABLE users DROP COLUMN IF EXISTS dev_created;
