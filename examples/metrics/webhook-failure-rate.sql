-- Saved query: failure rate of one tenant's webhook deliveries, per day, last 14 days.
-- Parameter: {{tenant_id}} (becomes $1).
SELECT day,
       event_type,
       requests,
       failed,
       round(failed::numeric / NULLIF(requests, 0), 4) AS ratio
FROM api_daily
WHERE tenant_id = {{tenant_id}}
  AND event_type = 'webhook_delivery'
  AND day >= current_date - 14
ORDER BY day DESC
