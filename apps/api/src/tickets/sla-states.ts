import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import {
  AtRiskRule,
  atInstant,
  readTicketStats,
  runningDueSql,
  runningKindSql,
  slaClassSql,
} from '@watchtower/domain';
import { type SlaState, type TicketStats, ticketPrioritySchema } from '@watchtower/shared';
import { or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import { DATABASE } from '../database/database.module.js';

export { runningDueSql, runningDueSortKey } from '@watchtower/domain';

/**
 * The server-side SLA state of a ticket (T-127, UI spec 17 Q9). The SQL, the calendar rule and the stats
 * query live in `@watchtower/domain` (`tickets/sla-stats.ts`) so the embedded insights read the same
 * numbers; what stays here is the `slaState` list filter.
 */
const { ticket } = schema;

const idRowSchema = z.object({
  id: z.uuid(),
  priority: ticketPrioritySchema,
  kind: z.enum(['first_response', 'resolution']),
  due_ms: z.number(),
  created_ms: z.number(),
  policy_id: z.uuid().nullable(),
});

@Injectable()
export class TicketSlaStates {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  /** Counts of the tickets that match `filters`, grouped by status, queue, assignee and priority, with SLA states. */
  stats(filters: readonly (SQL | undefined)[], now: Date): Promise<TicketStats> {
    return readTicketStats(this.database.db, filters, now);
  }

  /**
   * A WHERE condition for the list: tickets whose running SLA target is in one of `states`.
   * `filters` are the other filters of the same request, so the candidates are only the tickets the
   * list could show anyway. `paused` and `breached` are plain SQL; `at_risk` and `ok` add the ids
   * that the calendar rule decided.
   */
  async condition(
    states: readonly SlaState[],
    filters: readonly (SQL | undefined)[],
    now: Date,
  ): Promise<SQL> {
    const wanted = new Set(states);
    const due = runningDueSql();
    const parts: SQL[] = [];
    if (wanted.has('paused')) {
      parts.push(sql`(${due} IS NOT NULL AND ${ticket.slaPausedAt} IS NOT NULL)`);
    }
    if (wanted.has('breached')) {
      parts.push(
        sql`(${due} IS NOT NULL AND ${ticket.slaPausedAt} IS NULL AND ${due} < ${atInstant(now)})`,
      );
    }
    if (wanted.has('at_risk') || wanted.has('ok')) {
      const { atRiskIds, okIds } = await this.candidateIds(filters, now);
      if (wanted.has('at_risk')) {
        parts.push(sql`${slaClassSql(now)} = 'at_risk'`);
        if (atRiskIds.length > 0) parts.push(idIn(atRiskIds));
      }
      if (wanted.has('ok') && okIds.length > 0) parts.push(idIn(okIds));
    }
    return or(...parts) ?? sql`false`;
  }

  private async candidateIds(
    filters: readonly (SQL | undefined)[],
    now: Date,
  ): Promise<{ atRiskIds: string[]; okIds: string[] }> {
    const klass = slaClassSql(now);
    const result = await this.database.db.execute(sql`
      SELECT ${ticket.id} AS id, ${ticket.priority} AS priority, ${runningKindSql()} AS kind,
             (extract(epoch FROM ${runningDueSql()}) * 1000)::float8 AS due_ms,
             (extract(epoch FROM ${ticket.createdAt}) * 1000)::float8 AS created_ms,
             ${ticket.slaPolicyId} AS policy_id
        FROM ${ticket}
       WHERE ${sql.join(
         [
           ...filters.filter((filter): filter is SQL => filter !== undefined),
           sql`${klass} = 'candidate'`,
         ],
         sql` AND `,
       )}
    `);
    const rule = new AtRiskRule(this.database.db, now);
    const atRiskIds: string[] = [];
    const okIds: string[] = [];
    for (const row of z.array(idRowSchema).parse(result.rows)) {
      const atRisk = await rule.atRisk({
        priority: row.priority,
        kind: row.kind,
        dueMs: row.due_ms,
        createdMs: row.created_ms,
        policyId: row.policy_id,
      });
      (atRisk ? atRiskIds : okIds).push(row.id);
    }
    return { atRiskIds, okIds };
  }
}

/** `id` is one of these. One parameter whatever the length, so a long list stays under the driver's parameter limit. */
function idIn(ids: readonly string[]): SQL {
  return sql`${ticket.id} = ANY(string_to_array(${ids.join(',')}, ',')::uuid[])`;
}
