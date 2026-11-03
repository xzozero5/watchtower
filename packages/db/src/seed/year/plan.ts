import { AUDIT_ACTIONS } from '@watchtower/shared';

import { planExtras } from './extras.js';
import { planKb } from './kb.js';
import { planIncidentWindows, planOps, serviceRows } from './ops.js';
import { DAY, Rng, addDays, localParts } from './prng.js';
import { Duty, buildRoster } from './roster.js';
import { planShifts } from './shifts.js';
import { EXTRA_HOLIDAYS, planTickets } from './tickets.js';
import type { Reference, Row, YearOptions, YearPlan } from './types.js';
import { buildWorld } from './world.js';

/** The default scenario seed: change it and a different (but equally deterministic) year comes out. */
export const DEFAULT_YEAR_SEED = 20261103;
export const DEFAULT_TICKET_TARGET = 3900;
/** Day (from the start) on which the team began to use the AI drafts. */
const AI_STARTS_AFTER_DAYS = 70;

export interface PlanYearInput extends YearOptions {
  readonly reference: Reference;
  /** First ticket number to use; the database sequence is moved past the last one afterwards. */
  readonly firstTicketNumber: number;
  readonly escalationPolicyId: string | null;
}

export interface YearPlanFull extends YearPlan {
  readonly primaryContacts: readonly { orgId: string; contactId: string }[];
}

/** Table names in insertion order (foreign keys point backwards). */
export const INSERT_ORDER = [
  'organization',
  'users',
  'contact',
  'team_queue_member',
  'kb_article',
  'kb_article_version',
  'kb_article_org',
  'outbox',
  'service',
  'incident',
  'incident_service',
  'incident_org',
  'deploy',
  'alert',
  'alert_event',
  'alert_escalation',
  'ticket',
  'message',
  'ticket_event',
  'incident_timeline',
  'incident_comm',
  'incident_comm_delivery',
  'status_component',
  'status_post',
  'status_post_component',
  'status_maintenance',
  'status_maintenance_component',
  'roster_entry',
  'shift_session',
  'handoff',
  'handoff_item',
  'shift_note',
  'shift_note_read',
  'ai_run',
  'ai_draft',
  'ai_ticket_insight',
  'csat_survey',
  'notification',
  'audit_log',
] as const;

export function planYear(input: PlanYearInput): YearPlanFull {
  const { reference, now } = input;
  const seed = input.seed ?? DEFAULT_YEAR_SEED;
  const rng = new Rng(seed);
  const start = new Date(now.getTime() - 365 * DAY);
  const holidays = new Set<string>([...reference.holidays, ...EXTRA_HOLIDAYS]);
  const refWithHolidays: Reference = { ...reference, holidays };

  const world = buildWorld(rng.fork('world'), now);
  const startKey = localParts(start).dateKey;
  // The roster runs a fortnight past today so the upcoming schedule exists too.
  const rosterEnd = addDays(localParts(now).dateKey, 14);
  const slots = buildRoster(
    rng.fork('roster'),
    world.staff,
    reference.shifts,
    startKey,
    rosterEnd,
    holidays,
  );
  const duty = new Duty(slots);

  const { windows, themes } = planIncidentWindows(
    rng.fork('incidents'),
    world,
    start,
    now,
    holidays,
  );
  const { bundles, files } = planTickets({
    rng: rng.fork('tickets'),
    world,
    reference: refWithHolidays,
    duty,
    now,
    start,
    target: input.ticketTarget ?? DEFAULT_TICKET_TARGET,
    incidents: windows,
    attachments: input.attachments === true,
    firstNumber: input.firstTicketNumber,
  });

  const kb = planKb({
    rng: rng.fork('kb'),
    world,
    now,
    start,
    windows,
    themes,
    ticketRefs: bundles
      .filter((b) => b.sim.status === 'closed' || b.sim.status === 'resolved')
      .slice(0, 400)
      .map((b) => ({ id: b.sim.id, intentKey: b.sim.intent.key, orgId: b.sim.org.id })),
  });

  const serviceIds = new Map<string, string>();
  const services = serviceRows(
    rng.fork('services'),
    {
      reference,
      escalationPolicyId: input.escalationPolicyId,
      runbookBySlug: kb.runbookBySlug,
      start,
    },
    serviceIds,
  );
  const ops = planOps({
    rng: rng.fork('ops'),
    world,
    reference: refWithHolidays,
    duty,
    now,
    start,
    windows,
    themes,
    bundles,
    escalationPolicyId: input.escalationPolicyId,
    runbookBySlug: kb.runbookBySlug,
    serviceIds,
  });

  const alertRows = ops.tables.get('alert') ?? [];
  const alertSummaries = alertRows.map((a) => ({
    id: a.id as string,
    title: a.title as string,
    severity: a.severity as string,
    at: a.first_seen_at as Date,
    resolvedAt: (a.resolved_at as Date | null) ?? null,
    service: String(a.service_id),
  }));
  const deployRows = ops.tables.get('deploy') ?? [];
  const shifts = planShifts({
    rng: rng.fork('shifts'),
    world,
    slots,
    tickets: bundles.map((b) => b.sim),
    incidents: ops.incidentInfo.map((i) => ({
      id: i.id,
      title: i.title,
      startedAt: i.startedAt,
      resolvedAt: i.resolvedAt,
      severity: i.severity,
    })),
    deploys: deployRows.map((d) => ({
      id: d.id as string,
      at: d.started_at as Date,
      slug: d.service_slug as string,
      version: d.version as string,
    })),
    alerts: alertSummaries,
    now,
  });

  const escalations = (ops.tables.get('alert_escalation') ?? []).map((e) => ({
    alertId: e.alert_id as string,
    level: e.level as number,
    at: e.created_at as Date,
  }));
  const extras = planExtras({
    rng: rng.fork('extras'),
    world,
    bundles,
    start,
    now,
    aiStartsAfterDays: AI_STARTS_AFTER_DAYS,
    alerts: alertSummaries,
    escalations,
  });

  // ---- people and organizations ----
  const owner = world.staff.find((s) => s.role === 'head') ?? world.staff[0];
  const users: Row[] = [];
  const audits: Row[] = [];
  const audit = (
    at: Date,
    action: string,
    targetType: string,
    targetId: string,
    after: Row,
  ): void => {
    // People and organizations that predate the year were loaded when the instance went live.
    audits.push({
      id: rng.uuid(),
      created_at: new Date(Math.max(at.getTime(), start.getTime() + audits.length * 1000)),
      actor_type: 'user',
      actor_id: owner?.id ?? null,
      action,
      outcome: 'success',
      target_type: targetType,
      target_id: targetId,
      before: null,
      after,
      ip: null,
      request_id: null,
      metadata: { seed: 'year' },
    });
  };
  for (const s of world.staff) {
    users.push({
      id: s.id,
      email: s.email,
      name: s.name,
      role: s.role,
      permissions: [],
      status: 'active',
      org_id: null,
      shift_preferences: {},
      is_break_glass: false,
      dev_created: false,
      last_login_at: new Date(
        now.getTime() - (s.role === 'head' ? 6 : 1) * 3600_000 * (1 + (s.key.length % 5)),
      ),
      created_at: s.createdAt,
      updated_at: s.createdAt,
    });
    audit(s.createdAt, AUDIT_ACTIONS.userCreate, 'user', s.id, { id: s.id, role: s.role });
  }
  const organizations: Row[] = [];
  const contacts: Row[] = [];
  const primaryContacts: { orgId: string; contactId: string }[] = [];
  for (const org of world.orgs) {
    organizations.push({
      id: org.id,
      name: org.name,
      tier: org.tier,
      sla_policy_id: null,
      domains: [org.domain],
      line_group_ids: org.lineGroupId ? [org.lineGroupId] : [],
      health_score: 55 + ((org.index * 7) % 40),
      notes: `Fictional ${org.industry} customer (${org.tier} tier) of the one-year demo scenario.`,
      status: 'active',
      created_at: org.createdAt,
      updated_at: org.createdAt,
    });
    audit(org.createdAt, AUDIT_ACTIONS.orgCreate, 'organization', org.id, { id: org.id });
    users.push({
      id: org.clientUser.id,
      email: org.clientUser.email,
      name: org.clientUser.name,
      role: 'client',
      permissions: [],
      status: 'active',
      org_id: org.id,
      shift_preferences: {},
      is_break_glass: false,
      dev_created: false,
      last_login_at: null,
      created_at: org.createdAt,
      updated_at: org.createdAt,
    });
    org.contacts.forEach((c, i) => {
      if (i === 0) primaryContacts.push({ orgId: org.id, contactId: c.id });
      contacts.push({
        id: c.id,
        org_id: org.id,
        name: c.name,
        emails: [c.email],
        line_user_id: c.lineUserId,
        phone: null,
        verified_at: new Date(c.createdAt.getTime() + DAY),
        role_in_org: c.roleInOrg,
        line_linked_via: c.lineUserId ? 'staff_code' : null,
        line_linked_at: c.lineUserId ? new Date(c.createdAt.getTime() + 3 * DAY) : null,
        line_verified_at: null,
        notification_prefs: {},
        created_at: c.createdAt,
        updated_at: c.createdAt,
      });
      audit(c.createdAt, AUDIT_ACTIONS.contactCreate, 'contact', c.id, { id: c.id, orgId: org.id });
    });
  }
  const queueMembers: Row[] = [];
  for (const s of world.staff) {
    for (const queue of s.queues) {
      const queueId = reference.queues[queue as 'Support' | 'Integrations' | 'Billing'];
      queueMembers.push({ queue_id: queueId, user_id: s.id, created_at: s.createdAt });
    }
  }

  // ---- assemble ----
  const tables = new Map<string, Row[]>();
  const add = (name: string, list: readonly Row[]): void => {
    const current = tables.get(name) ?? [];
    current.push(...list);
    tables.set(name, current);
  };
  add('users', users);
  add('organization', organizations);
  add('contact', contacts);
  add('team_queue_member', queueMembers);
  for (const [name, list] of kb.tables) add(name, list);
  add('service', services);
  for (const source of [ops.tables, shifts.tables, extras.tables]) {
    for (const [name, list] of source) add(name, list);
  }
  add('notification', shifts.notifications);
  add(
    'ticket',
    bundles.map((b) => b.ticket),
  );
  add(
    'message',
    bundles.flatMap((b) => b.messages),
  );
  add(
    'ticket_event',
    bundles.flatMap((b) => b.events),
  );
  add('audit_log', [...audits, ...bundles.flatMap((b) => b.audits)]);

  const summary: Record<string, number> = {};
  for (const name of INSERT_ORDER) summary[name] = tables.get(name)?.length ?? 0;
  return {
    tables,
    files,
    summary,
    primaryContacts,
  };
}
