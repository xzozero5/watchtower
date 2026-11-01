-- 95th percentile latency (ms) per flow, per hour. Not per organization: this metric has no org dimension.
-- Read-only, bound to the window: $1 = from, $2 = to (timestamptz).
-- Returns exactly: ts (an hour boundary), value, and the declared dimension flow.
SELECT
  date_trunc('hour', started_at) AS ts,
  flow,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS value
FROM product_mock.flow_run
WHERE started_at >= $1
  AND started_at < $2
GROUP BY 1, 2
