-- T-201e: snooze with expiry, correlation, heartbeats (PRD R-3.6, R-3.9, R-3.10). Noise metrics (R-3.11)
-- are a read over `alert`, so they need nothing here. Reversible: 0043_alert_hygiene.down.sql.
--
--   alert.snoozed_by/_at     who snoozed it and when; `snoozed_until` and `snooze_reason` already exist (0041)
--                            and are now all set or all null, the reason between 3 and 500 characters.
--   alert.correlation_id     alerts the correlation engine grouped share one id (a proposal for an
--                            incident: nothing is created automatically, PRD section 5.3).
--   correlation_rule         "same service within N minutes, at least M alerts". One seeded default.
--   heartbeat                an expected periodic signal (a dead-man's switch). When it is missing for
--                            `expected_interval_seconds + grace_seconds` of the DATABASE clock it opens an
--                            alert (source `heartbeat`); the next beat resolves it.
--   alert.source / alert_event.source gain `heartbeat`.
--
-- Clock: every deadline here is compared with the database clock inside the statement that decides.

ALTER TABLE alert ADD COLUMN snoozed_by uuid REFERENCES users (id) ON DELETE SET NULL;
-- When the snooze began: the escalation is paused for as long as the snooze lasts, and this is where
-- "how much time was left" is measured from.
ALTER TABLE alert ADD COLUMN snoozed_at timestamptz;
-- A snooze written before this migration (nothing in 0041 wrote one) has no start: it starts now.
UPDATE alert SET snoozed_at = clock_timestamp() WHERE snoozed_until IS NOT NULL;
ALTER TABLE alert ADD CONSTRAINT alert_snooze_pair CHECK (
  (snoozed_until IS NULL) = (snooze_reason IS NULL) AND (snoozed_until IS NULL) = (snoozed_at IS NULL)
);
ALTER TABLE alert ADD CONSTRAINT alert_snooze_reason_len
  CHECK (snooze_reason IS NULL OR length(btrim(snooze_reason)) BETWEEN 3 AND 500);
CREATE INDEX alert_snoozed_idx ON alert (snoozed_until) WHERE snoozed_until IS NOT NULL AND state <> 'resolved';

ALTER TABLE alert ADD COLUMN correlation_id uuid;
CREATE INDEX alert_correlation_idx ON alert (correlation_id) WHERE correlation_id IS NOT NULL;

ALTER TABLE alert DROP CONSTRAINT alert_source_check;
ALTER TABLE alert ADD CONSTRAINT alert_source_check
  CHECK (source IN ('gcp_monitoring', 'gcp_logging', 'alertmanager', 'heartbeat'));
ALTER TABLE alert_event DROP CONSTRAINT alert_event_source_check;
ALTER TABLE alert_event ADD CONSTRAINT alert_event_source_check
  CHECK (source IN ('gcp_monitoring', 'gcp_logging', 'alertmanager', 'heartbeat'));

CREATE TABLE correlation_rule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  -- Only `same_service` exists: alerts of one service. (Same organization does not apply to
  -- infrastructure alerts; same deploy window arrives with the deploy feed, T-202d.)
  kind text NOT NULL DEFAULT 'same_service',
  window_minutes integer NOT NULL,
  min_alerts integer NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT correlation_rule_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT correlation_rule_kind_check CHECK (kind IN ('same_service')),
  CONSTRAINT correlation_rule_window_check CHECK (window_minutes BETWEEN 1 AND 1440),
  CONSTRAINT correlation_rule_min_check CHECK (min_alerts BETWEEN 2 AND 50)
);
CREATE UNIQUE INDEX correlation_rule_name_key ON correlation_rule (lower(name));
-- [ASSUMED] 2 alerts of one service within 10 minutes; po confirms.
INSERT INTO correlation_rule (name, kind, window_minutes, min_alerts)
VALUES ('Same service', 'same_service', 10, 2);

CREATE TABLE heartbeat (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  name text NOT NULL,
  expected_interval_seconds integer NOT NULL,
  grace_seconds integer NOT NULL DEFAULT 0,
  severity text NOT NULL DEFAULT 'error',
  service_id uuid REFERENCES service (id) ON DELETE SET NULL,
  active boolean NOT NULL DEFAULT true,
  state text NOT NULL DEFAULT 'ok',
  last_beat_at timestamptz,
  missing_since timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT heartbeat_slug_check CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) BETWEEN 2 AND 64),
  CONSTRAINT heartbeat_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT heartbeat_interval_check CHECK (expected_interval_seconds BETWEEN 30 AND 604800),
  CONSTRAINT heartbeat_grace_check CHECK (grace_seconds BETWEEN 0 AND 86400),
  CONSTRAINT heartbeat_severity_check CHECK (severity IN ('critical', 'error', 'warning', 'info')),
  CONSTRAINT heartbeat_state_check CHECK (state IN ('ok', 'missing')),
  CONSTRAINT heartbeat_missing_check CHECK ((state = 'missing') = (missing_since IS NOT NULL))
);
CREATE UNIQUE INDEX heartbeat_slug_key ON heartbeat (slug);
-- The sweep: active heartbeats that are `ok`, by the time they were last heard of.
CREATE INDEX heartbeat_watch_idx ON heartbeat (COALESCE(last_beat_at, created_at)) WHERE active AND state = 'ok';
