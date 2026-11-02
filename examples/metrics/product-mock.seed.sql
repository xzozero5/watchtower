-- Seed of product_mock (T-203c, T-205a). Deterministic: no random(); every number comes from the
-- tenant's number, the day offset and the kind of event. Days are relative to today, so there is
-- always recent data.
--
-- Anomaly on purpose (T-205c needs one to find): tenant t-003 fails about a third of its webhook
-- deliveries and slows down on each of the last two days. Every other tenant stays near 1 to 2 percent.

INSERT INTO tenants (id, display_name, contact_email, plan, region) VALUES
  ('t-001', 'Example Tenant One',   'admin1@example.com', 'standard',   'ap-southeast'),
  ('t-002', 'Example Tenant Two',   'admin2@example.com', 'standard',   'eu-west'),
  ('t-003', 'Example Tenant Three', 'admin3@example.com', 'enterprise', 'ap-southeast'),
  ('t-004', 'Example Tenant Four',  'admin4@example.com', 'enterprise', 'us-east'),
  ('t-005', 'Example Tenant Five',  'admin5@example.com', 'starter',    'eu-west');

INSERT INTO api_daily (tenant_id, day, event_type, requests, failed, p95_ms)
SELECT
  t.id,
  d.day,
  k.event_type,
  base.requests,
  CASE
    WHEN t.id = 't-003' AND k.event_type = 'webhook_delivery' AND d.age <= 2
      THEN (base.requests * 35) / 100
    ELSE (base.requests * (1 + (k.n + substring(t.id from 3)::int) % 2)) / 100
  END,
  CASE
    WHEN t.id = 't-003' AND k.event_type = 'webhook_delivery' AND d.age <= 2 THEN 9000 + d.age * 250
    ELSE 180 + k.n * 90 + (substring(t.id from 3)::int * 11) % 70 + (extract(dow FROM d.day)::int * 3)
  END
FROM tenants t
CROSS JOIN (
  SELECT (current_date - g.age)::date AS day, g.age
  FROM generate_series(1, 30) AS g (age)
) d
CROSS JOIN (VALUES (1, 'api_call'), (2, 'webhook_delivery'), (3, 'batch_job')) AS k (n, event_type)
CROSS JOIN LATERAL (
  SELECT (400 + substring(t.id from 3)::int * 120 + k.n * 150
          + (CASE WHEN extract(dow FROM d.day) IN (0, 6) THEN -120 ELSE 60 END))::int AS requests
) base;

INSERT INTO jobs (tenant_id, submitted_at, kind, status, duration_ms, submitted_by)
SELECT
  't-00' || (1 + g.n % 5),
  now() - make_interval(mins => g.n * 37),
  (ARRAY['export', 'import', 'report'])[1 + g.n % 3],
  CASE WHEN g.n % 11 = 0 THEN 'failed' WHEN g.n % 17 = 0 THEN 'timeout' ELSE 'ok' END,
  500 + (g.n * 97) % 4000,
  'person' || (g.n % 7) || '@example.com'
FROM generate_series(1, 200) AS g (n);
