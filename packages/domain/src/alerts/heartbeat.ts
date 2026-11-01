import { createHash } from 'node:crypto';

import { schema, type Database } from '@watchtower/db';
import {
  ALERTS_AUDIT_ACTIONS,
  normalizedAlertSchema,
  type AlertSeverity,
  type NormalizedAlert,
  type RealtimeEvent,
} from '@watchtower/shared';
import { and, asc, eq, sql } from 'drizzle-orm';

import { recordAuditInTx } from '../audit.js';
import { notFound } from '../errors.js';
import { Effects, type DbTransaction, type DomainContext, type DomainResult } from '../types.js';
import { dbNow } from './clock.js';
import { ingestAlert } from './ingest.js';

/** The fingerprint of a heartbeat's alert: one open alert per heartbeat, however often it goes missing. */
export function heartbeatFingerprint(heartbeatId: string): string {
  return createHash('sha256')
    .update(JSON.stringify(['heartbeat', heartbeatId]))
    .digest('hex');
}

type HeartbeatRow = typeof schema.heartbeat.$inferSelect;

/** What the alert says: the operator's own name for the signal and the time it was allowed, no payload. */
function alertFor(
  row: HeartbeatRow,
  state: 'firing' | 'resolved',
  providerEventId: string,
): NormalizedAlert {
  const allowed = row.expectedIntervalSeconds + row.graceSeconds;
  return normalizedAlertSchema.parse({
    source: 'heartbeat',
    providerEventId,
    fingerprint: heartbeatFingerprint(row.id),
    state,
    severity: row.severity as AlertSeverity,
    title: `Heartbeat missing: ${row.name}`.slice(0, 200),
    summary: `No signal from "${row.slug}" for ${String(allowed)} seconds`,
    conditionName: null,
    labels: {},
    url: null,
    occurredAt: null,
    renotify: false,
    payload: { kind: 'heartbeat' },
  });
}

/**
 * A heartbeat arrived (R-3.10). Stamps `last_beat_at` with the database clock. If the heartbeat was
 * missing, it is `ok` again and its alert is resolved in the same transaction. An unknown slug is
 * `not_found`; an inactive heartbeat still records the beat (so switching it on later starts from a
 * fresh baseline) and raises nothing. The caller has already authenticated the sender.
 */
export async function recordHeartbeat(
  tx: DbTransaction,
  ctx: DomainContext,
  input: { readonly slug: string },
): Promise<DomainResult<{ readonly recovered: boolean }>> {
  const fx = new Effects();
  const [row] = await tx
    .select()
    .from(schema.heartbeat)
    .where(eq(schema.heartbeat.slug, input.slug))
    .limit(1)
    .for('update');
  if (row === undefined) throw notFound('No such heartbeat');

  const [after] = await tx
    .update(schema.heartbeat)
    .set({ lastBeatAt: dbNow, state: 'ok', missingSince: null, updatedAt: dbNow })
    .where(eq(schema.heartbeat.id, row.id))
    .returning({ lastBeatAt: schema.heartbeat.lastBeatAt });
  if (row.state !== 'missing') return fx.result({ recovered: false });

  const stamp = String(after?.lastBeatAt?.getTime() ?? 0);
  const resolved = await ingestAlert(tx, ctx, {
    alert: alertFor(row, 'resolved', `heartbeat:${row.id}:recovered:${stamp}`),
  });
  fx.events.push(...resolved.events);
  await recordAuditInTx(tx, ctx, fx, {
    action: ALERTS_AUDIT_ACTIONS.heartbeatRecovered,
    targetType: 'heartbeat',
    targetId: row.id,
    metadata: { slug: row.slug },
  });
  return fx.result({ recovered: true });
}

export interface HeartbeatSweepResult {
  /** Heartbeats found missing and alerted on. */
  readonly missing: number;
  readonly events: RealtimeEvent[];
}

/**
 * Finds heartbeats that have been silent for `expected_interval_seconds + grace_seconds` of the
 * database clock (counted from the last beat, or from creation for one never heard) and opens their
 * alert. One transaction per heartbeat, the row locked (`FOR UPDATE SKIP LOCKED`), the state flip and
 * the alert in the same commit: a heartbeat is `missing` if and only if its alert was raised.
 */
export async function sweepHeartbeats(
  db: Database['db'],
  ctx: DomainContext,
  limit = 50,
): Promise<HeartbeatSweepResult> {
  const events: RealtimeEvent[] = [];
  let missing = 0;
  for (let i = 0; i < limit; i += 1) {
    const found = await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.heartbeat)
        .where(
          and(
            eq(schema.heartbeat.active, true),
            eq(schema.heartbeat.state, 'ok'),
            sql`COALESCE(${schema.heartbeat.lastBeatAt}, ${schema.heartbeat.createdAt})
                + make_interval(secs => ${schema.heartbeat.expectedIntervalSeconds} + ${schema.heartbeat.graceSeconds})
                < clock_timestamp()`,
          ),
        )
        .orderBy(asc(schema.heartbeat.lastBeatAt), asc(schema.heartbeat.id))
        .limit(1)
        .for('update', { skipLocked: true });
      if (row === undefined) return false;
      const [flipped] = await tx
        .update(schema.heartbeat)
        .set({ state: 'missing', missingSince: dbNow, updatedAt: dbNow })
        .where(eq(schema.heartbeat.id, row.id))
        .returning({ missingSince: schema.heartbeat.missingSince });
      const fx = new Effects();
      const raised = await ingestAlert(tx, ctx, {
        alert: alertFor(
          row,
          'firing',
          `heartbeat:${row.id}:missing:${String(flipped?.missingSince?.getTime() ?? 0)}`,
        ),
        serviceId: row.serviceId,
      });
      fx.events.push(...raised.events);
      await recordAuditInTx(tx, ctx, fx, {
        action: ALERTS_AUDIT_ACTIONS.heartbeatMissing,
        targetType: 'heartbeat',
        targetId: row.id,
        metadata: { slug: row.slug },
      });
      events.push(...fx.events);
      return true;
    });
    if (!found) break;
    missing += 1;
  }
  return { missing, events };
}
