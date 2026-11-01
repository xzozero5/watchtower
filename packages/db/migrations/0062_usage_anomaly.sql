-- T-205c: a usage anomaly becomes an alert and an internal ticket (PRD R-8.3). Reversible:
-- 0062_usage_anomaly.down.sql.
--
--   usage_anomaly   one row per anomaly the rule found. UNIQUE (dedupe_key) is the dedupe: the key names the
--                   metric, the dimension set and the UTC day of the hour that tripped the rule, so the same
--                   series raises one alert and one ticket a day however many runs see it. It also makes a run
--                   that is repeated (or two workers racing) harmless. `alert_id` and `ticket_id` are what the
--                   anomaly opened; the ticket exists only for a series that has an organization.
--   alert.source / alert_event.source gain 'usage_anomaly'.
--
-- Clock: created_at is the database clock; so are the bucket and the day the rule is evaluated against.

CREATE TABLE usage_anomaly (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  metric_id uuid NOT NULL REFERENCES usage_metric_def (id) ON DELETE CASCADE,
  org_id uuid REFERENCES organization (id) ON DELETE CASCADE,
  dims_hash text NOT NULL,
  dims jsonb NOT NULL DEFAULT '{}'::jsonb,
  bucket_ts timestamptz NOT NULL,
  observed double precision NOT NULL,
  baseline double precision NOT NULL,
  -- How many same-hour samples of the previous seven days the median was taken over.
  baseline_samples smallint NOT NULL,
  dedupe_key text NOT NULL,
  alert_id uuid REFERENCES alert (id) ON DELETE SET NULL,
  ticket_id uuid REFERENCES ticket (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT usage_anomaly_dedupe_key UNIQUE (dedupe_key),
  CONSTRAINT usage_anomaly_hash_check CHECK (dims_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT usage_anomaly_samples_check CHECK (baseline_samples BETWEEN 1 AND 7)
);
CREATE INDEX usage_anomaly_list_idx ON usage_anomaly (created_at DESC, id DESC);
CREATE INDEX usage_anomaly_org_idx ON usage_anomaly (org_id, created_at DESC) WHERE org_id IS NOT NULL;
CREATE INDEX usage_anomaly_metric_idx ON usage_anomaly (metric_id, created_at DESC);

ALTER TABLE alert DROP CONSTRAINT alert_source_check;
ALTER TABLE alert ADD CONSTRAINT alert_source_check
  CHECK (source IN ('gcp_monitoring', 'gcp_logging', 'alertmanager', 'heartbeat', 'usage_anomaly'));
ALTER TABLE alert_event DROP CONSTRAINT alert_event_source_check;
ALTER TABLE alert_event ADD CONSTRAINT alert_event_source_check
  CHECK (source IN ('gcp_monitoring', 'gcp_logging', 'alertmanager', 'heartbeat', 'usage_anomaly'));
