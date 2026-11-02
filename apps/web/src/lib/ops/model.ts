import type {
  Alert,
  AlertListQuery,
  AlertSeverity,
  EscalationStep,
  IncidentSeverity,
  Permission,
  ServiceMatchRule,
} from '@watchtower/shared';
import { type SeverityId } from '@watchtower/ui';

import type { MessageKey, Translate } from '@/i18n';
import { describeError, type ErrorView } from '@/lib/admin/errors';

/** docs/06-UI-SPEC.md section 8.1 and Q10: critical -> P1, error -> P2, warning -> P3, info -> P4. */
export function alertSeverityId(severity: AlertSeverity): SeverityId {
  switch (severity) {
    case 'critical':
      return 'p1';
    case 'error':
      return 'p2';
    case 'warning':
      return 'p3';
    case 'unknown':
      // The provider did not say: P3 with the label "Severity unmapped" (UI spec Q10), never a guess of P1.
      return 'p3';
    case 'info':
      return 'p4';
  }
}

export const ALERT_SEVERITY_LABELS = {
  critical: 'ops.alerts.severity.critical',
  error: 'ops.alerts.severity.error',
  warning: 'ops.alerts.severity.warning',
  info: 'ops.alerts.severity.info',
  unknown: 'ops.alerts.severity.unknown',
} as const satisfies Record<AlertSeverity, MessageKey>;

const INCIDENT_SEVERITY_IDS: Record<IncidentSeverity, SeverityId> = {
  SEV1: 'p1',
  SEV2: 'p2',
  SEV3: 'p3',
  SEV4: 'p4',
};

/** SEV1 to SEV4 use the P1 to P4 tokens, with the code `SEV1` (UI spec section 8.1). */
export function incidentSeverityId(severity: IncidentSeverity): SeverityId {
  return INCIDENT_SEVERITY_IDS[severity];
}

export const INCIDENT_SEVERITY_LABELS = {
  SEV1: 'ops.incidents.severity.SEV1',
  SEV2: 'ops.incidents.severity.SEV2',
  SEV3: 'ops.incidents.severity.SEV3',
  SEV4: 'ops.incidents.severity.SEV4',
} as const satisfies Record<IncidentSeverity, MessageKey>;

/** True while the snooze is in force. The escalation waits; the alert is still open. */
export function isSnoozed(alert: Pick<Alert, 'snoozedUntil' | 'state'>, now: number): boolean {
  return (
    alert.state !== 'resolved' &&
    alert.snoozedUntil !== null &&
    Date.parse(alert.snoozedUntil) > now
  );
}

export const ALERT_VIEWS = [
  'open',
  'acknowledged',
  'snoozed',
  'resolved',
  'unmapped',
  'groups',
  'noise',
] as const;
export type AlertView = (typeof ALERT_VIEWS)[number];

export function isAlertView(value: string | null): value is AlertView {
  return ALERT_VIEWS.some((view) => view === value);
}

/** The list query behind a view; `groups` and `noise` are not alert lists. */
export function alertQueryFor(view: AlertView): Partial<AlertListQuery> | null {
  switch (view) {
    case 'open':
      return { state: 'open' };
    case 'acknowledged':
      return { state: 'acknowledged' };
    case 'snoozed':
      return { snoozed: true };
    case 'resolved':
      return { state: 'resolved' };
    case 'unmapped':
      return { unmapped: true };
    case 'groups':
    case 'noise':
      return null;
  }
}

/** The next index for J and K, clamped to the list; -1 (nothing selected) starts at the first row. */
export function stepIndex(current: number, delta: 1 | -1, length: number): number {
  if (length === 0) return -1;
  if (current < 0) return 0;
  return Math.min(length - 1, Math.max(0, current + delta));
}

export const ESCALATION_TARGET_LABELS = {
  on_shift: 'ops.policies.target.on_shift',
  lead: 'ops.policies.target.lead',
  head: 'ops.policies.target.head',
} as const satisfies Record<EscalationStep['target'], MessageKey>;

/** `afterSeconds` shown in minutes for people; the policy keeps seconds. */
export function secondsToMinutes(seconds: number): number {
  return Math.round(seconds / 60);
}

/**
 * One label per rule of a service, for the list: "source gcp_monitoring · policy name · env=prod".
 * Plain text, no translation: these are the provider's own words.
 */
export function describeRule(rule: ServiceMatchRule): string {
  const parts: string[] = [];
  if (rule.source !== undefined) parts.push(rule.source);
  if (rule.policyName !== undefined) parts.push(rule.policyName);
  for (const [key, value] of Object.entries(rule.labels)) parts.push(`${key}=${value}`);
  return parts.join(' · ');
}

/** `key=value` per line (the rule editor's text) to a label map; null when a line is not `key=value`. */
export function parseLabelLines(text: string): Record<string, string> | null {
  const labels: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const index = line.indexOf('=');
    if (index <= 0 || index === line.length - 1) return null;
    labels[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return labels;
}

export function labelsToLines(labels: Readonly<Record<string, string>>): string {
  return Object.entries(labels)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

/** The api's own sentence for a refusal, else the shared admin wording for the status. */
export function describeOpsError(error: unknown, t: Translate): ErrorView {
  return describeError(error, t);
}

/** Staff may open the alert screens with `alert.read`; the incident and status ones with `ticket.read`. */
export const OPS_PERMISSIONS = {
  alerts: 'alert.read',
  incidents: 'ticket.read',
  statusPage: 'ticket.read',
} as const satisfies Record<string, Permission>;

/** `2026-11-02T10:00` (a datetime-local value, browser zone) to an ISO instant. */
export function localInputToIso(value: string): string | null {
  if (value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function isoToLocalInput(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** The token of `#token=...` on a subscription link, or null. The same shape rules as the CSAT link. */
export function parseSubscriptionFragment(hash: string): string | null {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  const token = new URLSearchParams(fragment).get('token');
  if (token === null || token.length < 10 || token.length > 300) return null;
  return /^[\x21-\x7e]+$/.test(token) ? token : null;
}
