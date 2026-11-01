-- T-205a: product usage metrics (PRD R-8.1, R-8.5). Reversible: 0061_usage_metrics.down.sql.
--
--   usage_metric_def    what to measure: a read-only SQL template run against the product data by the worker,
--                       the dimensions it may return (and no others), its refresh interval and the anomaly rule.
--                       Only a head edits a template (metric.manage); every edit bumps `template_version` and is
--                       audited with the hash of the old and the new text. The template is SQL and never holds a
--                       value: the window is bound as $1 (from) and $2 (to).
--   usage_metric_point  the result, cached in Watchtower's own database so no dashboard reads the product data on
--                       a page load. One row per (metric, hour, dimension set). Partitioned by month on `ts`
--                       (migration 0001 has the helper) and NOT append-only: a run again over the same window
--                       replaces the value (upsert), which is what makes the scheduler idempotent.
--                       `org_id` is the organization dimension when the metric has one (NULL otherwise), kept as a
--                       column so a client-scoped reader can filter on it; `dims_hash` is the SHA-256 of the
--                       canonical dimension set including the organization.
--
-- Clock: last_run_at and the point timestamps' bounds are decided with the database clock.

-- Declared dimension names: at most 6, distinct, lower snake case, and never the reserved result columns.
-- A function, because a CHECK cannot hold a subquery.
CREATE FUNCTION usage_dims_valid(dims text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $fn$
  SELECT cardinality(dims) <= 6
    AND array_position(dims, NULL) IS NULL
    AND NOT dims && ARRAY['ts', 'value']
    AND cardinality(dims) = (SELECT count(DISTINCT d) FROM unnest(dims) AS d)
    AND NOT EXISTS (SELECT 1 FROM unnest(dims) AS d WHERE d !~ '^[a-z][a-z0-9_]{0,30}$')
$fn$;

CREATE TABLE usage_metric_def (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  sql_template text NOT NULL,
  template_version integer NOT NULL DEFAULT 1,
  -- Dimension columns the template may return besides `ts` and `value`. `org` holds an organization id.
  dims text[] NOT NULL DEFAULT '{}',
  unit text NOT NULL DEFAULT 'count',
  refresh_interval_seconds integer NOT NULL DEFAULT 3600,
  -- 'up': a rise is the problem (errors); 'down': a drop is the problem (transactions).
  direction text NOT NULL DEFAULT 'up',
  -- Anomaly rule: observed > ratio x baseline AND observed - baseline > min_abs (mirrored for 'down').
  anomaly_ratio numeric(6, 2) NOT NULL DEFAULT 3,
  anomaly_min_abs numeric(14, 2) NOT NULL DEFAULT 10,
  active boolean NOT NULL DEFAULT true,
  last_run_at timestamptz,
  last_run_state text,
  last_run_error text,
  last_run_points integer,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT usage_metric_def_key_key UNIQUE (key),
  CONSTRAINT usage_metric_def_key_check CHECK (key ~ '^[a-z][a-z0-9_]{1,62}$'),
  CONSTRAINT usage_metric_def_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT usage_metric_def_description_check CHECK (length(description) <= 1000),
  CONSTRAINT usage_metric_def_template_check CHECK (length(btrim(sql_template)) BETWEEN 1 AND 8000),
  CONSTRAINT usage_metric_def_version_check CHECK (template_version >= 1),
  CONSTRAINT usage_metric_def_dims_check CHECK (usage_dims_valid(dims)),
  CONSTRAINT usage_metric_def_unit_check CHECK (length(btrim(unit)) BETWEEN 1 AND 30),
  CONSTRAINT usage_metric_def_refresh_check CHECK (refresh_interval_seconds BETWEEN 300 AND 86400),
  CONSTRAINT usage_metric_def_direction_check CHECK (direction IN ('up', 'down')),
  CONSTRAINT usage_metric_def_ratio_check CHECK (anomaly_ratio > 1),
  CONSTRAINT usage_metric_def_min_abs_check CHECK (anomaly_min_abs >= 0),
  CONSTRAINT usage_metric_def_run_state_check CHECK (last_run_state IS NULL OR last_run_state IN ('ok', 'failed')),
  CONSTRAINT usage_metric_def_run_error_check CHECK (last_run_error IS NULL OR length(last_run_error) <= 200)
);
CREATE INDEX usage_metric_def_due_idx ON usage_metric_def (last_run_at NULLS FIRST) WHERE active;

CREATE TABLE usage_metric_point (
  metric_id uuid NOT NULL REFERENCES usage_metric_def (id) ON DELETE CASCADE,
  ts timestamptz NOT NULL,
  dims_hash text NOT NULL,
  org_id uuid REFERENCES organization (id) ON DELETE CASCADE,
  dims jsonb NOT NULL DEFAULT '{}'::jsonb,
  value double precision NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (metric_id, ts, dims_hash),
  CONSTRAINT usage_metric_point_hash_check CHECK (dims_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT usage_metric_point_dims_object CHECK (jsonb_typeof(dims) = 'object'),
  CONSTRAINT usage_metric_point_hour_check CHECK ((ts AT TIME ZONE 'UTC') = date_trunc('hour', ts AT TIME ZONE 'UTC')),
  CONSTRAINT usage_metric_point_value_check CHECK (value <> 'NaN'::float8 AND abs(value) < 1e300)
) PARTITION BY RANGE (ts);

CREATE INDEX usage_metric_point_org_idx ON usage_metric_point (org_id, metric_id, ts DESC)
  WHERE org_id IS NOT NULL;

CREATE TABLE usage_metric_point_default PARTITION OF usage_metric_point DEFAULT;

SELECT ensure_monthly_partitions('usage_metric_point', 12, false);
