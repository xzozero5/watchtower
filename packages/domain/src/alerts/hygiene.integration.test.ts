import { randomUUID } from 'node:crypto';

import { schema } from '@watchtower/db';
import {
  ALERTS_AUDIT_ACTIONS,
  ALERT_SNOOZE_MAX_MINUTES,
  DEFAULT_ESCALATION_STEPS,
  normalizedAlertSchema,
  type NormalizedAlert,
} from '@watchtower/shared';
import { asc, eq, sql, type AnyColumn } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { addStaff, auditRows, startDomainTest } from '../testing/support.js';
import type { DomainTestEnv } from '../testing/support.js';
import { heartbeatFingerprint } from './heartbeat.js';

// R-3.6 correlation, R-3.9 snooze with expiry and reason, R-3.10 heartbeats, against a real Postgres.
// Every deadline is the database's clock; the tests move time by editing rows, never by sleeping.

let env: DomainTestEnv;

beforeAll(async () => {
  env = await startDomainTest();
});
afterAll(async () => {
  await env.close();
});

let counter = 0;
const fp = (n: number): string => n.toString(16).padStart(64, '0');
const SYSTEM = { type: 'system', id: null } as const;
const step = (index: number) => {
  const found = DEFAULT_ESCALATION_STEPS[index];
  if (found === undefined) throw new Error('no such default step');
  return found;
};

function makeAlert(overrides: Partial<NormalizedAlert> = {}): NormalizedAlert {
  counter += 1;
  return normalizedAlertSchema.parse({
    source: 'gcp_monitoring',
    providerEventId: `evt-${String(counter)}`,
    fingerprint: fp(10_000 + counter),
    state: 'firing',
    severity: 'error',
    title: `Alert ${String(counter)}`,
    summary: null,
    conditionName: null,
    labels: {},
    url: null,
    occurredAt: null,
    renotify: false,
    payload: {},
    ...overrides,
  });
}

const ingest = (alert: NormalizedAlert) =>
  env.tx((tx) => env.domain.alerts.ingest(tx, env.ctx(), { alert }));

async function openAlert(overrides: Partial<NormalizedAlert> = {}) {
  const outcome = (await ingest(makeAlert(overrides))).value;
  if (outcome.kind !== 'opened') throw new Error('expected an opened alert');
  return outcome;
}

async function addService(labelValue: string): Promise<string> {
  const [row] = await env.db.owner.db
    .insert(schema.service)
    .values({
      slug: `svc-${randomUUID().slice(0, 8)}`,
      name: labelValue,
      matchRules: [{ labels: { service: labelValue } }],
    })
    .returning({ id: schema.service.id });
  if (row === undefined) throw new Error('no service');
  return row.id;
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

const sweep = (nowOverride?: () => Date) =>
  env.domain.alerts.sweepEscalations(
    env.database.db,
    env.ctx(SYSTEM, nowOverride === undefined ? {} : { now: nowOverride }),
  );

async function age(alertId: string, seconds: number): Promise<void> {
  await env.db.owner.db
    .update(schema.alert)
    .set({
      firstSeenAt: sql`${schema.alert.firstSeenAt} - make_interval(secs => ${seconds})`,
      nextEscalationAt: sql`${schema.alert.nextEscalationAt} - make_interval(secs => ${seconds})`,
    })
    .where(eq(schema.alert.id, alertId));
}

/**
 * Lets `seconds` pass for one alert without waiting: every time stored on it moves back by that
 * much, which is what the passing of time does to a row (the database clock stays where it is).
 */
async function passTime(alertId: string, seconds: number): Promise<void> {
  const back = (column: AnyColumn) => sql`${column} - make_interval(secs => ${seconds})`;
  await env.db.owner.db
    .update(schema.alert)
    .set({
      firstSeenAt: back(schema.alert.firstSeenAt),
      nextEscalationAt: back(schema.alert.nextEscalationAt),
      snoozedAt: back(schema.alert.snoozedAt),
      snoozedUntil: back(schema.alert.snoozedUntil),
    })
    .where(eq(schema.alert.id, alertId));
}

const MINUTE = 60;

describe('snooze (R-3.9)', () => {
  it('pauses the escalation until the expiry, then the waiting step runs', async () => {
    const person = await addStaff(env, 'lead');
    const alertId = (await openAlert()).alertId;
    await sweep();
    await age(alertId, step(1).afterSeconds);

    const snoozed = await env.tx((tx) =>
      env.domain.alerts.snooze(tx, env.ctx(person.actor), {
        alertId,
        minutes: 30,
        reason: 'Planned database failover',
      }),
    );
    expect(snoozed.value).toEqual({ changed: true, state: 'open' });
    expect(snoozed.events.map((event) => event.type)).toEqual(['alert.updated']);
    const row = await alertRow(alertId);
    expect(row).toMatchObject({ snoozeReason: 'Planned database failover', snoozedBy: person.id });

    // The step is due, but the alert is snoozed: nothing happens.
    await sweep();
    expect(await stepsOf(alertId)).toHaveLength(1);

    await passTime(alertId, 31 * MINUTE);
    await sweep();
    expect((await stepsOf(alertId)).map((entry) => entry.level)).toEqual([0, 1]);
  });

  it('pauses the clock: the time that was left when the snooze began is left again when it ends', async () => {
    const person = await addStaff(env, 'lead');
    const alertId = (await openAlert()).alertId;
    await sweep();
    // The lead step is `step(1).afterSeconds` after the first; snooze right away.
    await env.tx((tx) =>
      env.domain.alerts.snooze(tx, env.ctx(person.actor), {
        alertId,
        minutes: 30,
        reason: 'Planned maintenance window',
      }),
    );
    await passTime(alertId, 31 * MINUTE);
    await sweep();
    // The snooze ended a minute ago (in this timeline); the lead step is not yet due, it has the time it
    // had left, minus that minute. It does not fire the moment the snooze ends, and it was not skipped.
    expect(await stepsOf(alertId)).toHaveLength(1);
    const left = await env.db.owner.pool.query<{ secs: string }>(
      `SELECT extract(epoch FROM next_escalation_at - clock_timestamp())::text AS secs FROM alert WHERE id = $1`,
      [alertId],
    );
    const remaining = Number(left.rows[0]?.secs);
    expect(remaining).toBeGreaterThan(step(1).afterSeconds - 2 * MINUTE);
    expect(remaining).toBeLessThan(step(1).afterSeconds);
    expect((await alertRow(alertId)).snoozedUntil).toBeNull();
  });

  it('the expiry is minutes on the database clock, whatever the process clock says', async () => {
    const person = await addStaff(env, 'lead');
    const alertId = (await openAlert()).alertId;
    const wrongClock = (): Date => new Date('1999-01-01T00:00:00.000Z');
    await env.tx((tx) =>
      env.domain.alerts.snooze(tx, env.ctx(person.actor, { now: wrongClock }), {
        alertId,
        minutes: 10,
        reason: 'Noisy while deploying',
      }),
    );
    const seconds = await env.db.owner.pool.query<{ secs: string }>(
      `SELECT extract(epoch FROM snoozed_until - clock_timestamp())::text AS secs FROM alert WHERE id = $1`,
      [alertId],
    );
    expect(Number(seconds.rows[0]?.secs)).toBeGreaterThan(9 * 60);
    expect(Number(seconds.rows[0]?.secs)).toBeLessThanOrEqual(10 * 60);
  });

  it('keeps the policy gap after the snooze: the head is not paged right behind the lead', async () => {
    const person = await addStaff(env, 'lead');
    const alertId = (await openAlert()).alertId;
    await sweep();
    // The lead step is long overdue when the snooze ends.
    await age(alertId, step(2).afterSeconds);
    await env.tx((tx) =>
      env.domain.alerts.snooze(tx, env.ctx(person.actor), {
        alertId,
        minutes: 5,
        reason: 'Waiting for the vendor',
      }),
    );
    await passTime(alertId, 6 * MINUTE);
    await sweep();
    expect((await stepsOf(alertId)).map((entry) => entry.level)).toEqual([0, 1]);
    const gap = await env.db.owner.pool.query<{ secs: string }>(
      `SELECT extract(epoch FROM next_escalation_at - clock_timestamp())::text AS secs FROM alert WHERE id = $1`,
      [alertId],
    );
    const policyGap = step(2).afterSeconds - step(1).afterSeconds;
    // The head's step is the policy's gap after the lead's, counted from the end of the snooze (a
    // minute ago in this timeline), not already overdue because the alert is old.
    expect(Number(gap.rows[0]?.secs)).toBeGreaterThan(policyGap - 2 * MINUTE);
    expect(Number(gap.rows[0]?.secs)).toBeLessThanOrEqual(policyGap);
    await sweep();
    expect(await stepsOf(alertId)).toHaveLength(2);
  });

  it('refuses a missing reason, a zero or endless time, a resolved alert and the system actor', async () => {
    const person = await addStaff(env, 'lead');
    const alertId = (await openAlert()).alertId;
    const snooze = (minutes: number, reason: string, actor = person.actor) =>
      env.tx((tx) => env.domain.alerts.snooze(tx, env.ctx(actor), { alertId, minutes, reason }));
    await expect(snooze(10, '  ')).rejects.toMatchObject({ code: 'bad_request' });
    await expect(snooze(0, 'reason')).rejects.toMatchObject({ code: 'bad_request' });
    await expect(snooze(ALERT_SNOOZE_MAX_MINUTES + 1, 'reason')).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(snooze(10, 'reason', SYSTEM)).rejects.toMatchObject({ code: 'bad_request' });
    expect((await alertRow(alertId)).snoozedUntil).toBeNull();

    const resolved = await openAlert();
    await ingest(
      makeAlert({
        state: 'resolved',
        fingerprint: (await alertRow(resolved.alertId)).fingerprint,
      }),
    );
    await expect(
      env.tx((tx) =>
        env.domain.alerts.snooze(tx, env.ctx(person.actor), {
          alertId: resolved.alertId,
          minutes: 10,
          reason: 'too late',
        }),
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      env.tx((tx) =>
        env.domain.alerts.snooze(tx, env.ctx(person.actor), {
          alertId: randomUUID(),
          minutes: 10,
          reason: 'who',
        }),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('is lifted by hand or by expiry, each audited, and a resolved alert is not snoozed any more', async () => {
    const person = await addStaff(env, 'lead');
    const byHand = (await openAlert()).alertId;
    const byExpiry = (await openAlert()).alertId;
    const resolvedOne = await openAlert();
    for (const id of [byHand, byExpiry, resolvedOne.alertId]) {
      await env.tx((tx) =>
        env.domain.alerts.snooze(tx, env.ctx(person.actor), {
          alertId: id,
          minutes: 60,
          reason: 'Known issue',
        }),
      );
    }
    const lifted = await env.tx((tx) =>
      env.domain.alerts.unsnooze(tx, env.ctx(person.actor), { alertId: byHand }),
    );
    expect(lifted.value.changed).toBe(true);
    const again = await env.tx((tx) =>
      env.domain.alerts.unsnooze(tx, env.ctx(person.actor), { alertId: byHand }),
    );
    expect(again.value.changed).toBe(false);

    await passTime(byExpiry, 61 * MINUTE);
    const ended = await env.domain.alerts.endExpiredSnoozes(env.database.db, env.ctx(SYSTEM));
    expect(ended.ended).toBeGreaterThanOrEqual(1);
    expect(
      ended.events.some(
        (event) => event.type === 'alert.updated' && event.data.alertId === byExpiry,
      ),
    ).toBe(true);
    expect((await alertRow(byExpiry)).snoozedUntil).toBeNull();

    await ingest(
      makeAlert({
        state: 'resolved',
        fingerprint: (await alertRow(resolvedOne.alertId)).fingerprint,
      }),
    );
    expect(await alertRow(resolvedOne.alertId)).toMatchObject({
      state: 'resolved',
      snoozedUntil: null,
      snoozeReason: null,
    });

    const audits = await auditRows(env, ALERTS_AUDIT_ACTIONS.alertUnsnooze);
    expect(audits.filter((row) => row.targetId === byHand)).toHaveLength(1);
    expect(audits.filter((row) => row.targetId === byExpiry)).toHaveLength(1);
    expect(audits.find((row) => row.targetId === byExpiry)?.actorType).toBe('system');
  });

  it('still counts fires while snoozed', async () => {
    const person = await addStaff(env, 'lead');
    const opened = await openAlert();
    const fingerprint = (await alertRow(opened.alertId)).fingerprint;
    await env.tx((tx) =>
      env.domain.alerts.snooze(tx, env.ctx(person.actor), {
        alertId: opened.alertId,
        minutes: 60,
        reason: 'Watching it',
      }),
    );
    await ingest(makeAlert({ fingerprint }));
    expect(await alertRow(opened.alertId)).toMatchObject({ count: 2 });
    expect((await alertRow(opened.alertId)).snoozedUntil).not.toBeNull();
  });
});

describe('correlation (R-3.6)', () => {
  it('groups alerts of one service that open within the window, and a third joins the same group', async () => {
    const label = `corr-${randomUUID().slice(0, 8)}`;
    await addService(label);
    const first = await openAlert({ labels: { service: label } });
    expect(first.correlationId).toBeNull();
    const second = await openAlert({ labels: { service: label } });
    expect(second.correlationId).not.toBeNull();
    const third = await openAlert({ labels: { service: label } });
    expect(third.correlationId).toBe(second.correlationId);
    expect((await alertRow(first.alertId)).correlationId).toBe(second.correlationId);
  });

  it('does not group alerts of different services, unmapped alerts, or alerts outside the window', async () => {
    const a = `corr-${randomUUID().slice(0, 8)}`;
    const b = `corr-${randomUUID().slice(0, 8)}`;
    await addService(a);
    await addService(b);
    await openAlert({ labels: { service: a } });
    expect((await openAlert({ labels: { service: b } })).correlationId).toBeNull();
    await openAlert({ labels: { service: 'nobody-claims-this' } });
    expect(
      (await openAlert({ labels: { service: 'nobody-claims-this' } })).correlationId,
    ).toBeNull();

    // Outside the window: the earlier alert opened long before the later one.
    const c = `corr-${randomUUID().slice(0, 8)}`;
    await addService(c);
    const early = await openAlert({ labels: { service: c } });
    await env.db.owner.db
      .update(schema.alert)
      .set({ firstSeenAt: sql`clock_timestamp() - interval '1 day'` })
      .where(eq(schema.alert.id, early.alertId));
    expect((await openAlert({ labels: { service: c } })).correlationId).toBeNull();
  });

  it('follows the rules: an inactive rule groups nothing, a higher minimum waits for more alerts', async () => {
    const label = `corr-${randomUUID().slice(0, 8)}`;
    await addService(label);
    await env.db.owner.db.update(schema.correlationRule).set({ active: false });
    await openAlert({ labels: { service: label } });
    expect((await openAlert({ labels: { service: label } })).correlationId).toBeNull();

    const [rule] = await env.db.owner.db
      .insert(schema.correlationRule)
      .values({ name: `Three of a kind ${randomUUID()}`, windowMinutes: 60, minAlerts: 3 })
      .returning({ id: schema.correlationRule.id });
    // The two already open count: the third alert completes the group of three.
    const third = await openAlert({ labels: { service: label } });
    expect(third.correlationId).not.toBeNull();
    await env.db.owner.db
      .delete(schema.correlationRule)
      .where(eq(schema.correlationRule.id, rule?.id ?? ''));
    await env.db.owner.db.update(schema.correlationRule).set({ active: true });
  });
});

describe('heartbeat (R-3.10)', () => {
  const ctx = () => env.ctx(SYSTEM);
  const beat = (slug: string) =>
    env.tx((tx) => env.domain.alerts.recordHeartbeat(tx, ctx(), { slug }));
  const sweepBeats = (nowOverride?: () => Date) =>
    env.domain.alerts.sweepHeartbeats(
      env.database.db,
      env.ctx(SYSTEM, nowOverride === undefined ? {} : { now: nowOverride }),
    );

  async function addHeartbeat(fields: Partial<typeof schema.heartbeat.$inferInsert> = {}) {
    const [row] = await env.db.owner.db
      .insert(schema.heartbeat)
      .values({
        slug: `hb-${randomUUID().slice(0, 8)}`,
        name: 'Nightly export',
        expectedIntervalSeconds: 600,
        graceSeconds: 60,
        ...fields,
      })
      .returning();
    if (row === undefined) throw new Error('no heartbeat');
    return row;
  }

  /** Moves the last sign of life back, as if that long had passed. */
  const silence = (id: string, seconds: number) =>
    env.db.owner.db
      .update(schema.heartbeat)
      .set({
        lastBeatAt: sql`clock_timestamp() - make_interval(secs => ${seconds})`,
        createdAt: sql`clock_timestamp() - make_interval(secs => ${seconds})`,
      })
      .where(eq(schema.heartbeat.id, id));

  const stateOf = async (id: string) =>
    (await env.db.owner.db.select().from(schema.heartbeat).where(eq(schema.heartbeat.id, id)))[0];

  it('is not missing inside the interval and the grace, and a process clock far ahead changes nothing', async () => {
    const row = await addHeartbeat();
    await silence(row.id, row.expectedIntervalSeconds);
    const farFuture = (): Date => new Date('2099-01-01T00:00:00.000Z');
    expect((await sweepBeats(farFuture)).missing).toBe(0);
    expect((await stateOf(row.id))?.state).toBe('ok');
  });

  it('opens one alert when it has been silent past interval + grace, once however often swept', async () => {
    const serviceId = await addService(`hb-${randomUUID().slice(0, 8)}`);
    const row = await addHeartbeat({ serviceId, severity: 'critical' });
    await silence(row.id, row.expectedIntervalSeconds + row.graceSeconds + 5);
    const result = await sweepBeats();
    expect(result.missing).toBeGreaterThanOrEqual(1);
    await sweepBeats();

    const after = await stateOf(row.id);
    expect(after?.state).toBe('missing');
    expect(after?.missingSince).not.toBeNull();
    const alerts = await env.db.owner.db
      .select()
      .from(schema.alert)
      .where(eq(schema.alert.fingerprint, heartbeatFingerprint(row.id)));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      source: 'heartbeat',
      state: 'open',
      severity: 'critical',
      serviceId,
      title: `Heartbeat missing: ${row.name}`,
    });
    expect(alerts[0]?.nextEscalationAt).not.toBeNull();
    expect(
      (await auditRows(env, ALERTS_AUDIT_ACTIONS.heartbeatMissing)).filter(
        (entry) => entry.targetId === row.id,
      ),
    ).toHaveLength(1);
  });

  it('a beat brings it back and resolves the alert; the next silence opens a new alert', async () => {
    const row = await addHeartbeat();
    const fingerprint = heartbeatFingerprint(row.id);
    await silence(row.id, row.expectedIntervalSeconds + row.graceSeconds + 5);
    await sweepBeats();

    const recovered = await beat(row.slug);
    expect(recovered.value).toEqual({ recovered: true });
    expect(await stateOf(row.id)).toMatchObject({ state: 'ok', missingSince: null });
    const afterBeat = await env.db.owner.db
      .select()
      .from(schema.alert)
      .where(eq(schema.alert.fingerprint, fingerprint));
    expect(afterBeat.map((entry) => entry.state)).toEqual(['resolved']);
    expect((await beat(row.slug)).value).toEqual({ recovered: false });

    await silence(row.id, row.expectedIntervalSeconds + row.graceSeconds + 5);
    await sweepBeats();
    const all = await env.db.owner.db
      .select()
      .from(schema.alert)
      .where(eq(schema.alert.fingerprint, fingerprint));
    expect(all.map((entry) => entry.state).toSorted()).toEqual(['open', 'resolved']);
  });

  it('an unknown slug is not found; an inactive heartbeat records beats and raises nothing', async () => {
    await expect(beat('no-such-heartbeat')).rejects.toMatchObject({ code: 'not_found' });
    const row = await addHeartbeat({ active: false });
    await silence(row.id, row.expectedIntervalSeconds + row.graceSeconds + 5);
    await sweepBeats();
    expect((await stateOf(row.id))?.state).toBe('ok');
    await beat(row.slug);
    expect((await stateOf(row.id))?.lastBeatAt).not.toBeNull();
  });
});
