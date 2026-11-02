-- product_mock: invented product data for the data tool (T-203c) and the usage metrics (T-205).
-- It stands in for a customer's product database. Everything here is made up (N1): no real company,
-- host or person. Loaded into a database of its own, never into the Watchtower database.
--
-- Three tables, two of which hold personal data on purpose so the guardrails have something to hide:
--   tenants.display_name, tenants.contact_email, jobs.submitted_by  (not readable by the read-only role)

CREATE TABLE tenants (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  contact_email text NOT NULL,
  plan text NOT NULL,
  region text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One row per tenant, day and kind of event.
CREATE TABLE api_daily (
  tenant_id text NOT NULL REFERENCES tenants (id),
  day date NOT NULL,
  event_type text NOT NULL,
  requests integer NOT NULL,
  failed integer NOT NULL,
  p95_ms integer NOT NULL,
  PRIMARY KEY (tenant_id, day, event_type),
  CONSTRAINT api_daily_counts_check CHECK (requests >= 0 AND failed >= 0 AND failed <= requests)
);

CREATE TABLE jobs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants (id),
  submitted_at timestamptz NOT NULL,
  kind text NOT NULL,
  status text NOT NULL,
  duration_ms integer NOT NULL,
  submitted_by text NOT NULL,
  CONSTRAINT jobs_status_check CHECK (status IN ('ok', 'failed', 'timeout'))
);
CREATE INDEX jobs_tenant_time_idx ON jobs (tenant_id, submitted_at DESC);
