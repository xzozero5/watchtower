import type {
  Alert,
  AlertDetail,
  AlertEscalation,
  EscalationPolicy,
  Heartbeat,
  HealthSnapshot,
  IncidentChanges,
  IncidentComm,
  IncidentCommPreview,
  IncidentDetail,
  PublicStatus,
  Service,
  StatusComponent,
  StatusMaintenanceStaff,
  StatusPostStaff,
} from '@watchtower/shared';

import { uuid } from './fixtures';

/** Ops fixtures: invented names and example.com only (N1). Shared by the unit tests and the e2e mock. */
const NOW = '2026-11-02T03:00:00.000Z';
const at = (minutes: number) => new Date(Date.parse(NOW) + minutes * 60_000).toISOString();
/** Far enough away that a snooze stays in force whenever the test runs. */
export const FAR_FUTURE = '2099-01-01T00:00:00.000Z';

export const SERVICE_CHECKOUT = uuid(7100);
export const SERVICE_SEARCH = uuid(7101);
export const POLICY_DEFAULT = uuid(7200);
export const POLICY_STRICT = uuid(7201);

export function service(overrides: Partial<Service> = {}): Service {
  return {
    id: SERVICE_CHECKOUT,
    slug: 'checkout-api',
    name: 'Checkout API',
    ownerQueueId: null,
    runbookUrl: 'https://runbooks.example.com/checkout',
    runbookArticleId: null,
    dashboardUrl: null,
    matchRules: [
      { source: 'gcp_monitoring', policyName: 'Checkout latency', labels: { env: 'prod' } },
    ],
    repos: ['example-org/checkout'],
    escalationPolicyId: null,
    active: true,
    createdAt: at(-1000),
    updatedAt: at(-1000),
    ...overrides,
  };
}

export function policy(overrides: Partial<EscalationPolicy> = {}): EscalationPolicy {
  return {
    id: POLICY_DEFAULT,
    name: 'Default',
    steps: [
      { target: 'on_shift', afterSeconds: 0 },
      { target: 'lead', afterSeconds: 300 },
      { target: 'head', afterSeconds: 900 },
    ],
    isDefault: true,
    createdAt: at(-1000),
    updatedAt: at(-1000),
    ...overrides,
  };
}

export function heartbeat(overrides: Partial<Heartbeat> = {}): Heartbeat {
  return {
    id: uuid(7300),
    slug: 'nightly-export',
    name: 'Nightly export',
    expectedIntervalSeconds: 86_400,
    graceSeconds: 3600,
    severity: 'error',
    serviceId: SERVICE_CHECKOUT,
    active: true,
    state: 'ok',
    lastBeatAt: at(-60),
    missingSince: null,
    createdAt: at(-1000),
    updatedAt: at(-1000),
    ...overrides,
  };
}

export function alert(n: number, overrides: Partial<Alert> = {}): Alert {
  return {
    id: uuid(7000 + n),
    fingerprint: 'f'.repeat(64),
    source: 'gcp_monitoring',
    serviceId: SERVICE_CHECKOUT,
    severity: 'critical',
    state: 'open',
    title: `Checkout latency high ${String(n)}`,
    summary: 'p95 latency is above the threshold',
    count: 3,
    firstSeenAt: at(-30),
    lastSeenAt: at(-2),
    resolvedAt: null,
    ackedAt: null,
    ackedBy: null,
    ackedVia: null,
    escalationLevel: 0,
    nextEscalationAt: at(3),
    snoozedUntil: null,
    snoozeReason: null,
    correlationId: null,
    incidentId: null,
    payload: { url: 'https://monitoring.example.com/alert/1', labels: { env: 'prod' } },
    ...overrides,
  };
}

export function alertDetail(n: number, overrides: Partial<Alert> = {}): AlertDetail {
  return {
    ...alert(n, overrides),
    events: [
      { id: uuid(7500 + n), type: 'fired', occurredAt: at(-30), createdAt: at(-30) },
      { id: uuid(7510 + n), type: 'renotified', occurredAt: null, createdAt: at(-2) },
    ],
  };
}

export function escalation(overrides: Partial<AlertEscalation> = {}): AlertEscalation {
  return {
    level: 0,
    target: 'on_shift',
    fallback: null,
    recipientCount: 1,
    chatState: 'mock',
    createdAt: at(-29),
    ...overrides,
  };
}

export function incidentDetail(overrides: Partial<IncidentDetail> = {}): IncidentDetail {
  return {
    id: uuid(7600),
    number: 12,
    key: 'INC-12',
    title: 'Checkout is slow',
    severity: 'SEV2',
    status: 'investigating',
    commanderId: null,
    rootCause: null,
    discordThreadState: 'mock',
    startedAt: at(-45),
    resolvedAt: null,
    serviceIds: [SERVICE_CHECKOUT],
    orgIds: [],
    tickets: 2,
    alerts: 1,
    ticketIds: [uuid(1), uuid(2)],
    alertIds: [uuid(7001)],
    timeline: [
      {
        id: uuid(7700),
        type: 'created',
        actorType: 'user',
        actorId: uuid(900),
        payload: { severity: 'SEV2', services: 1 },
        createdAt: at(-45),
      },
      {
        id: uuid(7701),
        type: 'note',
        actorType: 'user',
        actorId: uuid(900),
        payload: { text: 'Rolled back the last deploy' },
        createdAt: at(-20),
      },
    ],
    ...overrides,
  };
}

export function comm(overrides: Partial<IncidentComm> = {}): IncidentComm {
  return {
    id: uuid(7800),
    incidentId: uuid(7600),
    body: 'We are looking into slow checkouts and will update you.',
    origin: 'human',
    status: 'draft',
    draftedBy: uuid(900),
    sentBy: null,
    confirmedRecipients: null,
    sentAt: null,
    createdAt: at(-10),
    ...overrides,
  };
}

export function preview(overrides: Partial<IncidentCommPreview> = {}): IncidentCommPreview {
  return { recipients: 7, skippedChannel: 1, skippedClosed: 2, ...overrides };
}

export function changes(overrides: Partial<IncidentChanges> = {}): IncidentChanges {
  return {
    window: { from: at(-100), to: at(-40), minutes: 60, endsAt: 'alert' },
    deploys: [
      {
        id: uuid(7900),
        serviceId: SERVICE_CHECKOUT,
        serviceSlug: 'checkout-api',
        version: 'v2026.11.1',
        env: 'prod',
        actor: 'ci-bot',
        source: 'ci',
        startedAt: null,
        finishedAt: null,
        url: null,
        occurredAt: at(-70),
      },
    ],
    repoSource: 'none',
    repoChanges: [],
    repoUnavailable: false,
    ...overrides,
  };
}

export function statusComponent(
  n: number,
  overrides: Partial<StatusComponent> = {},
): StatusComponent {
  return {
    id: uuid(8000 + n),
    slug: `component-${String(n)}`,
    name: `Component ${String(n)}`,
    description: null,
    serviceId: null,
    public: true,
    position: n,
    status: 'operational',
    ...overrides,
  };
}

export function statusPost(n: number, overrides: Partial<StatusPostStaff> = {}): StatusPostStaff {
  return {
    id: uuid(8100 + n),
    incidentId: null,
    title: 'We are investigating an issue',
    body: 'We are investigating an issue affecting Component 1.',
    phase: 'investigating',
    impact: 'minor',
    state: 'draft',
    origin: 'human',
    draftedBy: uuid(900),
    publishedBy: null,
    publishedAt: null,
    componentIds: [uuid(8001)],
    createdAt: at(-5),
    updatedAt: at(-5),
    ...overrides,
  };
}

export function maintenance(
  n: number,
  overrides: Partial<StatusMaintenanceStaff> = {},
): StatusMaintenanceStaff {
  return {
    id: uuid(8200 + n),
    title: 'Database upgrade',
    body: 'Planned upgrade of the database.',
    startsAt: at(60 * 24),
    endsAt: at(60 * 25),
    state: 'draft',
    origin: 'human',
    publishedBy: null,
    publishedAt: null,
    componentIds: [uuid(8001)],
    ...overrides,
  };
}

export function publicStatus(overrides: Partial<PublicStatus> = {}): PublicStatus {
  return {
    overall: 'operational',
    components: [
      { slug: 'web-app', name: 'Web app', description: null, status: 'operational' },
      { slug: 'api', name: 'API', description: 'The public API', status: 'operational' },
    ],
    activePosts: [],
    ongoingMaintenance: [],
    upcomingMaintenance: [],
    generatedAt: NOW,
    ...overrides,
  };
}

export function healthSnapshot(overrides: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    orgId: uuid(500),
    day: '2026-11-02',
    formulaVersion: 1,
    status: 'scored',
    score: 74,
    components: [
      { key: 'ticket_volume', weight: 0.2, status: 'ok', score: 80, detail: {} },
      { key: 'sla', weight: 0.3, status: 'ok', score: 70, detail: {} },
      { key: 'csat', weight: 0.2, status: 'no_data', score: null, detail: {} },
      { key: 'incidents', weight: 0.15, status: 'ok', score: 90, detail: {} },
      { key: 'usage_anomalies', weight: 0.15, status: 'ok', score: 60, detail: {} },
    ],
    ...overrides,
  };
}
