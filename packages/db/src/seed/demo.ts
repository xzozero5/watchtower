import {
  AUDIT_ACTIONS,
  TICKET_EVENT_TYPES,
  formatTicketKey,
  holidaySchema,
  slaTargetsSchema,
  weeklyHoursSchema,
  type BusinessCalendar,
} from '@watchtower/shared';
import { and, arrayContains, eq, inArray, sql } from 'drizzle-orm';

import { auditLog } from '../schema/audit.js';
import { users } from '../schema/auth.js';
import {
  businessCalendar,
  channelAccount,
  contact,
  intent,
  message,
  organization,
  slaPolicy,
  teamQueue,
  teamQueueMember,
  ticket,
  ticketEvent,
} from '../schema/ticketing.js';
import { SeedError } from './common.js';
import {
  DEMO_ORGS,
  DEMO_QUEUES,
  DEMO_STAFF,
  DEMO_TICKETS,
  ORG_KEYS,
  type OrgKey,
  type QueueKey,
  type StaffKey,
} from './demo-data.js';
import type { SeedExecutor } from './reference.js';
import {
  mergeTime,
  planTicket,
  type PlanContext,
  type PlanPolicy,
  type PlannedTicket,
} from './tickets.js';

export interface DemoSeedOptions {
  /** The moment "now" is for the demo data: tickets are dated backwards from it. */
  readonly now: Date;
  /** Prefix of the ticket key written into merge events (`TICKET_KEY_PREFIX`). */
  readonly ticketKeyPrefix: string;
}

export interface DemoSeedResult {
  readonly users: number;
  readonly organizations: number;
  readonly contacts: number;
  readonly queues: number;
  readonly tickets: number;
  readonly messages: number;
  readonly events: number;
  readonly audits: number;
  readonly merges: number;
}

const SYSTEM_ACTOR = { type: 'system', id: 'seed' } as const;
const calendarHours = weeklyHoursSchema;
const holidayList = holidaySchema.array();
const BATCH = 200;

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += BATCH)
    out.push(items.slice(index, index + BATCH));
  return out;
}

/** Start of the oldest monthly partition of `table`, so no seeded row lands in the default partition. */
async function earliestPartitionStart(executor: SeedExecutor, table: string): Promise<Date | null> {
  const result = await executor.execute<{ start: Date | string | null }>(
    sql`SELECT min(to_date(substring(c.relname from '_p(\\d{6})$'), 'YYYYMM')::timestamp AT TIME ZONE 'UTC') AS start
        FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = ${table}::regclass AND c.relname ~ '_p\\d{6}$'`,
  );
  const value = result.rows[0]?.start;
  return value === null || value === undefined ? null : new Date(value);
}

async function audited(
  executor: SeedExecutor,
  rows: { action: string; targetType: string; targetId: string; after: Record<string, unknown> }[],
  now: Date,
): Promise<number> {
  for (const part of chunks(rows)) {
    await executor.insert(auditLog).values(
      part.map((row) => ({
        createdAt: now,
        actorType: SYSTEM_ACTOR.type,
        actorId: SYSTEM_ACTOR.id,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        after: row.after,
        metadata: { seed: true },
      })),
    );
  }
  return rows.length;
}

/**
 * Fictional organizations, people, queues and about thirty tickets (`demo-data.ts`). Safe to run
 * again: everything is looked up by a natural key (user and contact address, organization and queue
 * name, the `seed-demo-NN` provider id of a ticket's first message) and only what is missing is
 * created, so a second run changes nothing and edits made since are kept. Writes to the database
 * only; nothing leaves the machine.
 */
export async function seedDemo(
  executor: SeedExecutor,
  options: DemoSeedOptions,
): Promise<DemoSeedResult> {
  const created = {
    users: 0,
    organizations: 0,
    contacts: 0,
    queues: 0,
    tickets: 0,
    messages: 0,
    events: 0,
    audits: 0,
    merges: 0,
  };

  // --- staff and queues ---
  const staffIds = {} as Record<StaffKey, string>;
  const newUsers: { id: string; email: string; role: string }[] = [];
  for (const person of DEMO_STAFF) {
    const [inserted] = await executor
      .insert(users)
      .values({ email: person.email, name: person.name, role: person.role })
      .onConflictDoNothing({ target: users.email })
      .returning({ id: users.id });
    if (inserted) newUsers.push({ id: inserted.id, email: person.email, role: person.role });
    const [row] = await executor
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, person.email))
      .limit(1);
    if (!row) throw new SeedError(`user ${person.email} was not created`);
    staffIds[person.key] = row.id;
  }

  const queueIds = {} as Record<QueueKey, string>;
  const [existingDefault] = await executor
    .select({ id: teamQueue.id })
    .from(teamQueue)
    .where(eq(teamQueue.isDefault, true))
    .limit(1);
  let hasDefault = existingDefault !== undefined;
  const newQueues: { id: string; name: string }[] = [];
  for (const queue of DEMO_QUEUES) {
    const [found] = await executor
      .select({ id: teamQueue.id })
      .from(teamQueue)
      .where(sql`lower(${teamQueue.name}) = lower(${queue.name})`)
      .limit(1);
    let id = found?.id;
    if (id === undefined) {
      const makeDefault = queue.isDefault && !hasDefault;
      const [inserted] = await executor
        .insert(teamQueue)
        .values({ name: queue.name, assignmentMode: 'manual', isDefault: makeDefault })
        .returning({ id: teamQueue.id });
      if (!inserted) throw new SeedError(`queue ${queue.name} was not created`);
      id = inserted.id;
      hasDefault = hasDefault || makeDefault;
      newQueues.push({ id, name: queue.name });
    }
    queueIds[queue.key] = id;
    await executor
      .insert(teamQueueMember)
      .values(queue.members.map((member) => ({ queueId: id, userId: staffIds[member] })))
      .onConflictDoNothing();
  }

  // --- organizations, contacts, client users ---
  const orgIds = {} as Record<OrgKey, string>;
  const clientUserIds = {} as Record<OrgKey, string>;
  const contactIds = new Map<string, string>();
  const newOrgs: { id: string; name: string }[] = [];
  const newContacts: { id: string; orgId: string }[] = [];
  for (const demoOrg of DEMO_ORGS) {
    const [found] = await executor
      .select({ id: organization.id })
      .from(organization)
      .where(sql`lower(${organization.name}) = lower(${demoOrg.name})`)
      .limit(1);
    let orgId = found?.id;
    let orgIsNew = false;
    if (orgId === undefined) {
      const [inserted] = await executor
        .insert(organization)
        .values({
          name: demoOrg.name,
          tier: demoOrg.tier,
          domains: [...demoOrg.domains],
          notes: demoOrg.notes,
        })
        .returning({ id: organization.id });
      if (!inserted) throw new SeedError(`organization ${demoOrg.name} was not created`);
      orgId = inserted.id;
      orgIsNew = true;
      newOrgs.push({ id: orgId, name: demoOrg.name });
    }
    orgIds[demoOrg.key] = orgId;

    for (const [index, person] of demoOrg.contacts.entries()) {
      const [existing] = await executor
        .select({ id: contact.id })
        .from(contact)
        .where(arrayContains(contact.emails, [person.email]))
        .limit(1);
      let contactId = existing?.id;
      if (contactId === undefined) {
        const [inserted] = await executor
          .insert(contact)
          .values({
            orgId,
            name: person.name,
            emails: [person.email],
            roleInOrg: person.roleInOrg,
          })
          .returning({ id: contact.id });
        if (!inserted) throw new SeedError(`contact ${person.email} was not created`);
        contactId = inserted.id;
        newContacts.push({ id: contactId, orgId });
      }
      contactIds.set(`${demoOrg.key}:${String(index)}`, contactId);
    }
    if (orgIsNew) {
      const first = contactIds.get(`${demoOrg.key}:0`);
      if (first) {
        await executor
          .update(organization)
          .set({ primaryContactId: first })
          .where(eq(organization.id, orgId));
      }
    }

    const [insertedClient] = await executor
      .insert(users)
      .values({
        email: demoOrg.clientUser.email,
        name: demoOrg.clientUser.name,
        role: 'client',
        orgId,
      })
      .onConflictDoNothing({ target: users.email })
      .returning({ id: users.id });
    if (insertedClient) {
      newUsers.push({ id: insertedClient.id, email: demoOrg.clientUser.email, role: 'client' });
    }
    const [clientRow] = await executor
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, demoOrg.clientUser.email))
      .limit(1);
    if (!clientRow) throw new SeedError(`client user ${demoOrg.clientUser.email} was not created`);
    clientUserIds[demoOrg.key] = clientRow.id;
  }

  created.users = newUsers.length;
  created.organizations = newOrgs.length;
  created.contacts = newContacts.length;
  created.queues = newQueues.length;
  created.audits += await audited(
    executor,
    [
      ...newUsers.map((row) => ({
        action: AUDIT_ACTIONS.userCreate,
        targetType: 'user',
        targetId: row.id,
        after: { id: row.id, role: row.role },
      })),
      ...newOrgs.map((row) => ({
        action: AUDIT_ACTIONS.orgCreate,
        targetType: 'organization',
        targetId: row.id,
        after: { id: row.id },
      })),
      ...newContacts.map((row) => ({
        action: AUDIT_ACTIONS.contactCreate,
        targetType: 'contact',
        targetId: row.id,
        after: { id: row.id, orgId: row.orgId },
      })),
      ...newQueues.map((row) => ({
        action: AUDIT_ACTIONS.queueCreate,
        targetType: 'team_queue',
        targetId: row.id,
        after: { id: row.id },
      })),
    ],
    options.now,
  );

  // --- what tickets need to know ---
  const [portal] = await executor
    .select({ id: channelAccount.id })
    .from(channelAccount)
    .where(eq(channelAccount.type, 'portal'))
    .limit(1);
  if (!portal) throw new SeedError('the portal channel account is missing (migration 0002)');

  const intentRows = await executor.select().from(intent);
  const intents = new Map(
    intentRows.map((row) => [
      row.key,
      {
        id: row.id,
        key: row.key,
        defaultPriority: row.defaultPriority,
        autonomyStage: row.autonomyStage,
      },
    ]),
  );

  const orgContext = {} as Record<
    OrgKey,
    { id: string; policy: PlanPolicy | null; clientUserId: string }
  >;
  for (const key of ORG_KEYS) {
    const [org] = await executor
      .select({ tier: organization.tier, slaPolicyId: organization.slaPolicyId })
      .from(organization)
      .where(eq(organization.id, orgIds[key]))
      .limit(1);
    // Same precedence as the API: the organization's own policy, else the policy of its tier.
    const [policyRow] = await executor
      .select()
      .from(slaPolicy)
      .where(
        org?.slaPolicyId
          ? eq(slaPolicy.id, org.slaPolicyId)
          : eq(slaPolicy.tier, org?.tier ?? 'standard'),
      )
      .limit(1);
    let policy: PlanPolicy | null = null;
    if (policyRow) {
      const targets = slaTargetsSchema.parse(policyRow.targets);
      const [calendarRow] = policyRow.businessCalendarId
        ? await executor
            .select()
            .from(businessCalendar)
            .where(eq(businessCalendar.id, policyRow.businessCalendarId))
            .limit(1)
        : [];
      if (!calendarRow)
        throw new SeedError(`SLA policy ${policyRow.name} has no business calendar`);
      const calendar: BusinessCalendar = {
        timezone: calendarRow.timezone,
        hours: calendarHours.parse(calendarRow.hours),
        holidays: holidayList.parse(calendarRow.holidays).map((holiday) => holiday.date),
      };
      policy = { id: policyRow.id, targets, calendar };
    }
    orgContext[key] = { id: orgIds[key], policy, clientUserId: clientUserIds[key] };
  }

  const floors = await Promise.all([
    earliestPartitionStart(executor, 'ticket_event'),
    earliestPartitionStart(executor, 'audit_log'),
  ]);
  const floor = new Date(Math.max(0, ...floors.map((date) => date?.getTime() ?? 0)));

  const context: PlanContext = {
    now: options.now,
    floor,
    channelAccountId: portal.id,
    orgs: orgContext,
    contactId: (org, index) => {
      const id = contactIds.get(`${org}:${String(index)}`);
      if (!id) throw new SeedError(`no contact ${String(index)} in ${org}`);
      return id;
    },
    staff: staffIds,
    queues: queueIds,
    intents,
  };

  // --- tickets ---
  const externalIds = DEMO_TICKETS.map((spec) => `seed-${spec.key}`);
  const existingRows = await executor
    .select({ externalId: message.externalId, ticketId: message.ticketId })
    .from(message)
    .where(and(eq(message.channelAccountId, portal.id), inArray(message.externalId, externalIds)));
  const existingTicketIds = new Map(
    existingRows.map((row) => [row.externalId ?? '', row.ticketId]),
  );

  const planned: PlannedTicket[] = [];
  for (const spec of DEMO_TICKETS) {
    if (existingTicketIds.has(`seed-${spec.key}`)) continue;
    planned.push(planTicket(spec, context));
  }
  // Oldest first, so ticket numbers grow with age like they would have.
  planned.sort(
    (a, b) => (a.ticket.createdAt?.getTime() ?? 0) - (b.ticket.createdAt?.getTime() ?? 0),
  );

  for (const part of chunks(planned)) {
    const inserted = await executor
      .insert(ticket)
      .values(part.map((entry) => entry.ticket))
      .returning({ id: ticket.id });
    created.tickets += inserted.length;
  }
  const allMessages = planned.flatMap((entry) => entry.messages);
  const allEvents = planned.flatMap((entry) => entry.events);
  const allAudits = planned.flatMap((entry) => entry.audits);
  for (const part of chunks(allMessages)) await executor.insert(message).values(part);
  for (const part of chunks(allEvents)) await executor.insert(ticketEvent).values(part);
  for (const part of chunks(allAudits)) await executor.insert(auditLog).values(part);
  created.messages = allMessages.length;
  created.events = allEvents.length;
  created.audits += allAudits.length;

  // --- merges (after every ticket exists, so the numbers are known) ---
  const byKey = new Map(planned.map((entry) => [entry.spec.key, entry]));
  const idOfKey = (key: string): string => {
    const entry = byKey.get(key);
    const id = entry?.id ?? existingTicketIds.get(`seed-${key}`);
    if (!id) throw new SeedError(`merge target ${key} does not exist`);
    return id;
  };
  const numberOf = async (id: string): Promise<number> => {
    const [row] = await executor
      .select({ number: ticket.number })
      .from(ticket)
      .where(eq(ticket.id, id))
      .limit(1);
    if (!row) throw new SeedError(`ticket ${id} vanished`);
    return row.number;
  };
  for (const entry of planned) {
    const merge = entry.spec.mergeInto;
    if (!merge) continue;
    const target = byKey.get(merge.key);
    if (target && (target.status === 'closed' || target.spec.mergeInto)) {
      throw new SeedError(
        `ticket ${entry.spec.key}: cannot merge into ${merge.key} (${target.status})`,
      );
    }
    if (target && target.spec.org !== entry.spec.org) {
      throw new SeedError(`ticket ${entry.spec.key}: merging across organizations`);
    }
    const targetId = idOfKey(merge.key);
    const at = mergeTime(entry, options.now);
    const before = { ...entry.ticket, id: entry.id };
    await executor
      .update(ticket)
      .set({ status: 'merged', parentTicketId: targetId, slaPausedAt: null, updatedAt: at })
      .where(eq(ticket.id, entry.id));
    await executor
      .update(ticket)
      .set({ updatedAt: at })
      .where(
        and(eq(ticket.id, targetId), sql`${ticket.updatedAt} < ${at.toISOString()}::timestamptz`),
      );
    const targetKey = formatTicketKey(await numberOf(targetId), options.ticketKeyPrefix);
    const sourceKey = formatTicketKey(await numberOf(entry.id), options.ticketKeyPrefix);
    const actor = { type: 'user', id: entry.ticket.assigneeId ?? null } as const;
    await executor.insert(ticketEvent).values([
      {
        ticketId: entry.id,
        createdAt: at,
        type: TICKET_EVENT_TYPES.merged,
        actorType: actor.type,
        actorId: actor.id,
        visibility: 'public',
        payload: { intoTicketId: targetId, intoKey: targetKey, reason: merge.reason },
      },
      {
        ticketId: targetId,
        createdAt: at,
        type: TICKET_EVENT_TYPES.mergeReceived,
        actorType: actor.type,
        actorId: actor.id,
        visibility: 'internal',
        payload: { fromTicketId: entry.id, fromKey: sourceKey, movedChildren: 0 },
      },
    ]);
    await executor.insert(auditLog).values({
      createdAt: at,
      actorType: actor.type,
      actorId: actor.id,
      action: AUDIT_ACTIONS.ticketMerge,
      outcome: 'success',
      targetType: 'ticket',
      targetId: entry.id,
      before: { id: entry.id, status: before.status, parentTicketId: null },
      after: { id: entry.id, status: 'merged', parentTicketId: targetId },
      metadata: { seed: true, intoTicketId: targetId, intoKey: targetKey, movedChildren: 0 },
    });
    created.merges += 1;
    created.events += 2;
    created.audits += 1;
  }

  return created;
}
