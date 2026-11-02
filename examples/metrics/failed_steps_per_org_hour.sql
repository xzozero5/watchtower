-- Failed processing steps per organization, flow and step, per hour (PRD R-8.1, starter set).
-- Read-only, bound to the window: $1 = from, $2 = to (timestamptz). No value is ever written into this text.
-- Returns exactly: ts (an hour boundary), value, and the declared dimensions org, flow, step.
SELECT
  date_trunc('hour', started_at) AS ts,
  org_id AS org,
  flow,
  step,
  count(*) AS value
FROM product_mock.flow_run
WHERE status = 'failed'
  AND started_at >= $1
  AND started_at < $2
GROUP BY 1, 2, 3, 4
