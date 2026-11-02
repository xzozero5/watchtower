-- Reverts 0062. Lossy on purpose: the anomaly records go away, and so do the alerts they raised (the narrower
-- source CHECK cannot hold a 'usage_anomaly' alert). Tickets an anomaly opened stay as ordinary internal tickets.
DROP TABLE IF EXISTS usage_anomaly;
DELETE FROM alert_event WHERE source = 'usage_anomaly';
DELETE FROM alert WHERE source = 'usage_anomaly';
ALTER TABLE alert_event DROP CONSTRAINT alert_event_source_check;
ALTER TABLE alert_event ADD CONSTRAINT alert_event_source_check
  CHECK (source IN ('gcp_monitoring', 'gcp_logging', 'alertmanager', 'heartbeat'));
ALTER TABLE alert DROP CONSTRAINT alert_source_check;
ALTER TABLE alert ADD CONSTRAINT alert_source_check
  CHECK (source IN ('gcp_monitoring', 'gcp_logging', 'alertmanager', 'heartbeat'));
