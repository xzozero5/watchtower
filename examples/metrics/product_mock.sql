-- A stand-in for the product database, for development and tests (T-205a). Fictional data only: the
-- organizations are whatever ids you pass, the flows and steps are generic. Nothing here is real and
-- nothing is copied from any product.
--
-- Load it into a database that is NOT Watchtower's (the mock product database T-203c uses), then:
--
--   SELECT product_mock.seed(ARRAY['<org uuid>', '<org uuid>']::uuid[]);
--
-- It writes eight days of hourly runs up to the last COMPLETE hour for each organization, relative to
-- the moment you call it (so the data is always fresh), and gives the SECOND organization an anomaly in
-- the last complete hour: its `charge` step fails about twenty times as often as in the week before.
-- The first organization stays normal. It clears the table first, so calling it again starts over.

CREATE SCHEMA IF NOT EXISTS product_mock;

CREATE TABLE IF NOT EXISTS product_mock.flow_run (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL,
  flow text NOT NULL,
  step text NOT NULL,
  status text NOT NULL CHECK (status IN ('success', 'failed')),
  started_at timestamptz NOT NULL,
  latency_ms integer NOT NULL
);
CREATE INDEX IF NOT EXISTS flow_run_started_idx ON product_mock.flow_run (started_at);

CREATE OR REPLACE FUNCTION product_mock.seed(orgs uuid[]) RETURNS integer
LANGUAGE plpgsql
AS $fn$
DECLARE
  last_hour timestamptz := date_trunc('hour', clock_timestamp()) - interval '1 hour';
  first_hour timestamptz := date_trunc('hour', clock_timestamp()) - interval '8 days';
  h timestamptz;
  o integer;
  s text;
  n integer;
  failed integer;
  total integer := 0;
BEGIN
  TRUNCATE product_mock.flow_run;
  FOR o IN 1..cardinality(orgs) LOOP
    h := first_hour;
    WHILE h <= last_hour LOOP
      FOREACH s IN ARRAY ARRAY['charge', 'confirm'] LOOP
        -- Ordinary traffic: 40 to 60 runs an hour; 2 to 4 of them fail.
        n := 40 + (2 * extract(hour FROM h)::int) % 20;
        failed := 2 + (extract(hour FROM h)::int + o) % 3;
        -- The anomaly: the second organization's charge step in the last complete hour.
        IF o = 2 AND s = 'charge' AND h = last_hour THEN
          failed := 60;
          n := n + 60;
        END IF;
        INSERT INTO product_mock.flow_run (org_id, flow, step, status, started_at, latency_ms)
        SELECT orgs[o], 'checkout', s,
               CASE WHEN g <= failed THEN 'failed' ELSE 'success' END,
               h + make_interval(secs => g * 30),
               100 + (g * 7) % 80
        FROM generate_series(1, n) AS g;
        total := total + n;
      END LOOP;
      h := h + interval '1 hour';
    END LOOP;
  END LOOP;
  RETURN total;
END
$fn$;
