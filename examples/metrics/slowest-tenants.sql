-- Saved query: tenants ordered by p95 latency of one kind of event yesterday. No parameter.
SELECT tenant_id,
       event_type,
       p95_ms,
       requests
FROM api_daily
WHERE day = current_date - 1
  AND event_type = 'webhook_delivery'
ORDER BY p95_ms DESC
LIMIT 20
