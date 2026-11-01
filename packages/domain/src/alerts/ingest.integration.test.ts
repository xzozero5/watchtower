import { schema } from '@watchtower/db';
import { normalizedAlertSchema, type NormalizedAlert } from '@watchtower/shared';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isDomainError } from '../errors.js';
import { addOrg, startDomainTest, type DomainTestEnv } from '../testing/support.js';
import type { IngestAlertOutcome } from './ingest.js';

// R-3.1 to R-3.7 and AC-3 (the first half) against a real Postgres: one open alert per fingerprint,
// a redelivery never counts, two real fires count twice, `closed` closes the alert and nothing else,
// the payload keeps allow-listed keys, and the times are the database's.

let env: DomainTestEnv;

beforeAll(async () => {
  env = await startDomainTest();
});
afterAll(async () => {
  await env.close();
});

let counter = 0;
const fp = (n: number): string => n.toString(16).padStart(64, '0');

function make(overrides: Partial<NormalizedAlert> & { fingerprintN: number }): NormalizedAlert {
  counter += 1;
  const { fingerprintN, ...rest } = overrides;
  return normalizedAlertSchema.parse({
    source: 'gcp_monitoring',
    providerEventId: `evt-${String(counter)}`,
    fingerprint: fp(fingerprintN),
    state: 'firing',
    severity: 'critical',
    title: 'High CPU on API VMs',
    summary: 'CPU is above 90%',
    conditionName: 'CPU above 90%',
    labels: { service: 'checkout', zone: 'asia-southeast1-a' },
    url: 'https://console.example.invalid/alert/1',
    occurredAt: '2026-11-02T03:00:00.000Z',
    renotify: false,
    payload: { kind: 'gcp_monitoring', policyName: 'High CPU on API VMs' },
    ...rest,
  });
}

const ingest = (alert: NormalizedAlert, overrides = {}) =>
  env.tx((tx) => env.domain.alerts.ingest(tx, env.ctx(undefined, overrides), { alert }));

async function ingestOk(alert: NormalizedAlert): Promise<IngestAlertOutcome> {
  return (await ingest(alert)).value;
}

const alertsOf = (fingerprintN: number) =>
  env.db.owner.db
    .select()
    .from(schema.alert)
    .where(eq(schema.alert.fingerprint, fp(fingerprintN)));

const eventsOf = (alertId: string) =>
  env.db.owner.db
    .select()
    .from(schema.alertEvent)
    .where(eq(schema.alertEvent.alertId, alertId))
    .orderBy(asc(schema.alertEvent.createdAt), asc(schema.alertEvent.id));

async function only(fingerprintN: number) {
  const rows = await alertsOf(fingerprintN);
  expect(rows).toHaveLength(1);
  const [row] = rows;
  if (!row) throw new Error('no alert');
  return row;
}

describe('opening and counting (R-3.5, AC-3)', () => {
  it('opens an alert on the first fire', async () => {
    const outcome = await ingestOk(make({ fingerprintN: 1 }));
    expect(outcome.kind).toBe('opened');
    const row = await only(1);
    expect(row).toMatchObject({
      source: 'gcp_monitoring',
      state: 'open',
      severity: 'critical',
      title: 'High CPU on API VMs',
      count: 1,
      serviceId: null,
      resolvedAt: null,
      ackedAt: null,
    });
    const events = await eventsOf(row.id);
    expect(events.map((event) => event.type)).toEqual(['fired']);
    expect(events[0]?.occurredAt?.toISOString()).toBe('2026-11-02T03:00:00.000Z');
  });

  it('a second real fire (a new delivery id) is one alert with count 2', async () => {
    await ingestOk(make({ fingerprintN: 2 }));
    const second = await ingestOk(
      make({ fingerprintN: 2, occurredAt: '2026-11-02T03:04:00.000Z' }),
    );
    expect(second).toMatchObject({ kind: 'counted', count: 2, renotified: false });
    const row = await only(2);
    expect(row.count).toBe(2);
    expect((await eventsOf(row.id)).map((event) => event.type)).toEqual(['fired', 'fired']);
  });

  it('a redelivery of the same delivery id changes nothing', async () => {
    const delivery = make({ fingerprintN: 3, providerEventId: 'msg-redelivered' });
    expect((await ingestOk(delivery)).kind).toBe('opened');
    expect((await ingestOk(delivery)).kind).toBe('duplicate');
    expect((await ingestOk(delivery)).kind).toBe('duplicate');
    const row = await only(3);
    expect(row.count).toBe(1);
    expect(await eventsOf(row.id)).toHaveLength(1);
  });

  it('the same delivery id from another source is another delivery', async () => {
    await ingestOk(make({ fingerprintN: 4, providerEventId: 'shared-id' }));
    const other = await ingestOk(
      make({ fingerprintN: 5, providerEventId: 'shared-id', source: 'alertmanager' }),
    );
    expect(other.kind).toBe('opened');
  });

  it('concurrent copies of one delivery count once; concurrent distinct fires all count, in one alert', async () => {
    const delivery = make({ fingerprintN: 6, providerEventId: 'msg-concurrent' });
    const copies = await Promise.all(Array.from({ length: 6 }, () => ingestOk(delivery)));
    expect(copies.filter((outcome) => outcome.kind === 'opened')).toHaveLength(1);
    expect(copies.filter((outcome) => outcome.kind === 'duplicate')).toHaveLength(5);
    expect((await only(6)).count).toBe(1);

    await Promise.all(Array.from({ length: 6 }, () => ingestOk(make({ fingerprintN: 7 }))));
    const row = await only(7);
    expect(row.count).toBe(6);
    expect(await eventsOf(row.id)).toHaveLength(6);
  });

  it('a repeat notification of a continuing alert refreshes it but is not a new fire', async () => {
    await ingestOk(make({ fingerprintN: 8 }));
    const repeat = await ingestOk(make({ fingerprintN: 8, renotify: true, summary: 'still high' }));
    expect(repeat).toMatchObject({ kind: 'counted', count: 1, renotified: true });
    const row = await only(8);
    expect(row.count).toBe(1);
    expect(row.summary).toBe('still high');
    expect((await eventsOf(row.id)).map((event) => event.type)).toEqual(['fired', 'renotified']);
  });

  it('keeps the highest severity the alert has had', async () => {
    await ingestOk(make({ fingerprintN: 9, severity: 'warning' }));
    await ingestOk(make({ fingerprintN: 9, severity: 'critical' }));
    await ingestOk(make({ fingerprintN: 9, severity: 'info' }));
    expect((await only(9)).severity).toBe('critical');
  });
});

describe('closing (PRD section 5.3)', () => {
  it('closed resolves the alert, once', async () => {
    await ingestOk(make({ fingerprintN: 10 }));
    const close = make({
      fingerprintN: 10,
      state: 'resolved',
      occurredAt: '2026-11-02T03:10:00.000Z',
    });
    expect((await ingestOk(close)).kind).toBe('resolved');
    expect((await ingestOk(close)).kind).toBe('duplicate');
    const row = await only(10);
    expect(row.state).toBe('resolved');
    expect(row.resolvedAt).not.toBeNull();
    expect(row.nextEscalationAt).toBeNull();
    expect((await eventsOf(row.id)).map((event) => event.type)).toEqual(['fired', 'resolved']);
  });

  it('a fire after the close opens a new alert and keeps the old one as history', async () => {
    await ingestOk(make({ fingerprintN: 11 }));
    await ingestOk(make({ fingerprintN: 11, state: 'resolved' }));
    const again = await ingestOk(make({ fingerprintN: 11 }));
    expect(again.kind).toBe('opened');
    const rows = await alertsOf(11);
    expect(rows.map((row) => `${row.state}:${String(row.count)}`).toSorted()).toEqual([
      'open:1',
      'resolved:1',
    ]);
  });

  it('a close for an alert we do not have open writes nothing', async () => {
    const outcome = await ingestOk(make({ fingerprintN: 12, state: 'resolved' }));
    expect(outcome).toEqual({ kind: 'ignored', reason: 'no_open_alert' });
    expect(await alertsOf(12)).toHaveLength(0);
  });

  it('closes the alert and does NOT close the incident or touch its tickets', async () => {
    await ingestOk(make({ fingerprintN: 13 }));
    const row = await only(13);
    // An incident id the alert was linked to (the incident table arrives with T-202a) and a ticket on it.
    const incidentId = '5f2f8a8e-7a38-4a41-9d3b-1f0a6f1e9c11';
    await env.db.owner.db
      .update(schema.alert)
      .set({ incidentId })
      .where(eq(schema.alert.id, row.id));
    const org = await addOrg(env, { name: 'Incident org' });
    const [ticket] = await env.db.owner.db
      .insert(schema.ticket)
      .values({ subject: 'Outage', orgId: org.id, channel: 'internal', status: 'open', incidentId })
      .returning();
    if (!ticket) throw new Error('no ticket');

    await ingestOk(make({ fingerprintN: 13, state: 'resolved' }));

    const after = await only(13);
    expect(after.state).toBe('resolved');
    expect(after.incidentId).toBe(incidentId);
    const [ticketAfter] = await env.db.owner.db
      .select()
      .from(schema.ticket)
      .where(eq(schema.ticket.id, ticket.id));
    expect(ticketAfter).toMatchObject({
      status: 'open',
      incidentId,
      resolvedAt: null,
      closedAt: null,
    });
    expect(ticketAfter?.updatedAt.getTime()).toBe(ticket.updatedAt.getTime());
  });
});

describe('service catalog (R-3.7)', () => {
  it('maps an alert to the service whose rule matches, and leaves the rest unmapped', async () => {
    const [service] = await env.db.owner.db
      .insert(schema.service)
      .values({
        slug: 'checkout',
        name: 'Checkout',
        matchRules: [{ source: 'gcp_monitoring', labels: { service: 'checkout' } }],
      })
      .returning({ id: schema.service.id });
    const mapped = await ingestOk(make({ fingerprintN: 20 }));
    expect(mapped).toMatchObject({ kind: 'opened', serviceId: service?.id });
    expect((await only(20)).serviceId).toBe(service?.id);

    const unmapped = await ingestOk(make({ fingerprintN: 21, labels: { service: 'unknown' } }));
    expect(unmapped).toMatchObject({ kind: 'opened', serviceId: null });
  });

  it('ignores an inactive service, and maps an open alert once a service claims it', async () => {
    await env.db.owner.db.insert(schema.service).values({
      slug: 'legacy',
      name: 'Legacy',
      active: false,
      matchRules: [{ labels: { service: 'legacy' } }],
    });
    await ingestOk(make({ fingerprintN: 22, labels: { service: 'legacy' } }));
    expect((await only(22)).serviceId).toBeNull();

    await env.db.owner.db
      .update(schema.service)
      .set({ active: true })
      .where(eq(schema.service.slug, 'legacy'));
    await ingestOk(make({ fingerprintN: 22, labels: { service: 'legacy' } }));
    const row = await only(22);
    expect(row.serviceId).not.toBeNull();
    expect(row.count).toBe(2);
  });
});

describe('what is stored (N4)', () => {
  it('keeps allow-listed payload keys only, even when the connector did not filter', async () => {
    await ingestOk(
      make({
        fingerprintN: 30,
        payload: {
          kind: 'gcp_monitoring',
          policyName: 'p',
          documentation: { content: 'Contact jane@example.invalid' },
          customerName: 'Example Customer',
          labels: { zone: 'a', owner_email: 'x@example.invalid' },
        },
      }),
    );
    const row = await only(30);
    expect(Object.keys(row.payload as object).toSorted()).toEqual(['kind', 'labels', 'policyName']);
    expect(row.payload).toMatchObject({ labels: { zone: 'a' } });
    expect(JSON.stringify(row.payload)).not.toMatch(/example\.invalid|Example Customer/);
  });

  it('refuses a delivery that is not a normalized alert', async () => {
    const bad = { ...make({ fingerprintN: 31 }), fingerprint: 'short' };
    await expect(ingest(bad)).rejects.toSatisfy(
      (error: unknown) => isDomainError(error) && error.code === 'bad_request',
    );
    expect(await alertsOf(31)).toHaveLength(0);
  });
});

describe('the clock', () => {
  it('stamps first_seen_at, last_seen_at and resolved_at with the database clock, never the context clock', async () => {
    const wrong = new Date('2001-01-01T00:00:00.000Z');
    const before = Date.now();
    await ingest(make({ fingerprintN: 40 }), { now: () => wrong });
    await ingest(make({ fingerprintN: 40 }), { now: () => wrong });
    await ingest(make({ fingerprintN: 40, state: 'resolved' }), { now: () => wrong });
    const row = await only(40);
    const after = Date.now();
    for (const stamp of [row.firstSeenAt, row.lastSeenAt, row.resolvedAt]) {
      expect(stamp).not.toBeNull();
      // One real clock for all of it: the test machine and its database share a host.
      expect(stamp?.getTime()).toBeGreaterThan(before - 5000);
      expect(stamp?.getTime()).toBeLessThan(after + 5000);
    }
    expect(row.lastSeenAt.getTime()).toBeGreaterThanOrEqual(row.firstSeenAt.getTime());
    expect(row.resolvedAt?.getTime()).toBeGreaterThanOrEqual(row.lastSeenAt.getTime());
  });

  it('keeps the provider time only as a label on the event (display), not as the alert time', async () => {
    await ingestOk(make({ fingerprintN: 41, occurredAt: '2020-05-05T05:05:05.000Z' }));
    const row = await only(41);
    expect(row.firstSeenAt.getFullYear()).toBeGreaterThanOrEqual(2026);
    const [event] = await eventsOf(row.id);
    expect(event?.occurredAt?.toISOString()).toBe('2020-05-05T05:05:05.000Z');
  });
});
