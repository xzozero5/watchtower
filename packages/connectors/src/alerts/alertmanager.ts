import {
  allowedLabels,
  sanitizeAlertPayload,
  type AlertSeverity,
  type NormalizedAlert,
} from '@watchtower/shared';

import { alertFingerprint } from './fingerprint.js';
import {
  isoFromRfc3339,
  rejected,
  safeHttpUrl,
  type NormalizeResult,
  type RejectReason,
} from './types.js';

/**
 * Alertmanager webhook payload, version "4" (R-3.3).
 *
 * Shape `[CONFIRMED]` against https://prometheus.io/docs/alerting/latest/configuration/ (webhook_config,
 * read 2026-11-02): `{ version, groupKey, truncatedAlerts, status ("resolved" | "firing"), receiver,
 * groupLabels, commonLabels, commonAnnotations, externalURL, alerts: [{ status, labels, annotations,
 * startsAt, endsAt, generatorURL, fingerprint }] }`. `send_resolved` defaults to true. One request can
 * carry many alerts, so this returns one result per alert.
 *
 * Idempotency key: our fingerprint, `startsAt` and the status (plus `endsAt` for a resolved alert).
 * Alertmanager repeats a firing alert every `repeat_interval` with the same `startsAt`; that repeat is
 * not a new fire. `endsAt` of a firing alert is a moving placeholder, so it is left out of the key.
 *
 * The fingerprint is ours (SHA-256 of the whole label set), not the `fingerprint` field of the payload:
 * Alertmanager's own value is a hash of unspecified stability across versions `[VERIFY]`. The provider's
 * value is kept in the payload as `providerFingerprint`.
 *
 * Alertmanager itself can only send a static `Authorization` header, not sign the body, so the HMAC
 * the receiver checks (see `signature.ts`) needs a small relay in front of it `[VERIFY]`.
 */

type Json = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown, max = 500): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, max);
};

function stringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}

const SEVERITIES: Readonly<Record<string, AlertSeverity>> = {
  critical: 'critical',
  error: 'error',
  warning: 'warning',
  info: 'info',
};

/** `[ASSUMED]` Alertmanager has no severity field; `severity` is the convention. Others stay `unknown`. */
export function alertmanagerSeverity(value: unknown): AlertSeverity {
  return typeof value === 'string'
    ? (SEVERITIES[value.trim().toLowerCase()] ?? 'unknown')
    : 'unknown';
}

/** Alerts handled per request; a longer list is cut and the rest counted as rejected. */
export const ALERTMANAGER_MAX_ALERTS = 100;

export interface AlertmanagerBatch {
  readonly results: readonly NormalizeResult[];
  /** Alerts beyond `ALERTMANAGER_MAX_ALERTS`. */
  readonly truncated: number;
}

function normalizeOne(raw: unknown, externalUrl: string | null): NormalizeResult {
  if (!isRecord(raw)) return rejected('invalid_shape');
  const status = text(raw.status, 20)?.toLowerCase();
  if (status !== 'firing' && status !== 'resolved') return rejected('unknown_state');
  const allLabels = stringMap(raw.labels);
  const alertname = text(allLabels.alertname, 200);
  if (alertname === null) return rejected('missing_name');
  const annotations = stringMap(raw.annotations);

  const state = status === 'resolved' ? 'resolved' : 'firing';
  const startsAt = isoFromRfc3339(raw.startsAt);
  const endsAt = isoFromRfc3339(raw.endsAt);
  const fingerprint = alertFingerprint({
    source: 'alertmanager',
    name: alertname,
    condition: '',
    resourceType: '',
    labels: allLabels,
  });
  const startKey = text(raw.startsAt, 40) ?? '';
  const providerEventId = [
    fingerprint.slice(0, 32),
    startKey,
    state,
    state === 'resolved' ? (text(raw.endsAt, 40) ?? '') : '',
  ].join('|');

  const summary = text(annotations.summary, 500) ?? text(annotations.description, 500);
  const generatorUrl = safeHttpUrl(raw.generatorURL);
  const labels = allowedLabels(allLabels);

  const alert: NormalizedAlert = {
    source: 'alertmanager',
    providerEventId,
    fingerprint,
    state,
    severity: alertmanagerSeverity(allLabels.severity),
    title: alertname,
    summary,
    conditionName: null,
    labels,
    url: generatorUrl,
    occurredAt: state === 'resolved' ? (endsAt ?? startsAt) : startsAt,
    renotify: false,
    payload: sanitizeAlertPayload({
      kind: 'alertmanager',
      alertname,
      summary,
      generatorUrl,
      externalUrl,
      providerFingerprint: text(raw.fingerprint, 64),
      providerSeverity: text(allLabels.severity, 50),
      startedAt: startsAt,
      endedAt: state === 'resolved' ? endsAt : null,
      renotify: false,
      labels: allLabels,
    }),
  };
  return { ok: true, alert };
}

/** `data` is the request body text or the parsed object. */
export function normalizeAlertmanager(data: unknown): AlertmanagerBatch | RejectReason {
  let body: unknown = data;
  if (typeof data === 'string') {
    try {
      body = JSON.parse(data);
    } catch {
      return 'not_json';
    }
  }
  if (!isRecord(body) || !Array.isArray(body.alerts)) return 'invalid_shape';
  if (typeof body.version === 'string' && !/^4(?:\.\d+)?$/.test(body.version)) {
    return 'unsupported_version';
  }
  const externalUrl = safeHttpUrl(body.externalURL);
  const list: readonly unknown[] = body.alerts;
  return {
    results: list.slice(0, ALERTMANAGER_MAX_ALERTS).map((raw) => normalizeOne(raw, externalUrl)),
    truncated: Math.max(0, list.length - ALERTMANAGER_MAX_ALERTS),
  };
}
