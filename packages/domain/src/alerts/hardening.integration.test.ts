import { schema } from '@watchtower/db';
import { normalizedAlertSchema, type NormalizedAlert } from '@watchtower/shared';
import { randomUUID } from 'node:crypto';

import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isDomainError } from '../errors.js';
import { addOrg, addStaff, startDomainTest, type DomainTestEnv } from '../testing/support.js';

// Review of T-200 against a real Postgres: a close for an older occurrence leaves the newer alert
// open, every delivery that changes an alert is audited, and an internal ticket (no customer) can be
// neither answered, acknowledged nor surveyed.

let env: DomainTestEnv;
beforeAll(async () => {
  env = await startDomainTest();
});
afterAll(async () => {
  await env.close();
});

let counter = 0;
const fp = (n: number): string => (n + 900).toString(16).padStart(64, '0');

function make(
  fingerprintN: number,
  overrides: Partial<NormalizedAlert> = {},
  payload: Record<string, unknown> = {},
): NormalizedAlert {
  counter += 1;
  return normalizedAlertSchema.parse({
    source: 'gcp_monitoring',
    providerEventId: `h-${String(counter)}`,
    fingerprint: fp(fingerprintN),
    state: 'firing',
    severity: 'critical',
    title: 'High CPU',
    summary: 'CPU is high',
    conditionName: null,
    labels: {},
    url: null,
    occurredAt: null,
    renotify: false,
    payload: { kind: 'gcp_monitoring', ...payload },
    ...overrides,
  });
}

const ingest = (alert: NormalizedAlert) =>
  env
    .tx((tx) => env.domain.alerts.ingest(tx, env.ctx({ type: 'system', id: null }), { alert }))
    .then((r) => r.value);

const rows = (n: number) =>
  env.db.owner.db
    .select()
    .from(schema.alert)
    .where(eq(schema.alert.fingerprint, fp(n)));

describe('a close for an older occurrence', () => {
  it('GCP: closing incident A while incident B is the open one leaves the alert open', async () => {
    await ingest(make(1, {}, { incidentId: 'A' }));
    await ingest(make(1, {}, { incidentId: 'B' }));
    const stale = await ingest(make(1, { state: 'resolved' }, { incidentId: 'A' }));
    expect(stale).toEqual({ kind: 'ignored', reason: 'stale_generation' });
    const [open] = await rows(1);
    expect(open).toMatchObject({ state: 'open', count: 2 });
    expect(open?.payload).toMatchObject({ incidentId: 'B' });
    // The close of the incident that is open now does close it.
    expect((await ingest(make(1, { state: 'resolved' }, { incidentId: 'B' }))).kind).toBe(
      'resolved',
    );
    expect((await rows(1))[0]?.state).toBe('resolved');
  });

  it('Alertmanager: a resolved for an older startsAt leaves the restarted alert open', async () => {
    const source = { source: 'alertmanager' } as const;
    await ingest(make(2, source, { startedAt: '2026-11-02T03:00:00.000Z' }));
    await ingest(make(2, source, { startedAt: '2026-11-02T05:00:00.000Z' }));
    const stale = await ingest(
      make(2, { ...source, state: 'resolved' }, { startedAt: '2026-11-02T03:00:00.000Z' }),
    );
    expect(stale).toEqual({ kind: 'ignored', reason: 'stale_generation' });
    expect((await rows(2))[0]?.state).toBe('open');
    const current = await ingest(
      make(2, { ...source, state: 'resolved' }, { startedAt: '2026-11-02T05:00:00.000Z' }),
    );
    expect(current.kind).toBe('resolved');
  });

  it('a close that does not say which occurrence it is for still closes (as before)', async () => {
    await ingest(make(3, {}, { incidentId: 'A' }));
    expect((await ingest(make(3, { state: 'resolved' }))).kind).toBe('resolved');
  });
});

describe('audit', () => {
  it('writes one row per delivery that changed an alert, by the system, with no content', async () => {
    const opened = await ingest(make(4, { summary: 'secret-looking text' }));
    await ingest(make(4));
    await ingest(make(4, { renotify: true }));
    const closing = make(4, { state: 'resolved' });
    await ingest(closing);
    await ingest(closing); // a redelivery: no row
    await ingest(make(99, { state: 'resolved' })); // nothing open: no row
    if (opened.kind !== 'opened') throw new Error('not opened');

    const audit = await env.db.owner.db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.action, 'alert.ingest'),
          eq(schema.auditLog.targetId, opened.alertId),
        ),
      )
      .orderBy(asc(schema.auditLog.createdAt));
    expect(audit.map((row) => (row.metadata as { kind: string }).kind)).toEqual([
      'opened',
      'counted',
      'renotified',
      'resolved',
    ]);
    for (const row of audit) {
      expect(row).toMatchObject({ actorType: 'system', targetType: 'alert', outcome: 'success' });
      expect(JSON.stringify(row.metadata)).not.toContain('secret-looking');
    }
    expect((audit[1]?.metadata as { count: number }).count).toBe(2);
    const all = await env.db.owner.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'alert.ingest'));
    expect(all.filter((row) => row.targetId === null)).toHaveLength(0);
  });
});

describe('an internal ticket has no customer', () => {
  async function internalTicket() {
    const org = await addOrg(env);
    const [contact] = await env.db.owner.db
      .insert(schema.contact)
      .values({ orgId: org.id, name: 'Requester', emails: [`${randomUUID()}@example.test`] })
      .returning();
    const [ticket] = await env.db.owner.db
      .insert(schema.ticket)
      .values({
        subject: 'Usage anomaly',
        orgId: org.id,
        channel: 'internal',
        status: 'open',
        requesterContactId: contact?.id ?? null,
      })
      .returning();
    if (!ticket || !contact) throw new Error('no ticket');
    return { org, contact, ticket };
  }

  it('staff cannot send a public reply on it, and nothing is written', async () => {
    const { ticket } = await internalTicket();
    const staff = await addStaff(env);
    const attempt = env.tx((tx) =>
      env.domain.tickets.reply(tx, env.ctx(staff.actor), {
        ref: ticket.id,
        reply: { body: 'Hello customer' },
        sender: { kind: 'staff', userId: staff.id },
      }),
    );
    await expect(attempt).rejects.toSatisfy(
      (error: unknown) => isDomainError(error) && error.code === 'bad_request',
    );
    const messages = await env.db.owner.db
      .select()
      .from(schema.message)
      .where(eq(schema.message.ticketId, ticket.id));
    expect(messages).toHaveLength(0);
  });

  it('a client of the same organization does not find it', async () => {
    const { org, ticket } = await internalTicket();
    const staff = await addStaff(env);
    const attempt = env.tx((tx) =>
      env.domain.tickets.reply(tx, env.ctx(staff.actor), {
        ref: ticket.id,
        reply: { body: 'Hello' },
        sender: {
          kind: 'client',
          userId: staff.id,
          orgId: org.id,
          email: 'someone@example.test',
          name: 'Someone',
        },
      }),
    );
    await expect(attempt).rejects.toSatisfy(
      (error: unknown) => isDomainError(error) && error.code === 'not_found',
    );
  });

  it('an automatic acknowledgment is refused', async () => {
    const { ticket } = await internalTicket();
    const attempt = env.tx((tx) =>
      env.domain.outbound.scheduleTemplateAck(tx, env.ctx(), {
        ref: ticket.id,
        templateKey: 'auto_ack.received',
      }),
    );
    await expect(attempt).rejects.toSatisfy(
      (error: unknown) => isDomainError(error) && error.code === 'bad_request',
    );
    const deliveries = await env.db.owner.db.select().from(schema.outboundDelivery);
    expect(deliveries.filter((row) => row.ticketId === ticket.id)).toHaveLength(0);
  });

  it('resolving it schedules no CSAT survey, even with a requester that has an email', async () => {
    const { ticket } = await internalTicket();
    await env.tx((tx) =>
      env.domain.tickets.changeStatus(tx, env.ctx(), { ref: ticket.id, status: 'resolved' }),
    );
    const surveys = await env.db.owner.db
      .select()
      .from(schema.csatSurvey)
      .where(eq(schema.csatSurvey.ticketId, ticket.id));
    expect(surveys).toHaveLength(0);
  });

  it('an internal note is still allowed: staff can work on it', async () => {
    const { ticket } = await internalTicket();
    const staff = await addStaff(env);
    const result = await env.tx((tx) =>
      env.domain.tickets.note(tx, env.ctx(staff.actor), {
        ref: ticket.id,
        note: { body: 'Looked into it' },
        sender: { userId: staff.id },
      }),
    );
    expect(result.value.message.visibility).toBe('internal');
  });
});
