import { randomUUID } from 'node:crypto';

import { schema } from '@watchtower/db';
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';

import type { DbTransaction } from '../types.js';

/**
 * Groups related alerts (R-3.6). Called once, when an alert OPENS with a service: for each active
 * rule, if at least `min_alerts` alerts of that service are open and opened within `window_minutes`
 * of now (database clock, the clock that stamped `first_seen_at`), they share a `correlation_id`.
 *
 * What it does not do: create an incident. A group is a proposal (PRD section 5.3: "propose
 * incident"); a person opens the incident from it (T-202). The group id is reused when any member
 * already has one, so a third alert joins the group the first two formed instead of starting another.
 *
 * Only `same_service` exists (see migration 0043). A per-service advisory lock keeps two alerts that
 * open at the same moment from each forming a group of one.
 *
 * Returns the correlation id the new alert ended up in, or null.
 */
export async function correlateOpenedAlert(
  tx: DbTransaction,
  alertId: string,
  serviceId: string | null,
): Promise<string | null> {
  if (serviceId === null) return null;
  const rules = await tx
    .select({
      windowMinutes: schema.correlationRule.windowMinutes,
      minAlerts: schema.correlationRule.minAlerts,
    })
    .from(schema.correlationRule)
    .where(
      and(eq(schema.correlationRule.active, true), eq(schema.correlationRule.kind, 'same_service')),
    )
    // The narrowest group first: the rule that groups the fewest alerts is the most specific.
    .orderBy(asc(schema.correlationRule.minAlerts), asc(schema.correlationRule.windowMinutes));
  if (rules.length === 0) return null;

  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`alert-correlate:${serviceId}`}, 0))`,
  );
  for (const rule of rules) {
    const members = await tx
      .select({ id: schema.alert.id, correlationId: schema.alert.correlationId })
      .from(schema.alert)
      .where(
        and(
          eq(schema.alert.serviceId, serviceId),
          ne(schema.alert.state, 'resolved'),
          sql`${schema.alert.firstSeenAt} >= clock_timestamp() - make_interval(mins => ${rule.windowMinutes})`,
        ),
      )
      .orderBy(asc(schema.alert.firstSeenAt), asc(schema.alert.id));
    if (members.length < rule.minAlerts || !members.some((member) => member.id === alertId))
      continue;
    const groupId =
      members.find((member) => member.correlationId !== null)?.correlationId ?? randomUUID();
    await tx
      .update(schema.alert)
      .set({ correlationId: groupId })
      .where(
        and(
          inArray(
            schema.alert.id,
            members.map((member) => member.id),
          ),
          isNull(schema.alert.correlationId),
        ),
      );
    return groupId;
  }
  return null;
}
