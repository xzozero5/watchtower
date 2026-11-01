# connectors/alerts

Pure normalizers from a provider's alert notification to the one `NormalizedAlert` the domain takes
(`packages/shared/src/features/alerts.ts`). No I/O, no secret, no network (tests run under
`disableNetConnect` and assert nothing tried). ADR-015.

| Source | Function | Input | Idempotency key (`providerEventId`) |
|---|---|---|---|
| `gcp_monitoring` | `normalizeGcpAlert` | Pub/Sub `message.data` (Cloud Monitoring notification JSON v1.2) | Pub/Sub `messageId` |
| `gcp_logging` | `normalizeGcpAlert` | same envelope, `condition.conditionMatchedLog` present | Pub/Sub `messageId` |
| `alertmanager` | `normalizeAlertmanager` | webhook body, payload version 4 | `fingerprint(32) \| startsAt \| status \| endsAt (resolved only)` |

`signAlertWebhook` / `verifyAlertWebhook` implement the signature of the generic webhook
(`X-Watchtower-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>." + raw body>`).

## What is stored (N4)

`alert.payload` keeps the keys in `ALERT_PAYLOAD_KEYS` and the label keys in `ALERT_LABEL_KEYS` only.
`documentation`, free-form annotations, request URLs and every other label are dropped (they still
feed the fingerprint, so alerts that differ by a dropped label stay apart). The fixtures plant fake
personal data (an email label, a customer policy label, a documentation block) and the tests prove
none of it survives.

## Sources and dates

Checked against the official documentation on **2026-11-02**:

- Cloud Monitoring notification channels, Pub/Sub payload, version 1.2 (field list, `state` open or
  closed, timestamps in epoch seconds, "do not parse `summary`, `documentation.content`, `url`"):
  https://docs.cloud.google.com/monitoring/support/notification-options `[CONFIRMED]` (the page shows the
  schema as a field list; the fixtures are synthetic documents built from that list, not copies)
- Log-based alerting policies (auto-close after 7 days by default, repeat notifications at least
  5 minutes apart, 20 new alerts per day and 2 per minute per policy):
  https://docs.cloud.google.com/logging/docs/alerting/monitoring-logs `[CONFIRMED]`
- Alertmanager `webhook_config`, payload version "4" (`send_resolved` default true; `http_config`
  offers basic auth and an `Authorization` header, no body signing):
  https://prometheus.io/docs/alerting/latest/configuration/ `[CONFIRMED]`

## Not confirmed

- `[VERIFY]` The payload of a **log-based** alert on the Pub/Sub channel is not shown by the pages
  read. The code assumes the same v1.2 envelope and recognizes it by `condition.conditionMatchedLog`
  (the Monitoring API field name). Compare with a real notification before going live (`[ASK-HUMAN]`).
- `[VERIFY]` Whether Cloud Monitoring repeats an open incident as a message with `renotify: true` and
  the same `incident_id` (the schema has the field; the exact conditions were not read).
- `[ASSUMED]` Alertmanager `severity` label values `critical|error|warning|info`; anything else is
  `unknown`.
- `[VERIFY]` Alertmanager cannot sign the body; a relay that adds `X-Watchtower-Signature` is needed
  (or the owner decides to accept a bearer token instead).
