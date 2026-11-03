import { createHash } from 'node:crypto';

import { AUDIT_ACTIONS } from '@watchtower/shared';

import { renderMail } from './email.js';
import { DAY, HOUR, MINUTE, bangkokTime, localParts, type Rng } from './prng.js';
import type { Duty } from './roster.js';
import type { IncidentWindow, TicketBundle } from './tickets.js';
import { isOffDay } from './tickets.js';
import type { Reference, Row } from './types.js';
import type { World, WorldStaff } from './world.js';

/**
 * Operations side of the year: the service catalog, alerts and their escalations, incidents with
 * timelines, deploys, public status posts and incident updates to customers.
 */

export interface ServiceDef {
  readonly slug: string;
  readonly name: string;
  readonly queue: 'Support' | 'Integrations' | 'Billing';
  readonly components: string;
  readonly alertTitles: readonly string[];
}

export const SERVICES: readonly ServiceDef[] = [
  {
    slug: 'api-gateway',
    name: 'API Gateway',
    queue: 'Integrations',
    components: 'API',
    alertTitles: [
      '5xx rate above 2% for 5 minutes',
      'p95 latency above 1.5s',
      'Upstream connection resets',
      'TLS certificate expires in 14 days',
    ],
  },
  {
    slug: 'webhook-dispatcher',
    name: 'Webhook Dispatcher',
    queue: 'Integrations',
    components: 'Webhooks',
    alertTitles: [
      'Delivery queue depth above 5,000',
      'Delivery failure rate above 10%',
      'Retry backlog older than 30 minutes',
    ],
  },
  {
    slug: 'batch-processor',
    name: 'Batch Processor',
    queue: 'Integrations',
    components: 'Batch jobs',
    alertTitles: [
      'Jobs stuck in processing for 20 minutes',
      'Worker restarts above threshold',
      'Nightly run did not finish by 06:00',
    ],
  },
  {
    slug: 'auth-service',
    name: 'Auth Service',
    queue: 'Support',
    components: 'Sign-in',
    alertTitles: [
      'Login error rate above 3%',
      'Token issuance latency above 800ms',
      'Failed sign-in spike from one network',
    ],
  },
  {
    slug: 'reporting-service',
    name: 'Reporting Service',
    queue: 'Billing',
    components: 'Reports',
    alertTitles: [
      'Report export queue above 200',
      'Export duration p95 above 10 minutes',
      'Read replica lag above 60s',
    ],
  },
  {
    slug: 'notification-relay',
    name: 'Notification Relay',
    queue: 'Support',
    components: 'Notifications',
    alertTitles: [
      'Email send failures above 5%',
      'Provider rate limit reached',
      'Queue consumers stopped',
    ],
  },
  {
    slug: 'customer-portal',
    name: 'Customer Portal',
    queue: 'Support',
    components: 'Portal',
    alertTitles: [
      'Portal 5xx above 1%',
      'Static assets not loading',
      'Slow page load p95 above 4s',
    ],
  },
  {
    slug: 'billing-engine',
    name: 'Billing Engine',
    queue: 'Billing',
    components: 'Billing',
    alertTitles: [
      'Usage aggregation delayed',
      'Invoice generation errors',
      'Ledger reconciliation mismatch',
    ],
  },
];

interface IncidentTheme {
  readonly title: string;
  readonly severity: 'SEV1' | 'SEV2' | 'SEV3' | 'SEV4';
  readonly services: readonly string[];
  readonly intents: readonly string[];
  readonly hours: number;
  readonly cause: string;
  readonly deploy: boolean;
}

const THEMES: readonly IncidentTheme[] = [
  {
    title: 'Elevated 5xx errors on the public API after a release',
    severity: 'SEV2',
    services: ['api-gateway'],
    intents: ['api_error', 'processing_failure'],
    hours: 2.5,
    cause:
      'A release changed request validation and rejected valid payloads. Rolled back; a regression test now covers the case.',
    deploy: true,
  },
  {
    title: 'Webhook deliveries delayed by more than 30 minutes',
    severity: 'SEV3',
    services: ['webhook-dispatcher'],
    intents: ['webhook_not_received'],
    hours: 3,
    cause:
      'A burst of events saturated the dispatcher queue. Consumers were scaled out and the backlog drained.',
    deploy: false,
  },
  {
    title: 'Sign-in failures for part of the users',
    severity: 'SEV1',
    services: ['auth-service', 'customer-portal'],
    intents: ['account_access', 'incident_inquiry'],
    hours: 1.6,
    cause:
      'An expired signing key was not rotated on one node. The key was rotated and the node restarted.',
    deploy: false,
  },
  {
    title: 'Batch jobs stuck in processing after database failover',
    severity: 'SEV2',
    services: ['batch-processor'],
    intents: ['processing_failure', 'incident_inquiry'],
    hours: 4.2,
    cause:
      'A database failover left worker locks held. Locks were released and the stuck jobs re-queued.',
    deploy: false,
  },
  {
    title: 'Timeouts calling the carrier rate provider',
    severity: 'SEV3',
    services: ['api-gateway'],
    intents: ['upstream_timeout', 'incident_inquiry'],
    hours: 5,
    cause:
      'The upstream provider had a partial outage. Traffic was moved to the secondary route; provider confirmed recovery.',
    deploy: false,
  },
  {
    title: 'Report exports failing with timeouts',
    severity: 'SEV3',
    services: ['reporting-service'],
    intents: ['processing_failure', 'billing_report'],
    hours: 3.4,
    cause: 'A missing index on a new report made exports scan a large table. Index added.',
    deploy: true,
  },
  {
    title: 'Customer portal pages not loading',
    severity: 'SEV2',
    services: ['customer-portal'],
    intents: ['incident_inquiry', 'account_access'],
    hours: 1.9,
    cause:
      'A CDN configuration change purged static assets. Configuration restored and cache warmed.',
    deploy: false,
  },
  {
    title: 'Email notifications not delivered',
    severity: 'SEV3',
    services: ['notification-relay'],
    intents: ['other', 'incident_inquiry'],
    hours: 6,
    cause:
      'The mail provider throttled our sending domain after a volume spike. Rate limiting added on our side.',
    deploy: false,
  },
  {
    title: 'API latency above 5 seconds in the evening peak',
    severity: 'SEV2',
    services: ['api-gateway', 'batch-processor'],
    intents: ['upstream_timeout', 'api_error'],
    hours: 2.8,
    cause:
      'Connection pool exhaustion towards the database under peak load. Pool size raised, queries tuned.',
    deploy: false,
  },
  {
    title: 'Usage aggregation delayed, invoices at risk',
    severity: 'SEV3',
    services: ['billing-engine'],
    intents: ['billing_report', 'result_dispute'],
    hours: 8,
    cause:
      'The aggregation job was blocked by a long transaction. Job restarted and totals verified against the ledger.',
    deploy: false,
  },
  {
    title: 'Webhook signature verification failing for some tenants',
    severity: 'SEV3',
    services: ['webhook-dispatcher'],
    intents: ['webhook_not_received', 'api_error'],
    hours: 2.2,
    cause: 'A signing library update changed header casing. Reverted and pinned the version.',
    deploy: true,
  },
  {
    title: 'Intermittent 502 from the gateway',
    severity: 'SEV2',
    services: ['api-gateway'],
    intents: ['api_error', 'upstream_timeout'],
    hours: 1.4,
    cause: 'One gateway instance ran out of file descriptors. Instance replaced and limits raised.',
    deploy: false,
  },
  {
    title: 'Nightly processing run did not finish',
    severity: 'SEV3',
    services: ['batch-processor', 'reporting-service'],
    intents: ['processing_failure'],
    hours: 5.5,
    cause:
      'A slow upstream export blocked the night run. Added a timeout and a retry policy to the step.',
    deploy: false,
  },
  {
    title: 'Login page shows errors after maintenance',
    severity: 'SEV2',
    services: ['auth-service'],
    intents: ['account_access', 'incident_inquiry'],
    hours: 1.1,
    cause: 'A configuration flag was reset by the maintenance script. Flag restored; script fixed.',
    deploy: false,
  },
  {
    title: 'Results list shows duplicate entries',
    severity: 'SEV3',
    services: ['reporting-service', 'billing-engine'],
    intents: ['result_dispute', 'billing_report'],
    hours: 7,
    cause:
      'A retry after a timeout created duplicates. Duplicates removed and an idempotency check added.',
    deploy: true,
  },
  {
    title: 'Partial outage of the sandbox environment',
    severity: 'SEV4',
    services: ['api-gateway'],
    intents: ['workspace_config', 'api_error'],
    hours: 4,
    cause: 'The sandbox cluster ran out of disk. Space freed and monitoring added.',
    deploy: false,
  },
  {
    title: 'Slow dashboards and exports during month-end',
    severity: 'SEV3',
    services: ['reporting-service'],
    intents: ['processing_failure', 'upstream_timeout'],
    hours: 6.5,
    cause: 'Month-end load on the read replica. Replica scaled up for the period.',
    deploy: false,
  },
  {
    title: 'Webhook endpoint auto-disabled for many tenants',
    severity: 'SEV2',
    services: ['webhook-dispatcher'],
    intents: ['webhook_not_received'],
    hours: 2.1,
    cause:
      'The failure threshold was too strict during a short upstream blip. Threshold relaxed and endpoints re-enabled.',
    deploy: false,
  },
  {
    title: 'Upstream payment partner returning errors',
    severity: 'SEV2',
    services: ['api-gateway', 'billing-engine'],
    intents: ['upstream_timeout', 'result_dispute'],
    hours: 3.3,
    cause:
      'The partner had an incident. Requests were queued and replayed once the partner recovered.',
    deploy: false,
  },
  {
    title: 'Delayed notifications after queue consumer crash',
    severity: 'SEV4',
    services: ['notification-relay'],
    intents: ['other'],
    hours: 2.4,
    cause: 'A consumer crashed on a malformed message. Message quarantined and consumer restarted.',
    deploy: true,
  },
  {
    title: 'Elevated error rate after the latest gateway release',
    severity: 'SEV2',
    services: ['api-gateway'],
    intents: ['api_error', 'processing_failure', 'incident_inquiry'],
    hours: 0,
    cause: '',
    deploy: true,
  },
];

const DAYS_AGO = [
  349, 331, 312, 291, 270, 249, 231, 214, 193, 174, 158, 140, 122, 104, 88, 71, 56, 40, 25, 13, 2,
];

export function planIncidentWindows(
  rng: Rng,
  world: World,
  start: Date,
  now: Date,
  holidays: ReadonlySet<string>,
): { windows: IncidentWindow[]; themes: IncidentTheme[] } {
  const windows: IncidentWindow[] = [];
  const themes: IncidentTheme[] = [];
  THEMES.forEach((theme, index) => {
    const ago = (DAYS_AGO[index] ?? 30) + rng.int(-2, 2);
    let day = new Date(now.getTime() - ago * DAY);
    // Incidents mostly start in working hours, on weekdays.
    for (let guard = 0; guard < 4; guard += 1) {
      const p = localParts(day);
      if (!isOffDay(p.dateKey, p.weekday, holidays)) break;
      day = new Date(day.getTime() - DAY);
    }
    const p = localParts(day);
    const hour = rng.chance(0.75) ? rng.int(9, 17) : rng.pick([2, 6, 7, 19, 21, 22]);
    const startsAt = bangkokTime(p.dateKey, hour, rng.int(0, 59));
    if (startsAt.getTime() < start.getTime() + DAY || startsAt.getTime() > now.getTime() - HOUR)
      return;
    const ongoing = theme.hours === 0;
    const resolvedAt = ongoing
      ? null
      : new Date(startsAt.getTime() + theme.hours * HOUR * (0.8 + rng.next() * 0.4));
    const count =
      theme.severity === 'SEV1'
        ? rng.int(35, 55)
        : theme.severity === 'SEV2'
          ? rng.int(14, 32)
          : theme.severity === 'SEV3'
            ? rng.int(5, 14)
            : rng.int(2, 5);
    const affected = world.orgs.filter((o) => o.createdAt.getTime() < startsAt.getTime());
    const orgs = rng
      .shuffle(affected)
      .slice(0, Math.max(3, Math.min(affected.length, Math.ceil(count / 2.2))));
    windows.push({
      id: rng.uuid(),
      index: windows.length,
      startsAt,
      resolvedAt,
      severity: theme.severity,
      intentKeys: theme.intents,
      orgIndexes: orgs.map((o) => o.index),
      ticketCount: ongoing ? Math.min(count, 14) : count,
    });
    themes.push(theme);
  });
  return { windows, themes };
}

const fingerprint = (text: string): string => createHash('sha256').update(text).digest('hex');
const pad = (n: number): string => String(n).padStart(2, '0');

export interface OpsInput {
  readonly rng: Rng;
  readonly world: World;
  readonly reference: Reference;
  readonly duty: Duty;
  readonly now: Date;
  readonly start: Date;
  readonly windows: readonly IncidentWindow[];
  readonly themes: readonly IncidentTheme[];
  readonly bundles: readonly TicketBundle[];
  readonly escalationPolicyId: string | null;
  readonly runbookBySlug: ReadonlyMap<string, string>;
  readonly serviceIds: ReadonlyMap<string, string>;
}

export interface OpsOutput {
  readonly tables: Map<string, Row[]>;
  readonly incidentInfo: readonly {
    readonly id: string;
    readonly number: number;
    readonly title: string;
    readonly startedAt: Date;
    readonly resolvedAt: Date | null;
    readonly severity: string;
    readonly commander: WorldStaff;
  }[];
  readonly alertsOpen: readonly { id: string; title: string; severity: string; at: Date }[];
}

export function serviceRows(
  rng: Rng,
  input: Pick<OpsInput, 'reference' | 'escalationPolicyId' | 'runbookBySlug' | 'start'>,
  ids: Map<string, string>,
): Row[] {
  return SERVICES.map((svc) => {
    const id = rng.uuid();
    ids.set(svc.slug, id);
    return {
      id,
      slug: svc.slug,
      name: svc.name,
      owner_queue_id: input.reference.queues[svc.queue],
      runbook_url: null,
      runbook_article_id: input.runbookBySlug.get(svc.slug) ?? null,
      dashboard_url: `https://dashboards.example.com/d/${svc.slug}`,
      match_rules: [],
      repos: [`example-org/${svc.slug}`],
      escalation_policy_id: input.escalationPolicyId,
      active: true,
      created_at: input.start,
      updated_at: input.start,
    };
  });
}

export function planOps(input: OpsInput): OpsOutput {
  const { rng, world, reference, duty, now } = input;
  const t = new Map<string, Row[]>();
  const rows = (name: string): Row[] => {
    let list = t.get(name);
    if (!list) {
      list = [];
      t.set(name, list);
    }
    return list;
  };
  const componentIds = new Map(SERVICES.map((svc) => [svc.slug, rng.uuid()] as const));
  const leadsAndHeads = world.staff.filter((s) => s.role === 'lead' || s.role === 'head');
  const devs = world.staff.filter((s) => s.role === 'dev');
  const agents = world.staff.filter((s) => s.role === 'agent' || s.role === 'lead');
  const serviceId = (slug: string): string => input.serviceIds.get(slug) ?? '';

  // --- deploys: a few a week, more on weekdays ---
  const deploys: { id: string; at: Date; slug: string; version: string; actor: string }[] = [];
  let deployNo = 0;
  for (let ts = input.start.getTime() + 12 * HOUR; ts < now.getTime() - HOUR; ts += DAY) {
    const day = new Date(ts);
    const p = localParts(day);
    if (isOffDay(p.dateKey, p.weekday, reference.holidays)) continue;
    const n = rng.count(0.75);
    for (let i = 0; i < n; i += 1) {
      const slug = rng.weighted(
        SERVICES.map((s) => [s.slug, s.slug === 'api-gateway' ? 3 : 1] as const),
      );
      const at = bangkokTime(p.dateKey, rng.int(10, 17), rng.int(0, 59));
      if (at.getTime() > now.getTime() - HOUR) continue;
      deployNo += 1;
      const actor = rng.pick(devs);
      const version = `2026.${pad(p.month)}.${String(deployNo)}`;
      const id = rng.uuid();
      deploys.push({ id, at, slug, version, actor: actor.email.split('@')[0] ?? 'ci' });
      const started = at;
      const finished = new Date(at.getTime() + rng.int(3, 14) * MINUTE);
      rows('deploy').push({
        id,
        service_id: serviceId(slug),
        service_slug: slug,
        version,
        env: rng.chance(0.15) ? 'staging' : 'production',
        actor: actor.email.split('@')[0] ?? 'ci',
        source: 'ci',
        external_id: `ci-run-${String(deployNo)}`,
        started_at: started,
        finished_at: finished,
        url: `https://ci.example.com/runs/${String(deployNo)}`,
        received_at: finished,
      });
    }
  }

  // --- incidents ---
  const incidentInfo: OpsOutput['incidentInfo'][number][] = [];
  const bundlesByIncident = new Map<string, TicketBundle[]>();
  for (const bundle of input.bundles) {
    const incidentId = bundle.sim.incidentId;
    if (incidentId)
      bundlesByIncident.set(incidentId, [...(bundlesByIncident.get(incidentId) ?? []), bundle]);
  }
  const alertRowsList: Row[] = [];
  const addAlert = (opts: {
    at: Date;
    service: string;
    title: string;
    severity: 'critical' | 'error' | 'warning' | 'info';
    durationMin: number;
    ack: boolean;
    incidentId: string | null;
    correlationId: string | null;
    ongoing?: boolean;
  }): Row => {
    const id = rng.uuid();
    const index = alertRowsList.length;
    const source = rng.weighted<'gcp_monitoring' | 'gcp_logging' | 'alertmanager'>([
      ['gcp_monitoring', 6],
      ['gcp_logging', 3],
      ['alertmanager', 1],
    ]);
    const count =
      opts.severity === 'warning' || opts.severity === 'info' ? rng.int(1, 3) : rng.int(1, 9);
    const resolvedAt = opts.ongoing
      ? null
      : new Date(opts.at.getTime() + opts.durationMin * MINUTE);
    const lastSeen = new Date(
      Math.min(
        resolvedAt?.getTime() ?? now.getTime(),
        opts.at.getTime() + (count - 1) * 4 * MINUTE + 1000,
      ),
    );
    const dutyNow = duty.active(opts.at);
    const responders = [...dutyNow.desk, ...dutyNow.oncall].filter((p) => p.role !== 'dev');
    const acker = responders.length > 0 ? rng.pick(responders) : rng.pick(agents);
    const ackedAt = opts.ack ? new Date(opts.at.getTime() + rng.logNormal(5, 0.7) * MINUTE) : null;
    const stillOpen = opts.ongoing === true;
    const state = stillOpen ? (ackedAt ? 'acknowledged' : 'open') : 'resolved';
    const row: Row = {
      id,
      fingerprint: fingerprint(`${opts.service}|${opts.title}|${String(index)}`),
      source,
      service_id: serviceId(opts.service),
      severity: opts.severity,
      state,
      title: opts.title,
      summary: `${opts.title} on ${opts.service}`,
      count,
      payload: {},
      first_seen_at: opts.at,
      last_seen_at: stillOpen
        ? new Date(Math.max(lastSeen.getTime(), now.getTime() - 5 * MINUTE))
        : lastSeen,
      resolved_at: state === 'resolved' ? resolvedAt : null,
      acked_at:
        ackedAt && ackedAt.getTime() <= (resolvedAt?.getTime() ?? now.getTime()) ? ackedAt : null,
      acked_by: ackedAt ? acker.id : null,
      acked_via: ackedAt
        ? rng.weighted<'web' | 'discord'>([
            ['discord', 3],
            ['web', 2],
          ])
        : null,
      escalation_level: 0,
      next_escalation_at: null,
      snoozed_until: null,
      snooze_reason: null,
      snoozed_by: null,
      snoozed_at: null,
      correlation_id: opts.correlationId,
      incident_id: opts.incidentId,
      created_at: opts.at,
      updated_at: resolvedAt ?? now,
    };
    if (row.acked_at === null) {
      row.acked_by = null;
      row.acked_via = null;
      if (state === 'acknowledged') row.state = 'open';
    }
    alertRowsList.push(row);
    rows('alert').push(row);
    // events: fired, renotified, resolved
    const events = rows('alert_event');
    events.push({
      id: rng.uuid(),
      alert_id: id,
      source,
      provider_event_id: `y-${String(index)}-f`,
      type: 'fired',
      occurred_at: opts.at,
      created_at: opts.at,
    });
    for (let k = 1; k < Math.min(count, 4); k += 1) {
      const at = new Date(opts.at.getTime() + k * 4 * MINUTE);
      events.push({
        id: rng.uuid(),
        alert_id: id,
        source,
        provider_event_id: `y-${String(index)}-r${String(k)}`,
        type: 'renotified',
        occurred_at: at,
        created_at: at,
      });
    }
    if (row.resolved_at instanceof Date) {
      events.push({
        id: rng.uuid(),
        alert_id: id,
        source,
        provider_event_id: `y-${String(index)}-x`,
        type: 'resolved',
        occurred_at: row.resolved_at,
        created_at: row.resolved_at,
      });
    }
    // escalation: critical alerts nobody acknowledged in 5 minutes go up the chain
    if (
      opts.severity === 'critical' &&
      (!ackedAt || ackedAt.getTime() - opts.at.getTime() > 5 * MINUTE)
    ) {
      const steps: [number, 'lead' | 'head', number][] = [
        [1, 'lead', 5],
        [2, 'head', 15],
      ];
      for (const [level, target, minutes] of steps) {
        const at = new Date(opts.at.getTime() + minutes * MINUTE);
        if (at.getTime() > (resolvedAt?.getTime() ?? now.getTime())) break;
        const pool =
          target === 'lead'
            ? world.staff.filter((s) => s.role === 'lead')
            : world.staff.filter((s) => s.role === 'head');
        rows('alert_escalation').push({
          id: rng.uuid(),
          alert_id: id,
          level,
          target,
          fallback: null,
          recipient_ids: pool.map((p) => p.id),
          recipient_count: pool.length,
          created_at: at,
          chat_state: 'mock',
          chat_next_attempt_at: at,
          chat_claimed_at: null,
          chat_attempts: 1,
          chat_error_code: null,
          chat_channel_id: null,
          chat_message_id: null,
          chat_sent_at: null,
        });
        row.escalation_level = level;
      }
    }
    return row;
  };

  const timeline = rows('incident_timeline');
  const tl = (
    incidentId: string,
    at: Date,
    type: string,
    actor: WorldStaff | null,
    payload: Row,
  ): void => {
    timeline.push({
      id: rng.uuid(),
      created_at: at,
      incident_id: incidentId,
      type,
      actor_type: actor ? 'user' : 'system',
      actor_id: actor?.id ?? null,
      payload,
    });
  };
  const audit = (
    at: Date,
    action: string,
    actor: WorldStaff,
    targetType: string,
    targetId: string,
    metadata: Row = {},
  ): void => {
    rows('audit_log').push({
      id: rng.uuid(),
      created_at: at,
      actor_type: 'user',
      actor_id: actor.id,
      action,
      outcome: 'success',
      target_type: targetType,
      target_id: targetId,
      before: null,
      after: null,
      ip: null,
      request_id: null,
      metadata: { seed: 'year', ...metadata },
    });
  };

  input.windows.forEach((win, index) => {
    const theme = input.themes[index];
    if (!theme) return;
    const commander = rng.pick(leadsAndHeads);
    incidentInfo.push({
      id: win.id,
      number: index + 1,
      title: theme.title,
      startedAt: win.startsAt,
      resolvedAt: win.resolvedAt,
      severity: win.severity,
      commander,
    });
    const linked = bundlesByIncident.get(win.id) ?? [];
    const ongoing = win.resolvedAt === null;
    const correlationId = rng.uuid();
    const status = ongoing ? 'monitoring' : 'resolved';
    const tDetect = win.startsAt;
    const spanMin =
      win.resolvedAt === null ? 0 : (win.resolvedAt.getTime() - tDetect.getTime()) / MINUTE;
    const tIdent = new Date(tDetect.getTime() + (ongoing ? 50 : 20 + spanMin * 0.25) * MINUTE);
    const tMon = new Date(tDetect.getTime() + (ongoing ? 95 : spanMin * 0.7) * MINUTE);

    // alerts that fired for this incident
    const alertCount = rng.int(2, 5);
    for (let i = 0; i < alertCount; i += 1) {
      const slug = theme.services[i % theme.services.length] ?? 'api-gateway';
      const svc = SERVICES.find((s) => s.slug === slug);
      const row = addAlert({
        at: new Date(tDetect.getTime() - rng.int(1, 9) * MINUTE + i * 2 * MINUTE),
        service: slug,
        title: svc ? rng.pick(svc.alertTitles) : 'Elevated error rate',
        severity: i === 0 && theme.severity !== 'SEV4' ? 'critical' : 'error',
        durationMin:
          Math.round(((win.resolvedAt?.getTime() ?? now.getTime()) - tDetect.getTime()) / MINUTE) +
          rng.int(0, 15),
        ack: true,
        incidentId: win.id,
        correlationId,
        ongoing,
      });
      tl(win.id, row.first_seen_at as Date, 'alert_linked', null, {
        alertId: row.id,
        severity: row.severity,
      });
    }

    // a deploy shortly before the start for release-caused incidents
    if (theme.deploy) {
      const slug = theme.services[0] ?? 'api-gateway';
      const deployAt = new Date(tDetect.getTime() - rng.int(8, 40) * MINUTE);
      deployNo += 1;
      const id = rng.uuid();
      const actor = rng.pick(devs);
      rows('deploy').push({
        id,
        service_id: serviceId(slug),
        service_slug: slug,
        version: `2026.${pad(localParts(deployAt).month)}.${String(deployNo)}`,
        env: 'production',
        actor: actor.email.split('@')[0] ?? 'ci',
        source: 'ci',
        external_id: `ci-run-${String(deployNo)}`,
        started_at: deployAt,
        finished_at: new Date(deployAt.getTime() + 6 * MINUTE),
        url: `https://ci.example.com/runs/${String(deployNo)}`,
        received_at: new Date(deployAt.getTime() + 6 * MINUTE),
      });
      tl(win.id, new Date(tDetect.getTime() + 6 * MINUTE), 'deploy_noted', commander, {
        deployId: id,
        serviceSlug: slug,
        version: `2026.${pad(localParts(deployAt).month)}.${String(deployNo)}`,
      });
    }

    rows('incident').push({
      id: win.id,
      title: theme.title,
      severity: win.severity,
      status,
      commander_id: commander.id,
      root_cause: ongoing ? null : theme.cause,
      postmortem_article_id: null,
      discord_thread_state: 'skipped',
      discord_channel_id: null,
      discord_thread_id: null,
      status_page_visible: win.severity === 'SEV1' || win.severity === 'SEV2',
      started_at: tDetect,
      resolved_at: win.resolvedAt,
      created_by: commander.id,
      created_at: tDetect,
      updated_at: win.resolvedAt ?? now,
    });
    for (const slug of theme.services)
      rows('incident_service').push({ incident_id: win.id, service_id: serviceId(slug) });
    for (const orgIndex of win.orgIndexes)
      rows('incident_org').push({
        incident_id: win.id,
        org_id: world.orgs[orgIndex]?.id,
        source: 'ticket',
      });

    tl(win.id, tDetect, 'created', commander, { severity: win.severity, title: theme.title });
    audit(tDetect, AUDIT_ACTIONS.incidentCreate, commander, 'incident', win.id, {
      severity: win.severity,
    });
    for (const slug of theme.services)
      tl(win.id, new Date(tDetect.getTime() + 1000), 'service_added', commander, {
        serviceSlug: slug,
      });
    tl(win.id, new Date(tDetect.getTime() + 3 * MINUTE), 'commander_changed', null, {
      to: commander.id,
    });
    linked.slice(0, 8).forEach((b, i) => {
      tl(
        win.id,
        new Date(
          Math.max(b.sim.createdAt.getTime() + 20 * MINUTE, tDetect.getTime() + (10 + i) * MINUTE),
        ),
        'ticket_linked',
        commander,
        { ticketId: b.sim.id, key: `${reference.ticketKeyPrefix}-${String(b.sim.number)}` },
      );
    });
    tl(
      win.id,
      tDetect.getTime() + 12 * MINUTE > now.getTime()
        ? tDetect
        : new Date(tDetect.getTime() + 12 * MINUTE),
      'note',
      commander,
      {
        text: 'Investigating. Initial customer reports match the alerts; checking the last changes on the affected services.',
      },
    );
    tl(win.id, tIdent, 'status_changed', commander, { from: 'investigating', to: 'identified' });
    tl(win.id, new Date(tIdent.getTime() + 4 * MINUTE), 'note', commander, {
      text: ongoing
        ? 'Cause identified; a fix is being rolled out. Watching error rates.'
        : `Cause identified: ${theme.cause.split('.')[0] ?? 'see root cause'}.`,
    });
    tl(win.id, tMon, 'status_changed', commander, { from: 'identified', to: 'monitoring' });
    if (!ongoing) {
      tl(win.id, win.resolvedAt, 'status_changed', commander, {
        from: 'monitoring',
        to: 'resolved',
      });
      audit(win.resolvedAt, AUDIT_ACTIONS.incidentResolve, commander, 'incident', win.id);
    }
    audit(tIdent, AUDIT_ACTIONS.incidentUpdate, commander, 'incident', win.id, {
      status: 'identified',
    });
    for (const b of linked.slice(0, 8))
      audit(
        new Date(tDetect.getTime() + 15 * MINUTE),
        AUDIT_ACTIONS.incidentLinkTicket,
        commander,
        'incident',
        win.id,
        { ticketId: b.sim.id },
      );

    // updates to the affected customers (a person sends; an AI drafted some)
    if (
      win.severity === 'SEV1' ||
      win.severity === 'SEV2' ||
      (win.severity === 'SEV3' && rng.chance(0.4))
    ) {
      const parts: { at: Date; en: string; th: string }[] = [
        {
          at: new Date(tDetect.getTime() + 25 * MINUTE),
          en: `We are investigating an issue affecting ${theme.services.join(', ')}. Our engineers are working on it and we will update you within 30 minutes.`,
          th: `ขณะนี้เรากำลังตรวจสอบปัญหาที่กระทบ ${theme.services.join(', ')} ทีมวิศวกรกำลังแก้ไข และจะแจ้งความคืบหน้าภายใน 30 นาที`,
        },
      ];
      if (!ongoing) {
        parts.push({
          at: new Date(win.resolvedAt.getTime() + 10 * MINUTE),
          en: 'The issue has been resolved and the service is operating normally. We apologise for the disruption; a summary will be available on request.',
          th: 'ปัญหาได้รับการแก้ไขแล้วและบริการกลับมาทำงานเป็นปกติ ขออภัยในความไม่สะดวก สามารถขอสรุปเหตุการณ์ได้ตามต้องการ',
        });
      }
      for (const part of parts) {
        if (part.at.getTime() > now.getTime()) continue;
        const recipients = linked.filter(
          (b) =>
            b.sim.createdAt.getTime() < part.at.getTime() &&
            b.sim.status !== 'merged' &&
            (b.sim.resolvedAt === null || b.sim.resolvedAt.getTime() > part.at.getTime()),
        );
        if (recipients.length === 0) continue;
        const commId = rng.uuid();
        const aiOrigin = rng.chance(0.4);
        const sender = commander;
        rows('incident_comm').push({
          id: commId,
          incident_id: win.id,
          body: part.en,
          origin: aiOrigin ? 'ai' : 'human',
          status: 'sent',
          drafted_by: aiOrigin ? null : sender.id,
          sent_by: sender.id,
          confirmed_recipients: recipients.length,
          recipient_ticket_ids: recipients.map((b) => b.sim.id),
          sent_at: part.at,
          created_at: new Date(part.at.getTime() - 6 * MINUTE),
        });
        tl(
          win.id,
          new Date(part.at.getTime() - 6 * MINUTE),
          'comms_drafted',
          aiOrigin ? null : sender,
          { commId, origin: aiOrigin ? 'ai' : 'human' },
        );
        tl(win.id, part.at, 'comms_sent', sender, { commId, recipients: recipients.length });
        audit(part.at, AUDIT_ACTIONS.incidentCommSend, sender, 'incident', win.id, {
          commId,
          recipients: recipients.length,
        });
        for (const b of recipients) {
          const messageId = rng.uuid();
          const body = b.sim.lang === 'th' ? part.th : part.en;
          const html =
            b.sim.channel === 'gmail'
              ? renderMail({
                  style: 'composer',
                  lang: b.sim.lang,
                  paragraphs: [body],
                  signature: [sender.name, sender.title, 'Watchtower Tech Ops'],
                })
              : null;
          b.messages.push({
            id: messageId,
            ticket_id: b.sim.id,
            channel_account_id: b.ticket.channel_account_id,
            direction: 'outbound',
            external_id: b.ticket.channel_account_id
              ? `seed-y-${String(b.sim.number)}-inc-${commId.slice(0, 8)}`
              : null,
            thread_key: null,
            sender_contact_id: null,
            sender_user_id: sender.id,
            body_text: html ? html.text : body,
            body_html: html ? html.html : null,
            body_redacted: null,
            attachments: [],
            visibility: 'public',
            delivery_status: 'delivered',
            created_at: part.at,
            email_meta: html
              ? {
                  from: { address: 'support@helpdesk.example.com', name: sender.name },
                  to: [{ address: b.sim.contact.email, name: b.sim.contact.name }],
                  cc: [],
                  bcc: [],
                  subject: `Re: ${b.sim.subject}`,
                }
              : null,
          });
          if ((b.ticket.updated_at as Date).getTime() < part.at.getTime())
            b.ticket.updated_at = part.at;
          rows('incident_comm_delivery').push({
            comm_id: commId,
            ticket_id: b.sim.id,
            state: 'sent',
            message_id: messageId,
            reason: null,
            created_at: part.at,
          });
        }
      }
    }

    // public status posts
    if (win.severity === 'SEV1' || win.severity === 'SEV2') {
      const phases: {
        phase: 'investigating' | 'identified' | 'monitoring' | 'resolved';
        at: Date;
        body: string;
        impact: 'minor' | 'major' | 'critical';
      }[] = [
        {
          phase: 'investigating',
          at: new Date(tDetect.getTime() + 15 * MINUTE),
          body: `We are investigating reports of degraded service: ${theme.title.toLowerCase()}.`,
          impact: win.severity === 'SEV1' ? 'major' : 'minor',
        },
        {
          phase: 'identified',
          at: tIdent,
          body: 'The cause has been identified and a fix is being applied.',
          impact: win.severity === 'SEV1' ? 'major' : 'minor',
        },
        {
          phase: 'monitoring',
          at: tMon,
          body: 'A fix has been deployed. We are monitoring the results.',
          impact: 'minor',
        },
      ];
      if (!ongoing)
        phases.push({
          phase: 'resolved',
          at: new Date(win.resolvedAt.getTime() + 5 * MINUTE),
          body: 'This incident has been resolved. Thank you for your patience.',
          impact: 'minor',
        });
      for (const post of phases) {
        if (post.at.getTime() > now.getTime()) continue;
        const postId = rng.uuid();
        const origin = rng.chance(0.3) ? 'ai' : 'human';
        rows('status_post').push({
          id: postId,
          incident_id: win.id,
          title: theme.title,
          body: post.body,
          phase: post.phase,
          impact: post.impact,
          state: 'published',
          origin,
          drafted_by: origin === 'human' ? commander.id : null,
          published_by: commander.id,
          published_at: post.at,
          created_at: new Date(post.at.getTime() - 4 * MINUTE),
          updated_at: post.at,
        });
        for (const slug of theme.services) {
          rows('status_post_component').push({
            post_id: postId,
            component_id: componentIds.get(slug),
          });
        }
      }
    }
  });

  // --- background alerts across the year ---
  const quiet = rng.fork('alerts');
  for (let ts = input.start.getTime(); ts < now.getTime(); ts += DAY) {
    const day = new Date(ts);
    const p = localParts(day);
    const mean = isOffDay(p.dateKey, p.weekday, reference.holidays) ? 0.9 : 1.5;
    const n = quiet.count(mean * (1 + ((ts - input.start.getTime()) / (365 * DAY)) * 0.4));
    for (let i = 0; i < n; i += 1) {
      const svc = quiet.pick(SERVICES);
      const at = bangkokTime(
        p.dateKey,
        quiet.weighted(
          Array.from({ length: 24 }, (_, h) => [h, h >= 8 && h <= 20 ? 3 : 1] as const),
        ),
        quiet.int(0, 59),
      );
      if (at.getTime() > now.getTime() - 20 * MINUTE) continue;
      const severity = quiet.weighted<'critical' | 'error' | 'warning' | 'info'>([
        ['warning', 46],
        ['error', 28],
        ['critical', 8],
        ['info', 14],
      ]);
      const recent = now.getTime() - at.getTime() < 2 * DAY && quiet.chance(0.15);
      addAlert({
        at,
        service: svc.slug,
        title: quiet.pick(svc.alertTitles),
        severity,
        durationMin: Math.round(quiet.logNormal(24, 0.9)) + 2,
        ack: severity !== 'info' && quiet.chance(0.85),
        incidentId: null,
        correlationId: null,
        ongoing: recent,
      });
    }
  }
  const alertsOpen = alertRowsList
    .filter((a) => a.state !== 'resolved')
    .map((a) => ({
      id: a.id as string,
      title: a.title as string,
      severity: a.severity as string,
      at: a.first_seen_at as Date,
    }));

  // --- status page ---
  const compNames = new Map<string, string>();
  for (const svc of SERVICES) compNames.set(svc.slug, svc.components);
  let position = 0;
  for (const svc of SERVICES) {
    position += 1;
    const degraded = input.windows.some(
      (w, i) => w.resolvedAt === null && input.themes[i]?.services.includes(svc.slug),
    );
    rows('status_component').push({
      id: componentIds.get(svc.slug),
      slug: svc.slug,
      name: svc.components,
      description: `${svc.name} availability`,
      service_id: serviceId(svc.slug),
      public: true,
      position,
      status: degraded ? 'degraded_performance' : 'operational',
      created_at: input.start,
      updated_at: now,
    });
  }
  // maintenance windows: three completed, one upcoming
  const maintenance = [
    {
      daysAgo: 270,
      title: 'Database minor version upgrade',
      slugs: ['batch-processor', 'reporting-service'],
    },
    {
      daysAgo: 150,
      title: 'Gateway certificate and TLS configuration update',
      slugs: ['api-gateway'],
    },
    { daysAgo: 62, title: 'Storage migration for report exports', slugs: ['reporting-service'] },
    {
      daysAgo: -6,
      title: 'Scheduled maintenance of the notification relay',
      slugs: ['notification-relay'],
    },
  ];
  for (const m of maintenance) {
    const p = localParts(new Date(now.getTime() - m.daysAgo * DAY));
    const startsAt = bangkokTime(p.dateKey, 1, 0);
    const maintenanceId = rng.uuid();
    const person = rng.pick(leadsAndHeads);
    rows('status_maintenance').push({
      id: maintenanceId,
      title: m.title,
      body: `${m.title}. Short interruptions are possible during the window.`,
      starts_at: startsAt,
      ends_at: new Date(startsAt.getTime() + 2 * HOUR),
      state: 'published',
      origin: 'human',
      drafted_by: person.id,
      published_by: person.id,
      published_at: new Date(startsAt.getTime() - 5 * DAY),
      cancelled_at: null,
      created_at: new Date(startsAt.getTime() - 6 * DAY),
      updated_at: new Date(startsAt.getTime() - 5 * DAY),
    });
    for (const slug of m.slugs)
      rows('status_maintenance_component').push({
        maintenance_id: maintenanceId,
        component_id: componentIds.get(slug),
      });
  }

  return { tables: t, incidentInfo, alertsOpen };
}
