-- Reverts 0043. Lossy on purpose: correlation groups, snooze records, heartbeats and the alerts they
-- raised go away (the narrower source CHECK cannot hold a `heartbeat` alert).
DROP TABLE IF EXISTS heartbeat;
DROP TABLE IF EXISTS correlation_rule;
DELETE FROM alert_event WHERE source = 'heartbeat';
DELETE FROM alert WHERE source = 'heartbeat';
ALTER TABLE alert_event DROP CONSTRAINT alert_event_source_check;
ALTER TABLE alert_event ADD CONSTRAINT alert_event_source_check
  CHECK (source IN ('gcp_monitoring', 'gcp_logging', 'alertmanager'));
ALTER TABLE alert DROP CONSTRAINT alert_source_check;
ALTER TABLE alert ADD CONSTRAINT alert_source_check
  CHECK (source IN ('gcp_monitoring', 'gcp_logging', 'alertmanager'));
DROP INDEX IF EXISTS alert_correlation_idx;
ALTER TABLE alert DROP COLUMN IF EXISTS correlation_id;
DROP INDEX IF EXISTS alert_snoozed_idx;
ALTER TABLE alert DROP CONSTRAINT IF EXISTS alert_snooze_reason_len;
ALTER TABLE alert DROP CONSTRAINT IF EXISTS alert_snooze_pair;
-- Snoozes are lost with their start time (lossy on purpose), so the constraint can come back on the way up.
UPDATE alert SET snoozed_until = NULL, snooze_reason = NULL WHERE snoozed_until IS NOT NULL;
ALTER TABLE alert DROP COLUMN IF EXISTS snoozed_at;
ALTER TABLE alert DROP COLUMN IF EXISTS snoozed_by;
