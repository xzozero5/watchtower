import { randomUUID } from 'node:crypto';

import { schema } from '@watchtower/db';
import {
  ALERTS_AUDIT_ACTIONS,
  DEFAULT_ESCALATION_STEPS,
  QUEUE_NAMES,
  normalizedAlertSchema,
  type NormalizedAlert,
} from '@watchtower/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { addQueue, addStaff, auditRows, clockIn, startDomainTest } from '../testing/support.js';
import type { DomainTestEnv } from '../testing/support.js';

// R-3.8 and AC-3 (the escalation half) against a real Postgres: the policy's steps are carried out in
// order as they fall due, an acknowledgment stops them, nobody on shift falls back to the leads, and
// every decision about time is the database's clock (a process whose clock is wildly wrong changes
// nothing).

let env: DomainTestEnv;

beforeAll(async () => {
  env = await startDomainTest();
});
afterAll(async () => {
  await env.close();
});

let counter = 0;
const fp = (n: number): string => n.toString(16).padStart(64, '0');
let nextFingerprint = 100;

function makeAlert(
  fingerprintN: number,
  overrides: Partial<NormalizedAlert> = {},
): NormalizedAlert {
  counter += 1;
  return normalizedAlertSchema.parse({
    source: 'gcp_monitoring',
    providerEventId: `evt-${String(counter)}`,
    fingerprint: fp(fingerprintN),
    state: 'firing',
    severity: 'critical',
    title: 'High CPU on API VMs',
    summary: 'CPU is above 90%',
    conditionName: 'CPU above 90%',
    labels: { service: 'checkout' },
    url: 'https://console.example.invalid/alert/1',
    occurredAt: '2026-11-02T03:00:00.000Z',
    renotify: false,
    payload: { kind: 'gcp_monitoring' },
    ...overrides,
  });
}

/** Opens a new alert (its own fingerprint) and returns its id. */
async function openAlert(overrides: Partial<NormalizedAlert> = {}): Promise<string> {
  nextFingerprint += 1;
  const outcome = (
    await env.tx((tx) =>
      env.domain.alerts.ingest(tx, env.ctx(), {
        alert: makeAlert(nextFingerprint, overrides),
      }),
    )
  ).value;
  if (outcome.kind !== 'opened') throw new Error('expected an opened alert');
  return outcome.alertId;
}

const SYSTEM = { type: 'system', id: null } as const;
const sweep = (nowOverride?: () => Date) =>
  env.domain.alerts.sweepEscalations(
    env.database.db,
    env.ctx(SYSTEM, nowOverride === undefined ? {} : { now: nowOverride }),
  );

/** Moves an alert's whole timeline into the past by `seconds`, as if that long had passed (database clock). */
async function age(alertId: string, seconds: number): Promise<void> {
  await env.db.owner.db
    .update(schema.alert)
    .set({
      firstSeenAt: sql`${schema.alert.firstSeenAt} - make_interval(secs => ${seconds})`,
      nextEscalationAt: sql`${schema.alert.nextEscalationAt} - make_interval(secs => ${seconds})`,
    })
    .where(eq(schema.alert.id, alertId));
}

const alertRow = async (alertId: string) => {
  const [row] = await env.db.owner.db
    .select()
    .from(schema.alert)
    .where(eq(schema.alert.id, alertId));
  if (row === undefined) throw new Error('no alert');
  return row;
};

const stepsOf = (alertId: string) =>
  env.db.owner.db
    .select()
    .from(schema.alertEscalation)
    .where(eq(schema.alertEscalation.alertId, alertId))
    .orderBy(asc(schema.alertEscalation.level));

const notificationsFor = (alertId: string) =>
  env.db.owner.db
    .select()
    .from(schema.notification)
    .where(sql`${schema.notification.data}->>'alertId' = ${alertId}`);

const step = (index: number) => {
  const found = DEFAULT_ESCALATION_STEPS[index];
  if (found === undefined) throw new Error('no such default step');
  return found;
};

describe('the people each step tells', () => {
  it('step 0 tells the clocked-in staff, not the ones off shift, and queues the chat post', async () => {
    const onShift = await addStaff(env, 'agent');
    const offShift = await addStaff(env, 'agent');
    await clockIn(env, onShift.id);
    const alertId = await openAlert();

    const result = await sweep();
    expect(result.steps).toBeGreaterThanOrEqual(1);

    const [first] = await stepsOf(alertId);
    expect(first).toMatchObject({
      level: 0,
      target: 'on_shift',
      fallback: null,
      chatState: 'pending',
    });
    expect(first?.recipientIds).toContain(onShift.id);
    expect(first?.recipientIds).not.toContain(offShift.id);

    const made = await notificationsFor(alertId);
    expect(made.every((row) => row.kind === 'alert.fired')).toBe(true);
    expect(made.map((row) => row.userId)).toContain(onShift.id);
    expect(made.map((row) => row.userId)).not.toContain(offShift.id);
    // Ids and counts only (N4): no title, no payload in what the person is shown.
    expect(JSON.stringify(made.map((row) => row.data))).not.toContain('CPU');

    const jobs = await env.db.owner.db
      .select()
      .from(schema.outbox)
      .where(
        and(
          eq(schema.outbox.queue, QUEUE_NAMES.alerts),
          eq(schema.outbox.jobId, `alert-chat-${alertId}-0`),
        ),
      );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toEqual({ alertId, level: 0 });
    // BullMQ refuses a job id with a colon: the relay would never hand this job to the queue.
    expect(jobs[0]?.jobId).not.toContain(':');

    const row = await alertRow(alertId);
    expect(row.escalationLevel).toBe(1);
    expect(row.state).toBe('open');
  });

  it('prefers the clocked-in members of the service owner queue', async () => {
    const member = await addStaff(env, 'agent');
    const other = await addStaff(env, 'agent');
    await clockIn(env, member.id);
    await clockIn(env, other.id);
    const queue = await addQueue(env, { members: [member.id] });
    const [serviceRow] = await env.db.owner.db
      .insert(schema.service)
      .values({
        slug: `svc-${randomUUID().slice(0, 8)}`,
        name: 'Checkout',
        ownerQueueId: queue.id,
        matchRules: [{ labels: { service: 'owned-by-queue' } }],
      })
      .returning({ id: schema.service.id });
    expect(serviceRow).toBeDefined();
    const alertId = await openAlert({ labels: { service: 'owned-by-queue' } });
    expect((await alertRow(alertId)).serviceId).toBe(serviceRow?.id);

    await sweep();
    const [first] = await stepsOf(alertId);
    expect(first?.recipientIds).toEqual([member.id]);
  });

  it('tells the lead at the second step and the head at the third, in order, as time passes', async () => {
    const lead = await addStaff(env, 'lead');
    const head = await addStaff(env, 'head');
    const alertId = await openAlert();
    await sweep();
    expect(await stepsOf(alertId)).toHaveLength(1);

    // Not due yet: another sweep carries out nothing for this alert.
    await sweep();
    expect(await stepsOf(alertId)).toHaveLength(1);

    await age(alertId, step(1).afterSeconds);
    await sweep();
    let steps = await stepsOf(alertId);
    expect(steps.map((entry) => entry.target)).toEqual(['on_shift', 'lead']);
    expect(steps[1]?.recipientIds).toContain(lead.id);
    expect(steps[1]?.recipientIds).not.toContain(head.id);

    const afterLead = await notificationsFor(alertId);
    expect(afterLead.filter((row) => row.userId === lead.id).map((row) => row.kind)).toEqual([
      'alert.escalated',
    ]);

    await age(alertId, step(2).afterSeconds - step(1).afterSeconds);
    await sweep();
    steps = await stepsOf(alertId);
    expect(steps.map((entry) => entry.target)).toEqual(['on_shift', 'lead', 'head']);
    expect(steps[2]?.recipientIds).toContain(head.id);

    const done = await alertRow(alertId);
    expect(done.escalationLevel).toBe(DEFAULT_ESCALATION_STEPS.length);
    expect(done.nextEscalationAt).toBeNull();
    // Nothing is left to do for this alert.
    await sweep();
    expect(await stepsOf(alertId)).toHaveLength(DEFAULT_ESCALATION_STEPS.length);
  });

  it('with nobody on shift, tells the leads and heads in place and says so', async () => {
    // Everybody clocked in by earlier tests is clocked out: this alert finds nobody on shift.
    await env.db.owner.db
      .update(schema.shiftSession)
      .set({ clockedOutAt: sql`GREATEST(clock_timestamp(), ${schema.shiftSession.clockedInAt})` })
      .where(sql`${schema.shiftSession.clockedOutAt} IS NULL`);
    const lead = await addStaff(env, 'lead');
    const alertId = await openAlert();
    await sweep();
    const [first] = await stepsOf(alertId);
    expect(first).toMatchObject({ target: 'on_shift', fallback: 'lead' });
    expect(first?.recipientIds).toContain(lead.id);
  });

  it('counts a person on an on-call roster window now as on shift without a clock-in', async () => {
    await env.db.owner.db
      .update(schema.shiftSession)
      .set({ clockedOutAt: sql`GREATEST(clock_timestamp(), ${schema.shiftSession.clockedInAt})` })
      .where(sql`${schema.shiftSession.clockedOutAt} IS NULL`);
    const zoneRows = await env.db.owner.db
      .select({ tz: schema.businessCalendar.timezone })
      .from(schema.businessCalendar)
      .where(eq(schema.businessCalendar.isDefault, true));
    const tz = zoneRows[0]?.tz ?? 'UTC';
    // A window that opened two hours ago and closes two hours from now, in the instance's zone.
    const window = await env.db.owner.pool.query<{ starts: string; ends: string; day: string }>(
      `SELECT to_char(clock_timestamp() AT TIME ZONE $1 - interval '2 hours', 'HH24:MI') AS starts,
              to_char(clock_timestamp() AT TIME ZONE $1 + interval '2 hours', 'HH24:MI') AS ends,
              to_char((clock_timestamp() - interval '2 hours') AT TIME ZONE $1, 'YYYY-MM-DD') AS day`,
      [tz],
    );
    const row = window.rows[0];
    if (row === undefined) throw new Error('no window');
    const [definition] = await env.db.owner.db
      .insert(schema.shiftDefinition)
      .values({
        name: `On-call ${randomUUID()}`,
        startsAt: row.starts,
        endsAt: row.ends,
        onCall: true,
      })
      .returning({ id: schema.shiftDefinition.id });
    const person = await addStaff(env, 'agent');
    const away = await addStaff(env, 'agent');
    await env.db.owner.db.insert(schema.rosterEntry).values({
      shiftId: definition?.id ?? '',
      userId: person.id,
      workDate: row.day,
    });
    // A rostered person on an ordinary (not on-call) shift who did not clock in is not paged.
    const [ordinary] = await env.db.owner.db
      .insert(schema.shiftDefinition)
      .values({
        name: `Day ${randomUUID()}`,
        startsAt: row.starts,
        endsAt: row.ends,
        onCall: false,
      })
      .returning({ id: schema.shiftDefinition.id });
    await env.db.owner.db.insert(schema.rosterEntry).values({
      shiftId: ordinary?.id ?? '',
      userId: away.id,
      workDate: row.day,
    });

    const alertId = await openAlert();
    await sweep();
    const [first] = await stepsOf(alertId);
    expect(first?.fallback).toBeNull();
    expect(first?.recipientIds).toEqual([person.id]);
  });
});

describe('acknowledgment', () => {
  it('stops the escalation: nothing more happens to an acknowledged alert', async () => {
    const lead = await addStaff(env, 'lead');
    const acker = await addStaff(env, 'agent');
    const alertId = await openAlert();
    await sweep();

    const outcome = await env.tx((tx) =>
      env.domain.alerts.ack(tx, env.ctx(acker.actor), { alertId, via: 'web' }),
    );
    expect(outcome.value).toEqual({ changed: true, state: 'acknowledged' });
    expect(outcome.events.map((event) => event.type)).toEqual(['alert.updated']);

    const acked = await alertRow(alertId);
    expect(acked).toMatchObject({
      state: 'acknowledged',
      ackedBy: acker.id,
      ackedVia: 'web',
      nextEscalationAt: null,
    });
    expect(acked.ackedAt).not.toBeNull();

    await age(alertId, step(1).afterSeconds + 1);
    await sweep();
    expect(await stepsOf(alertId)).toHaveLength(1);
    expect((await notificationsFor(alertId)).map((row) => row.userId)).not.toContain(lead.id);
  });

  it('is idempotent and exactly one of two simultaneous presses wins', async () => {
    const first = await addStaff(env, 'agent');
    const second = await addStaff(env, 'lead');
    const alertId = await openAlert();

    const results = await Promise.all([
      env.tx((tx) => env.domain.alerts.ack(tx, env.ctx(first.actor), { alertId, via: 'web' })),
      env.tx((tx) => env.domain.alerts.ack(tx, env.ctx(second.actor), { alertId, via: 'discord' })),
    ]);
    expect(results.filter((result) => result.value.changed)).toHaveLength(1);
    expect(results.filter((result) => !result.value.changed)).toHaveLength(1);
    const winner = results.findIndex((result) => result.value.changed) === 0 ? first : second;
    expect((await alertRow(alertId)).ackedBy).toBe(winner.id);

    const audited = (await auditRows(env, ALERTS_AUDIT_ACTIONS.alertAck)).filter(
      (row) => row.targetId === alertId,
    );
    expect(audited).toHaveLength(1);

    const again = await env.tx((tx) =>
      env.domain.alerts.ack(tx, env.ctx(first.actor), { alertId, via: 'web' }),
    );
    expect(again.value).toEqual({ changed: false, state: 'acknowledged' });
    expect(again.events).toEqual([]);
  });

  it('refuses the system actor and an unknown alert, and reports a resolved alert unchanged', async () => {
    const person = await addStaff(env, 'agent');
    const alertId = await openAlert();
    await expect(
      env.tx((tx) => env.domain.alerts.ack(tx, env.ctx(SYSTEM), { alertId, via: 'web' })),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await expect(
      env.tx((tx) =>
        env.domain.alerts.ack(tx, env.ctx(person.actor), { alertId: randomUUID(), via: 'web' }),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });

    await env.tx((tx) =>
      env.domain.alerts.ingest(tx, env.ctx(), {
        alert: makeAlert(nextFingerprint, { state: 'resolved' }),
      }),
    );
    const resolved = await env.tx((tx) =>
      env.domain.alerts.ack(tx, env.ctx(person.actor), { alertId, via: 'web' }),
    );
    expect(resolved.value).toEqual({ changed: false, state: 'resolved' });
  });
});

describe('what is never escalated', () => {
  it('a resolved alert is not paged even if its step was due', async () => {
    const alertId = await openAlert();
    await env.tx((tx) =>
      env.domain.alerts.ingest(tx, env.ctx(), {
        alert: makeAlert(nextFingerprint, { state: 'resolved' }),
      }),
    );
    expect((await alertRow(alertId)).state).toBe('resolved');
    await sweep();
    expect(await stepsOf(alertId)).toHaveLength(0);
  });
});

describe('one clock', () => {
  it('a process clock decades off changes nothing: what is due is decided by the database', async () => {
    const early = await openAlert();
    const farFuture = (): Date => new Date('2099-01-01T00:00:00.000Z');
    // Well short of the second step by the database clock, however far the process clock runs ahead.
    await age(early, Math.floor(step(1).afterSeconds / 2));
    await sweep(farFuture);
    // The first step is due; the second is still ahead.
    expect((await stepsOf(early)).map((entry) => entry.level)).toEqual([0]);

    const late = await openAlert();
    const farPast = (): Date => new Date('1999-01-01T00:00:00.000Z');
    await sweep(farPast);
    expect((await stepsOf(late)).map((entry) => entry.level)).toEqual([0]);
  });

  it('two sweeps at the same moment carry out each step once', async () => {
    await addStaff(env, 'lead');
    const alertId = await openAlert();
    await age(alertId, step(1).afterSeconds);
    await Promise.all([sweep(), sweep(), sweep()]);
    const levels = (await stepsOf(alertId)).map((entry) => entry.level);
    expect(levels.length).toBeGreaterThanOrEqual(1);
    expect(levels).toEqual([...new Set(levels)]);
    // Overdue steps are taken one per sweep, in order, never all at once and never twice.
    await sweep();
    await sweep();
    expect((await stepsOf(alertId)).map((entry) => entry.level)).toEqual([0, 1]);
    const jobs = await env.db.owner.db
      .select()
      .from(schema.outbox)
      .where(sql`${schema.outbox.jobId} LIKE ${`alert-chat-${alertId}-%`}`);
    expect(jobs).toHaveLength(2);
  });

  it('a policy of its own is followed instead of the default one', async () => {
    const ownSeconds = step(1).afterSeconds / 5;
    await addStaff(env, 'lead');
    const [policy] = await env.db.owner.db
      .insert(schema.escalationPolicy)
      .values({
        name: `Fast ${randomUUID()}`,
        steps: [
          { target: 'on_shift', afterSeconds: 0 },
          { target: 'head', afterSeconds: ownSeconds },
        ],
      })
      .returning({ id: schema.escalationPolicy.id });
    await env.db.owner.db.insert(schema.service).values({
      slug: `fast-${randomUUID().slice(0, 8)}`,
      name: 'Fast',
      escalationPolicyId: policy?.id ?? null,
      matchRules: [{ labels: { service: 'fast-policy' } }],
    });
    const alertId = await openAlert({ labels: { service: 'fast-policy' } });
    await sweep();
    const afterFirst = await alertRow(alertId);
    const gap = await env.db.owner.pool.query<{ secs: string }>(
      `SELECT extract(epoch FROM next_escalation_at - first_seen_at)::text AS secs FROM alert WHERE id = $1`,
      [alertId],
    );
    expect(Math.round(Number(gap.rows[0]?.secs))).toBe(ownSeconds);
    expect(afterFirst.escalationLevel).toBe(1);
    await age(alertId, ownSeconds);
    await sweep();
    expect((await stepsOf(alertId)).map((entry) => entry.target)).toEqual(['on_shift', 'head']);
  });
});

// Last in the file on purpose: it disables every lead and head of this database.
describe('a step nobody can be told about is not silent (review)', () => {
  const setRoleActive = (role: 'lead' | 'head', active: boolean) =>
    env.db.owner.db
      .update(schema.users)
      .set({ status: active ? 'active' : 'disabled' })
      .where(eq(schema.users.role, role));

  it('with no lead the head is told in its place, and the step says so', async () => {
    await setRoleActive('lead', false);
    await setRoleActive('head', false);
    const head = await addStaff(env, 'head');
    const alertId = await openAlert();
    await sweep();
    await age(alertId, step(1).afterSeconds);
    const result = await sweep();
    const steps = await stepsOf(alertId);
    expect(steps.map((entry) => [entry.target, entry.fallback])).toContainEqual(['lead', 'lead']);
    expect(steps[1]?.recipientIds).toEqual([head.id]);
    expect(result.unreached).not.toContain(alertId);
  });

  it('with no lead, no head and nobody on shift the step is recorded as reaching nobody, audited as a failure and reported', async () => {
    // Nobody at all is active: no lead, no head, nobody clocked in, nobody on an on-call roster window.
    await env.db.owner.db.update(schema.users).set({ status: 'disabled' });
    await env.db.owner.db
      .update(schema.shiftSession)
      .set({ clockedOutAt: sql`GREATEST(clock_timestamp(), ${schema.shiftSession.clockedInAt})` })
      .where(sql`${schema.shiftSession.clockedOutAt} IS NULL`);
    const alertId = await openAlert();
    const result = await sweep();
    expect(result.unreached).toContain(alertId);
    const [first] = await stepsOf(alertId);
    expect(first).toMatchObject({ target: 'on_shift', recipientCount: 0 });
    const audited = (await auditRows(env, ALERTS_AUDIT_ACTIONS.alertEscalate)).filter(
      (row) => row.targetId === alertId,
    );
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({ outcome: 'failure' });
    expect(audited[0]?.metadata).toMatchObject({ noRecipients: true, recipients: 0 });
    // The next step is still scheduled: the alert is not forgotten.
    expect((await alertRow(alertId)).nextEscalationAt).not.toBeNull();
  });
});
