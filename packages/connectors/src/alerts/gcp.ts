import {
  allowedLabels,
  sanitizeAlertPayload,
  type AlertSeverity,
  type AlertSource,
  type NormalizedAlert,
} from '@watchtower/shared';

import { alertFingerprint } from './fingerprint.js';
import { isoFromUnixSeconds, rejected, safeHttpUrl, type NormalizeResult } from './types.js';

/**
 * Cloud Monitoring alert notification delivered through a Pub/Sub notification channel
 * (R-3.1, R-3.2).
 *
 * Shape `[CONFIRMED]` against https://docs.cloud.google.com/monitoring/support/notification-options
 * (read 2026-11-02): `{ "version": "1.2", "incident": { incident_id, scoping_project_id, url,
 * started_at, ended_at, state ("open" | "closed"), summary, observed_value, resource { type, labels },
 * resource_type_display_name, resource_id, resource_display_name, resource_name, metric { type,
 * displayName, labels }, metadata, policy_name, policy_user_labels, documentation, condition,
 * condition_name, severity, threshold_value, renotify } }`. Timestamps are unix epoch seconds. The
 * page says `summary`, `documentation.content` and `url` may not be parsed, only passed on whole, so
 * this code never parses them (and never stores `documentation`).
 *
 * `[VERIFY]` a log-based alert (R-3.2) reaches the same channel; the pages read do not show its
 * payload. This code treats the incident as a log match when `condition.conditionMatchedLog` is
 * present (the field name of the Monitoring API `Condition` resource) and otherwise as a metric
 * alert. Check against a real log-based notification before going live.
 *
 * Pure: no I/O. The caller passes the Pub/Sub `messageId`, which is the idempotency key: Pub/Sub
 * redelivers a message with the same id, and two real fires carry two ids.
 */

type Json = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown, max = 500): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, max);
};

/** String labels only; a nested or numeric value is stringified or dropped. */
function stringLabels(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const [key, label] of Object.entries(value)) {
    if (typeof label === 'string') out[key] = label;
    else if (typeof label === 'number' || typeof label === 'boolean') out[key] = String(label);
  }
  return out;
}

const SEVERITIES: Readonly<Record<string, AlertSeverity>> = {
  critical: 'critical',
  error: 'error',
  warning: 'warning',
  info: 'info',
};

/** GCP says "no severity" when none is set `[CONFIRMED]`; anything we do not know stays `unknown`. */
export function gcpSeverity(value: unknown): AlertSeverity {
  return typeof value === 'string'
    ? (SEVERITIES[value.trim().toLowerCase()] ?? 'unknown')
    : 'unknown';
}

/** The text inside a Pub/Sub push `message.data` (base64, standard or url-safe alphabet). */
export function decodePubsubText(data: string): string {
  return Buffer.from(data, 'base64').toString('utf8');
}

export interface GcpDelivery {
  /** Pub/Sub `message.messageId`. Absent only in tools that replay a bare payload. */
  readonly messageId?: string | undefined;
}

/** `data` is the decoded Pub/Sub message data (a JSON text) or the parsed object. */
export function normalizeGcpAlert(data: unknown, delivery: GcpDelivery = {}): NormalizeResult {
  let body: unknown = data;
  if (typeof data === 'string') {
    try {
      body = JSON.parse(data);
    } catch {
      return rejected('not_json');
    }
  }
  if (!isRecord(body) || !isRecord(body.incident)) return rejected('invalid_shape');
  const version = typeof body.version === 'string' ? body.version : '';
  // The documented default is 1.2; a different major version is a different format.
  if (!/^1\.\d+$/.test(version)) return rejected('unsupported_version');

  const incident = body.incident;
  const incidentId = text(incident.incident_id, 200);
  if (incidentId === null) return rejected('invalid_shape');
  const rawState = text(incident.state, 20)?.toLowerCase();
  if (rawState !== 'open' && rawState !== 'closed') return rejected('unknown_state');
  const policyName = text(incident.policy_name, 200);
  if (policyName === null) return rejected('missing_name');

  const resource = isRecord(incident.resource) ? incident.resource : {};
  const resourceLabels = stringLabels(resource.labels);
  const resourceType = text(resource.type, 100) ?? '';
  const userLabels = stringLabels(incident.policy_user_labels);
  const condition = isRecord(incident.condition) ? incident.condition : {};
  const conditionName = text(incident.condition_name, 200) ?? text(condition.displayName, 200);
  const isLogMatch = isRecord(condition.conditionMatchedLog);
  const source: AlertSource = isLogMatch ? 'gcp_logging' : 'gcp_monitoring';

  const state = rawState === 'closed' ? 'resolved' : 'firing';
  const renotify = incident.renotify === true;
  const startedAt = isoFromUnixSeconds(incident.started_at);
  const endedAt = isoFromUnixSeconds(incident.ended_at);
  const occurredAt = state === 'resolved' ? (endedAt ?? startedAt) : startedAt;

  const providerEventId =
    delivery.messageId !== undefined && delivery.messageId !== ''
      ? delivery.messageId.slice(0, 300)
      : // No Pub/Sub id (a replayed payload): the content is the best identity there is.
        [
          incidentId,
          rawState,
          renotify ? 'renotify' : 'first',
          startedAt ?? '',
          endedAt ?? '',
        ].join('|');

  const summary = text(incident.summary, 500);
  const url = safeHttpUrl(incident.url);
  const labels = allowedLabels({ ...userLabels, ...resourceLabels });
  const metric = isRecord(incident.metric) ? incident.metric : {};

  const alert: NormalizedAlert = {
    source,
    providerEventId,
    fingerprint: alertFingerprint({
      source,
      name: policyName,
      condition: conditionName ?? '',
      resourceType,
      labels: resourceLabels,
    }),
    state,
    severity: gcpSeverity(incident.severity),
    title: policyName,
    summary,
    conditionName,
    labels,
    url,
    occurredAt,
    renotify,
    payload: sanitizeAlertPayload({
      kind: source,
      policyName,
      conditionName,
      summary,
      url,
      resourceType,
      resourceName: text(incident.resource_name, 200),
      resourceDisplayName: text(incident.resource_display_name, 200),
      metricType: text(metric.type, 200),
      observedValue: text(incident.observed_value, 100),
      thresholdValue: text(incident.threshold_value, 100),
      incidentId,
      scopingProjectId: text(incident.scoping_project_id, 100),
      providerSeverity: text(incident.severity, 50),
      startedAt,
      endedAt,
      renotify,
      labels: resourceLabels,
      userLabels,
    }),
  };
  return { ok: true, alert };
}
