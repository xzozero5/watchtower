import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import {
  UNMAPPED_WINDOW_DAYS,
  type Alert,
  type AlertDetail,
  type AlertEventType,
  type AlertListQuery,
  type AlertSeverity,
  type AlertSource,
  type AlertState,
} from '@watchtower/shared';
import { and, asc, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';

import { notFound } from '../auth/http-errors.js';
import { beforeCursor, decodeCursor, preciseTimestamp, toPage } from '../common/keyset.js';
import { DATABASE } from '../database/database.module.js';

type AlertRow = typeof schema.alert.$inferSelect;

function toAlert(row: AlertRow): Alert {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    source: row.source as AlertSource,
    serviceId: row.serviceId,
    severity: row.severity as AlertSeverity,
    state: row.state as AlertState,
    title: row.title,
    summary: row.summary,
    count: row.count,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    ackedAt: row.ackedAt?.toISOString() ?? null,
    ackedBy: row.ackedBy,
    incidentId: row.incidentId,
    payload: row.payload as Record<string, unknown>,
  };
}

/**
 * Reads alerts for staff (`alert.read`). Read only. The payload is returned as stored: it already
 * holds allow-listed keys only (N4).
 */
@Injectable()
export class AlertsReader {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async list(query: AlertListQuery) {
    const alert = schema.alert;
    const conditions: (SQL | undefined)[] = [
      query.state === undefined ? undefined : eq(alert.state, query.state),
      query.source === undefined ? undefined : eq(alert.source, query.source),
      query.serviceId === undefined ? undefined : eq(alert.serviceId, query.serviceId),
      query.unmapped === true ? isNull(alert.serviceId) : undefined,
      query.cursor === undefined
        ? undefined
        : beforeCursor(alert.lastSeenAt, alert.id, decodeCursor(query.cursor)),
    ];
    const rows = await this.database.db
      .select({ alert, sortKey: preciseTimestamp(alert.lastSeenAt) })
      .from(alert)
      .where(and(...conditions))
      .orderBy(desc(alert.lastSeenAt), desc(alert.id))
      .limit(query.limit + 1);
    const page = toPage(
      rows.map((row) => ({ ...row, id: row.alert.id })),
      query.limit,
    );
    return { items: page.rows.map((row) => toAlert(row.alert)), nextCursor: page.nextCursor };
  }

  async get(id: string): Promise<AlertDetail> {
    const [row] = await this.database.db
      .select()
      .from(schema.alert)
      .where(eq(schema.alert.id, id))
      .limit(1);
    if (row === undefined) throw notFound('No such alert');
    const events = await this.database.db
      .select()
      .from(schema.alertEvent)
      .where(eq(schema.alertEvent.alertId, id))
      .orderBy(asc(schema.alertEvent.createdAt), asc(schema.alertEvent.id));
    return {
      ...toAlert(row),
      events: events.map((event) => ({
        id: event.id,
        type: event.type as AlertEventType,
        occurredAt: event.occurredAt?.toISOString() ?? null,
        createdAt: event.createdAt.toISOString(),
      })),
    };
  }

  /**
   * The "unmapped" bucket (R-3.7): alerts no service claims in the last `UNMAPPED_WINDOW_DAYS`,
   * grouped by source and title. The window is measured on the database clock, the clock that
   * stamped `last_seen_at`.
   */
  async unmapped() {
    const alert = schema.alert;
    const rows = await this.database.db
      .select({
        source: alert.source,
        title: alert.title,
        alerts: sql<number>`count(*)::int`,
        occurrences: sql<number>`coalesce(sum(${alert.count}), 0)::int`,
        openAlerts: sql<number>`count(*) FILTER (WHERE ${alert.state} <> 'resolved')::int`,
        lastSeenAt: sql<Date>`max(${alert.lastSeenAt})`,
      })
      .from(alert)
      .where(
        and(
          isNull(alert.serviceId),
          sql`${alert.lastSeenAt} > clock_timestamp() - make_interval(days => ${UNMAPPED_WINDOW_DAYS})`,
        ),
      )
      .groupBy(alert.source, alert.title)
      .orderBy(desc(sql`max(${alert.lastSeenAt})`), asc(alert.title));
    return {
      windowDays: UNMAPPED_WINDOW_DAYS,
      items: rows.map((row) => ({
        source: row.source as AlertSource,
        title: row.title,
        alerts: row.alerts,
        occurrences: row.occurrences,
        openAlerts: row.openAlerts,
        lastSeenAt: new Date(row.lastSeenAt).toISOString(),
      })),
    };
  }
}
