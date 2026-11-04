-- T-305b (PRD 9.2): data points of the pluggable CEO tiles (platform uptime from monitoring, revenue, churn):
-- numbers the system does not compute, fed by the API or a CSV import. One row per (metric, instant); the
-- tile shows the newest point and the one before it. A head records them (`metric.manage`), audited.
-- Reversible: see 0099_ceo_external_point.down.sql.

CREATE TABLE ceo_external_point (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  metric_key text NOT NULL,
  label text NOT NULL,
  unit text NOT NULL DEFAULT '',
  higher_is_better boolean NOT NULL DEFAULT true,
  value double precision NOT NULL,
  observed_at timestamptz NOT NULL,
  -- api | csv
  source text NOT NULL,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ceo_external_point_key_check CHECK (metric_key ~ '^[a-z0-9][a-z0-9_.-]{0,62}$'),
  CONSTRAINT ceo_external_point_label_check CHECK (length(label) BETWEEN 1 AND 80),
  CONSTRAINT ceo_external_point_unit_check CHECK (length(unit) <= 16),
  CONSTRAINT ceo_external_point_source_check CHECK (source IN ('api', 'csv')),
  CONSTRAINT ceo_external_point_value_check CHECK (abs(value) < 1e300),
  CONSTRAINT ceo_external_point_key_time_key UNIQUE (metric_key, observed_at)
);
CREATE INDEX ceo_external_point_latest_idx ON ceo_external_point (metric_key, observed_at DESC);
