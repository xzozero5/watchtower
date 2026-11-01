import { randomUUID } from 'node:crypto';

import { schema } from '@watchtower/db';
import {
  INCIDENTS_AUDIT_ACTIONS,
  INCIDENTS_JOBS,
  INCIDENTS_TICKET_EVENTS,
  QUEUE_NAMES,
  formatIncidentKey,
  normalizedAlertSchema,
} from '@watchtower/shared';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { addOrg, addStaff, auditRows, startDomainTest } from '../testing/support.js';
import type { DomainTestEnv } from '../testing/support.js';
import type { Actor } from '../types.js';

// R-3.12 and R-5.4 against a real Postgres: an incident is a person's decision with a severity, services,
// alerts and tickets; its status moves forward and ends at `resolved`; its timeline is append-only; the
// deploy feed is idempotent.

let env: DomainTestEnv;

beforeAll(async () => {
  env = await startDomainTest();
});
afterAll(async () => {
  await env.close();
});

let counter = 0;
const SYSTEM = { type: 'system', id: null } as const;

async function addService(): Promise<{ id: string; slug: string }> {
  const slug = `svc-${randomUUID().slice(0, 8)}`;
  const [row] = await env.db.owner.db
    .insert(schema.service)
    .values({ slug, name: slug })
    .returning({ id: schema.service.id });
  if (row === undefined) throw new Error('no service');
  return { id: row.id, slug };
}

async function addAlert(): Promise<string> {
  counter += 1;
  const alert = normalizedAlertSchema.parse({
    source: 'alertmanager',
    providerEventId: `evt-${String(counter)}`,
    fingerprint: counter.toString(16).padStart(64, '0'),
    state: 'firing',
    severity: 'error',
    title: 'High error rate',
    summary: null,
    conditionName: null,
    labels: {},
    url: null,
    occurredAt: null,
    renotify: false,
    payload: {},
  });
  const outcome = (await env.tx((tx) => env.domain.alerts.ingest(tx, env.ctx(), { alert }))).value;
  if (outcome.kind !== 'opened') throw new Error('expected an opened alert');
  return outcome.alertId;
}

async function addTicket(orgId: string): Promise<string> {
  const { value } = await env.tx((tx) =>
    env.domain.tickets.create(tx, env.ctx({ type: 'user', id: null }), {
      orgId,
      subject: 'Checkout is failing',
      body: 'We cannot pay.',
      requester: { email: `${randomUUID()}@example.test`, name: 'Nok' },
    }),
  );
  return value.ticket.id;
}

const timelineOf = (incidentId: string) =>
  env.db.owner.db
    .select()
    .from(schema.incidentTimeline)
    .where(eq(schema.incidentTimeline.incidentId, incidentId))
    .orderBy(asc(schema.incidentTimeline.createdAt));

const incidentRow = async (incidentId: string) => {
  const [row] = await env.db.owner.db
    .select()
    .from(schema.incident)
    .where(eq(schema.incident.id, incidentId));
  if (row === undefined) throw new Error('no incident');
  return row;
};

const jobsOf = (incidentId: string) =>
  env.db.owner.db
    .select()
    .from(schema.outbox)
    .where(
      sql`${schema.outbox.queue} = ${QUEUE_NAMES.incidents} AND ${schema.outbox.payload}->>'incidentId' = ${incidentId}`,
    );

async function open(
  who: { actor: Actor },
  fields: Partial<Parameters<typeof env.domain.incidents.create>[2]> = {},
) {
  return (
    await env.tx((tx) =>
      env.domain.incidents.create(tx, env.ctx(who.actor), {
        title: 'Checkout errors',
        severity: 'SEV2',
        serviceIds: [],
        alertIds: [],
        ticketIds: [],
        orgIds: [],
        ...fields,
      }),
    )
  ).value;
}

describe('opening an incident (R-3.12)', () => {
  it('creates it with a number, the creator as commander, a timeline, a thread job and an audit row', async () => {
    const person = await addStaff(env, 'agent');
    const service = await addService();
    const alertId = await addAlert();
    const org = await addOrg(env);
    const ticketId = await addTicket(org.id);

    const created = await open(person, {
      serviceIds: [service.id],
      alertIds: [alertId],
      ticketIds: [ticketId],
    });
    expect(created.key).toMatch(/^INC-[0-9]+$/);
    const row = await incidentRow(created.incidentId);
    expect(formatIncidentKey(row.number)).toBe(created.key);
    expect(row).toMatchObject({
      severity: 'SEV2',
      status: 'investigating',
      commanderId: person.id,
      createdBy: person.id,
      discordThreadState: 'pending',
      discordThreadId: null,
      resolvedAt: null,
    });

    // Linked: the alert, the ticket (and its event), the service, the organization (inferred from the ticket).
    expect(
      (await env.db.owner.db.select().from(schema.alert).where(eq(schema.alert.id, alertId)))[0]
        ?.incidentId,
    ).toBe(created.incidentId);
    expect(
      (await env.db.owner.db.select().from(schema.ticket).where(eq(schema.ticket.id, ticketId)))[0]
        ?.incidentId,
    ).toBe(created.incidentId);
    const events = await env.db.owner.db
      .select()
      .from(schema.ticketEvent)
      .where(eq(schema.ticketEvent.ticketId, ticketId));
    expect(events.map((event) => event.type)).toContain(INCIDENTS_TICKET_EVENTS.incidentLinked);
    expect(
      await env.db.owner.db
        .select()
        .from(schema.incidentService)
        .where(eq(schema.incidentService.incidentId, created.incidentId)),
    ).toHaveLength(1);
    expect(
      (
        await env.db.owner.db
          .select()
          .from(schema.incidentOrg)
          .where(eq(schema.incidentOrg.incidentId, created.incidentId))
      ).map((entry) => [entry.orgId, entry.source]),
    ).toEqual([[org.id, 'ticket']]);

    expect((await timelineOf(created.incidentId)).map((entry) => entry.type).toSorted()).toEqual(
      ['alert_linked', 'created', 'ticket_linked'].toSorted(),
    );

    const jobs = await jobsOf(created.incidentId);
    // BullMQ refuses a job id with a colon: the relay would never hand these jobs to the queue.
    expect(jobs.every((job) => !job.jobId.includes(':'))).toBe(true);
    expect(jobs.map((job) => job.jobName).toSorted()).toEqual(
      [INCIDENTS_JOBS.mirror, INCIDENTS_JOBS.thread].toSorted(),
    );
    expect(
      (await auditRows(env, INCIDENTS_AUDIT_ACTIONS.incidentCreate)).filter(
        (entry) => entry.targetId === created.incidentId,
      ),
    ).toHaveLength(1);
  });

  it('numbers incidents one after another and never repeats a number', async () => {
    const person = await addStaff(env, 'agent');
    const first = await open(person);
    const second = await open(person);
    const numbers = [first, second].map((entry) => Number(entry.key.slice('INC-'.length)));
    expect(numbers[1]).toBeGreaterThan(numbers[0] ?? 0);
  });

  it('is a person’s decision: the system and an unknown commander are refused', async () => {
    const person = await addStaff(env, 'agent');
    await expect(
      env.tx((tx) =>
        env.domain.incidents.create(tx, env.ctx(SYSTEM), {
          title: 'x',
          severity: 'SEV3',
          serviceIds: [],
          alertIds: [],
          ticketIds: [],
          orgIds: [],
        }),
      ),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await expect(open(person, { commanderId: randomUUID() })).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(open(person, { serviceIds: [randomUUID()] })).rejects.toMatchObject({
      code: 'bad_request',
    });
  });

  it('an alert or a ticket already in another incident is refused, and nothing is half-made', async () => {
    const person = await addStaff(env, 'agent');
    const alertId = await addAlert();
    const first = await open(person, { alertIds: [alertId] });
    await expect(open(person, { alertIds: [alertId] })).rejects.toMatchObject({ code: 'conflict' });
    // The failed attempt rolled back whole: no second incident took the number.
    const all = await env.db.owner.db.select().from(schema.incident);
    expect(all.filter((entry) => entry.id === first.incidentId)).toHaveLength(1);
    expect(
      (await env.db.owner.db.select().from(schema.alert).where(eq(schema.alert.id, alertId)))[0]
        ?.incidentId,
    ).toBe(first.incidentId);
  });
});

describe('changing an incident', () => {
  const update = (
    who: { actor: Actor },
    incidentId: string,
    change: Record<string, unknown>,
    canResolve = false,
  ) =>
    env.tx((tx) =>
      env.domain.incidents.update(tx, env.ctx(who.actor), {
        incidentId,
        canResolve,
        ...change,
      }),
    );

  it('moves forward, back among the open statuses, and ends at resolved with the database clock', async () => {
    const person = await addStaff(env, 'agent');
    const lead = await addStaff(env, 'lead');
    const { incidentId } = await open(person);
    await update(person, incidentId, { status: 'identified' });
    await update(person, incidentId, { status: 'investigating' });
    await update(person, incidentId, {
      status: 'monitoring',
      severity: 'SEV3',
      rootCause: 'A bad deploy',
    });
    await expect(update(person, incidentId, { status: 'monitoring' })).rejects.toMatchObject({
      code: 'invalid_transition',
    });
    // Resolving needs the permission to close incidents.
    await expect(update(person, incidentId, { status: 'resolved' })).rejects.toMatchObject({
      code: 'bad_request',
    });
    await update(lead, incidentId, { status: 'resolved' }, true);

    const row = await incidentRow(incidentId);
    expect(row).toMatchObject({ status: 'resolved', severity: 'SEV3', rootCause: 'A bad deploy' });
    expect(row.resolvedAt).not.toBeNull();
    // Final: nothing changes a resolved incident.
    await expect(update(lead, incidentId, { status: 'investigating' }, true)).rejects.toMatchObject(
      {
        code: 'conflict',
      },
    );
    const types = (await timelineOf(incidentId)).map((entry) => entry.type);
    expect(types.filter((type) => type === 'status_changed')).toHaveLength(4);
    expect(types).toContain('severity_changed');
    expect(
      (await auditRows(env, INCIDENTS_AUDIT_ACTIONS.incidentResolve)).filter(
        (entry) => entry.targetId === incidentId,
      ),
    ).toHaveLength(1);
  });

  it('the commander must be active staff, and a change of commander is on the timeline', async () => {
    const person = await addStaff(env, 'agent');
    const other = await addStaff(env, 'lead');
    const org = await addOrg(env);
    const [clientUser] = await env.db.owner.db
      .insert(schema.users)
      .values({
        email: `${randomUUID()}@example.test`,
        name: 'Client',
        role: 'client',
        orgId: org.id,
      })
      .returning({ id: schema.users.id });
    const { incidentId } = await open(person);
    await expect(
      update(person, incidentId, { commanderId: clientUser?.id ?? '' }),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await update(person, incidentId, { commanderId: other.id });
    expect((await incidentRow(incidentId)).commanderId).toBe(other.id);
    expect((await timelineOf(incidentId)).map((entry) => entry.type)).toContain(
      'commander_changed',
    );
  });

  it('links and unlinks a ticket; a ticket belongs to one incident; resolved incidents take nothing new', async () => {
    const person = await addStaff(env, 'agent');
    const org = await addOrg(env);
    const ticketId = await addTicket(org.id);
    const { incidentId } = await open(person);
    const other = await open(person);
    const link = (id: string) =>
      env.tx((tx) =>
        env.domain.incidents.linkTicket(tx, env.ctx(person.actor), { incidentId: id, ticketId }),
      );
    expect((await link(incidentId)).value.changed).toBe(true);
    expect((await link(incidentId)).value.changed).toBe(false);
    await expect(link(other.incidentId)).rejects.toMatchObject({ code: 'conflict' });
    const unlinked = await env.tx((tx) =>
      env.domain.incidents.unlinkTicket(tx, env.ctx(person.actor), { incidentId, ticketId }),
    );
    expect(unlinked.value.changed).toBe(true);
    expect((await link(other.incidentId)).value.changed).toBe(true);

    const lead = await addStaff(env, 'lead');
    await update(lead, other.incidentId, { status: 'resolved' }, true);
    await expect(link(other.incidentId)).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      env.tx((tx) =>
        env.domain.incidents.note(tx, env.ctx(person.actor), {
          incidentId: other.incidentId,
          text: 'late',
        }),
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('a note is on the timeline but is never queued for chat', async () => {
    const person = await addStaff(env, 'agent');
    const { incidentId } = await open(person);
    const before = (await jobsOf(incidentId)).length;
    await env.tx((tx) =>
      env.domain.incidents.note(tx, env.ctx(person.actor), {
        incidentId,
        text: 'Customer Acme reports the same error',
      }),
    );
    expect((await timelineOf(incidentId)).map((entry) => entry.type)).toContain('note');
    expect((await jobsOf(incidentId)).length).toBe(before);
  });
});

describe('the timeline is append-only', () => {
  it('the application role can add to it and can neither change nor delete an entry', async () => {
    const person = await addStaff(env, 'agent');
    const { incidentId } = await open(person);
    const entries = await timelineOf(incidentId);
    expect(entries.length).toBeGreaterThan(0);
    await expect(
      env.database.db
        .update(schema.incidentTimeline)
        .set({ type: 'note' })
        .where(eq(schema.incidentTimeline.incidentId, incidentId)),
    ).rejects.toThrow();
    await expect(
      env.database.db
        .delete(schema.incidentTimeline)
        .where(eq(schema.incidentTimeline.incidentId, incidentId)),
    ).rejects.toThrow();
  });
});

describe('the deploy feed (R-5.4)', () => {
  const record = (event: Record<string, unknown>) =>
    env.tx((tx) =>
      env.domain.incidents.recordDeploy(tx, env.ctx(SYSTEM), {
        id: `run-${randomUUID()}`,
        service: 'unset',
        version: '1.2.3',
        env: 'production',
        source: 'ci',
        actor: 'ci-bot',
        startedAt: null,
        finishedAt: null,
        url: null,
        ...event,
      }),
    );

  it('records a deploy once however often it is delivered', async () => {
    const service = await addService();
    const event = {
      id: `run-${randomUUID()}`,
      service: service.slug,
      finishedAt: '2026-11-02T03:00:00.000Z',
    };
    const first = await record(event);
    expect(first.value.recorded).toBe(true);
    const again = await record(event);
    expect(again.value).toEqual({ recorded: false, deployId: null });
    const rows = await env.db.owner.db
      .select()
      .from(schema.deploy)
      .where(eq(schema.deploy.serviceId, service.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      serviceSlug: service.slug,
      version: '1.2.3',
      env: 'production',
    });
    expect(rows[0]?.occurredAt?.toISOString()).toBe('2026-11-02T03:00:00.000Z');
    expect(
      (await auditRows(env, INCIDENTS_AUDIT_ACTIONS.deployRecord)).filter(
        (entry) => entry.targetId === first.value.deployId,
      ),
    ).toHaveLength(1);
  });

  it('refuses a service nobody catalogued, and a finish before the start', async () => {
    await expect(record({ service: 'no-such-service' })).rejects.toMatchObject({
      code: 'not_found',
    });
    const service = await addService();
    await expect(
      record({
        service: service.slug,
        startedAt: '2026-11-02T04:00:00.000Z',
        finishedAt: '2026-11-02T03:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('notes a deploy on the timeline of an open incident of that service, not of a resolved one', async () => {
    const person = await addStaff(env, 'agent');
    const lead = await addStaff(env, 'lead');
    const service = await addService();
    const openOne = await open(person, { serviceIds: [service.id] });
    const doneOne = await open(person, { serviceIds: [service.id] });
    await env.tx((tx) =>
      env.domain.incidents.update(tx, env.ctx(lead.actor), {
        incidentId: doneOne.incidentId,
        canResolve: true,
        status: 'resolved',
      }),
    );
    await record({ service: service.slug });
    expect((await timelineOf(openOne.incidentId)).map((entry) => entry.type)).toContain(
      'deploy_noted',
    );
    expect((await timelineOf(doneOne.incidentId)).map((entry) => entry.type)).not.toContain(
      'deploy_noted',
    );
  });
});
