-- Core transactions (finished flow runs) per organization, per hour. A drop is the problem: direction 'down'.
-- Read-only, bound to the window: $1 = from, $2 = to (timestamptz).
-- Returns exactly: ts (an hour boundary), value, and the declared dimension org.
SELECT
  date_trunc('hour', started_at) AS ts,
  org_id AS org,
  count(*) AS value
FROM product_mock.flow_run
WHERE started_at >= $1
  AND started_at < $2
GROUP BY 1, 2
