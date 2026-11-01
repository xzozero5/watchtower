import { randomUUID } from 'node:crypto';

import { schema } from '@watchtower/db';
import {
  allowedLabels,
  normalizedAlertSchema,
  sanitizeAlertPayload,
  type AlertSeverity,
  type NormalizedAlert,
} from '@watchtower/shared';
import { and, asc, eq, ne, sql } from 'drizzle-orm';

import { badRequest } from '../errors.js';
import { Effects, type DbTransaction, type DomainContext, type DomainResult } from '../types.js';
import { matchService } from './match.js';

export interface IngestAlertInput {
  /** What a connector produced. It is validated again here: the domain does not trust its caller. */
  readonly alert: NormalizedAlert;
}

/**
 * What one delivery did.
 *  - `opened`: no open alert had this fingerprint, so a new one (count 1).
 *  - `counted`: the open alert fired again (count + 1), or was told once more (`renotified`: no count).
 *  - `resolved`: the provider closed the open alert. Nothing else is touched (PRD section 5.3).
 *  - `duplicate`: this delivery was already recorded (a redelivery): nothing changed.
 *  - `ignored`: a close for an alert we do not have open (never seen, or already closed).
 */
export type IngestAlertOutcome =
  | { readonly kind: 'opened'; readonly alertId: string; readonly serviceId: string | null }
  | {
      readonly kind: 'counted';
      readonly alertId: string;
      readonly count: number;
      readonly renotified: boolean;
    }
  | { readonly kind: 'resolved'; readonly alertId: string }
  | { readonly kind: 'duplicate'; readonly alertId: string }
  | { readonly kind: 'ignored'; readonly reason: 'no_open_alert' };

const SEVERITY_RANK: Readonly<Record<AlertSeverity, number>> = {
  unknown: 0,
  info: 1,
  warning: 2,
  error: 3,
  critical: 4,
};

const moreSevere = (a: AlertSeverity, b: AlertSeverity): AlertSeverity =>
  SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;

/** The database clock at the moment the statement runs, so rows written under a lock stay in order. */
const dbNow = sql`clock_timestamp()`;

/**
 * Applies one alert delivery (R-3.1 to R-3.5, ADR-015 section 2). The caller owns the transaction.
 *
 * Idempotency: `(source, provider_event_id)` of `alert_event` is unique. Two advisory locks are taken
 * in a fixed order (the delivery id, then the fingerprint) so two copies of the same delivery cannot
 * both count and two deliveries of one fingerprint cannot race into two open alerts; the unique indexes
 * are only the backstop.
 *
 * Clock: `first_seen_at`, `last_seen_at` and `resolved_at` are the database clock. The provider's own
 * time is stored as `alert_event.occurred_at` for display and is never compared with anything.
 *
 * A `resolved` delivery closes the alert and nothing else: no incident, ticket or notification is
 * touched, because the people decide when an incident is over.
 */
export async function ingestAlert(
  tx: DbTransaction,
  _ctx: DomainContext,
  input: IngestAlertInput,
): Promise<DomainResult<IngestAlertOutcome>> {
  const fx = new Effects();
  const parsed = normalizedAlertSchema.safeParse(input.alert);
  if (!parsed.success) throw badRequest('The alert is not a valid normalized alert');
  const alert = parsed.data;
  const payload = sanitizeAlertPayload(alert.payload);

  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`alert-event:${alert.source}:${alert.providerEventId}`}, 0))`,
  );
  const [seen] = await tx
    .select({ alertId: schema.alertEvent.alertId })
    .from(schema.alertEvent)
    .where(
      and(
        eq(schema.alertEvent.source, alert.source),
        eq(schema.alertEvent.providerEventId, alert.providerEventId),
      ),
    )
    .limit(1);
  if (seen !== undefined) return fx.result({ kind: 'duplicate', alertId: seen.alertId });

  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`alert-fingerprint:${alert.fingerprint}`}, 0))`,
  );
  const [open] = await tx
    .select({
      id: schema.alert.id,
      severity: schema.alert.severity,
      serviceId: schema.alert.serviceId,
    })
    .from(schema.alert)
    .where(and(eq(schema.alert.fingerprint, alert.fingerprint), ne(schema.alert.state, 'resolved')))
    .for('update')
    .limit(1);

  const recordEvent = async (alertId: string, type: 'fired' | 'renotified' | 'resolved') => {
    await tx.insert(schema.alertEvent).values({
      alertId,
      source: alert.source,
      providerEventId: alert.providerEventId,
      type,
      occurredAt: alert.occurredAt === null ? null : new Date(alert.occurredAt),
    });
  };

  if (alert.state === 'resolved') {
    if (open === undefined) return fx.result({ kind: 'ignored', reason: 'no_open_alert' });
    await tx
      .update(schema.alert)
      .set({
        state: 'resolved',
        resolvedAt: dbNow,
        lastSeenAt: dbNow,
        updatedAt: dbNow,
        nextEscalationAt: null,
      })
      .where(eq(schema.alert.id, open.id));
    await recordEvent(open.id, 'resolved');
    return fx.result({ kind: 'resolved', alertId: open.id });
  }

  const serviceId = await resolveServiceId(tx, alert);

  if (open !== undefined) {
    const [updated] = await tx
      .update(schema.alert)
      .set({
        // A repeat notification of the same continuing alert is not a new fire: it only refreshes it.
        count: alert.renotify ? sql`${schema.alert.count}` : sql`${schema.alert.count} + 1`,
        lastSeenAt: dbNow,
        updatedAt: dbNow,
        severity: moreSevere(alert.severity, open.severity as AlertSeverity),
        summary: alert.summary,
        payload,
        serviceId: open.serviceId ?? serviceId,
      })
      .where(eq(schema.alert.id, open.id))
      .returning({ count: schema.alert.count });
    await recordEvent(open.id, alert.renotify ? 'renotified' : 'fired');
    return fx.result({
      kind: 'counted',
      alertId: open.id,
      count: updated?.count ?? 1,
      renotified: alert.renotify,
    });
  }

  const alertId = randomUUID();
  await tx.insert(schema.alert).values({
    id: alertId,
    fingerprint: alert.fingerprint,
    source: alert.source,
    serviceId,
    severity: alert.severity,
    state: 'open',
    title: alert.title,
    summary: alert.summary,
    count: 1,
    payload,
    firstSeenAt: dbNow,
    lastSeenAt: dbNow,
  });
  await recordEvent(alertId, 'fired');
  return fx.result({ kind: 'opened', alertId, serviceId });
}

async function resolveServiceId(tx: DbTransaction, alert: NormalizedAlert): Promise<string | null> {
  const catalog = await tx
    .select({
      id: schema.service.id,
      slug: schema.service.slug,
      matchRules: schema.service.matchRules,
    })
    .from(schema.service)
    .where(eq(schema.service.active, true))
    .orderBy(asc(schema.service.slug));
  return matchService(catalog, {
    source: alert.source,
    title: alert.title,
    // Matching sees only the labels alerts keep (the connector filtered them; this is the second look).
    labels: allowedLabels(alert.labels),
  });
}
