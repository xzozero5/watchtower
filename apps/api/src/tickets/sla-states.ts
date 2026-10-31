import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import { FALLBACK_CALENDAR, slaCalendarFor, targetsFromRow } from '@watchtower/domain';
import {
  OPEN_STATUSES,
  SLA_AT_RISK_MINUTES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  isSlaAtRisk,
  ticketPrioritySchema,
  ticketStatusSchema,
  type BusinessCalendar,
  type SlaCalendarMode,
  type SlaCounts,
  type SlaState,
  type SlaTargets,
  type TicketPriority,
  type TicketStats,
  type TicketStatsBucket,
  type TicketStatus,
} from '@watchtower/shared';
import { eq, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import { DATABASE } from '../database/database.module.js';

/**
 * SQL for "the SLA target that is running now" of a ticket, and the server-side SLA state built on
 * it (T-127, UI spec 17 Q9). One definition, used by the stats, the `slaState` list filter and the
 * `sla_due_asc` sort, so a count and the list behind it can never disagree.
 *
 * The running target (same rule as `slaView()` in the web app): only for a ticket in an open
 * status, the first response while it has not been answered, then the resolution while the ticket
 * is not resolved; no due date, no target. Its state:
 *   paused    the SLA clock is stopped (`sla_paused_at`), whatever the dates say
 *   breached  due before now
 *   at_risk   30 minutes or less left (wall clock, a safe lower bound of business time), or, for
 *             the rest, 25 % or less of the target or 30 minutes or less of *business* time left;
 *             that last test needs the calendar and runs in `isSlaAtRisk` (shared, pure)
 *   ok        everything else
 * Business time cannot be added up in SQL without copying the calendar arithmetic, so SQL settles
 * everything it can and hands the remaining "candidates" (open, running, not near the wall-clock
 * edge) to the TypeScript rule. That set is the tickets with a live SLA target, not the whole table.
 */

const { ticket } = schema;

const OPEN_LIST = sql.join(
  OPEN_STATUSES.map((status) => sql`${status}`),
  sql`, `,
);

/** Due time of the running target, or null. */
export function runningDueSql(): SQL<Date | null> {
  return sql<Date | null>`(CASE WHEN ${ticket.status} IN (${OPEN_LIST}) THEN
    CASE
      WHEN ${ticket.firstRespondedAt} IS NULL AND ${ticket.firstResponseDueAt} IS NOT NULL THEN ${ticket.firstResponseDueAt}
      WHEN ${ticket.resolvedAt} IS NULL AND ${ticket.resolutionDueAt} IS NOT NULL THEN ${ticket.resolutionDueAt}
    END
  END)`;
}

/** `first_response` or `resolution`: which target `runningDueSql` is. */
function runningKindSql(): SQL<string | null> {
  return sql<string | null>`(CASE WHEN ${ticket.status} IN (${OPEN_LIST}) THEN
    CASE
      WHEN ${ticket.firstRespondedAt} IS NULL AND ${ticket.firstResponseDueAt} IS NOT NULL THEN 'first_response'
      WHEN ${ticket.resolvedAt} IS NULL AND ${ticket.resolutionDueAt} IS NOT NULL THEN 'resolution'
    END
  END)`;
}

const atInstant = (now: Date): SQL => sql`${now.toISOString()}::timestamptz`;

/** `none`, `paused`, `breached`, `at_risk` (wall clock), or `candidate` (needs the calendar). */
function slaClassSql(now: Date): SQL<string> {
  const due = runningDueSql();
  const at = atInstant(now);
  return sql<string>`(CASE
    WHEN ${due} IS NULL THEN 'none'
    WHEN ${ticket.slaPausedAt} IS NOT NULL THEN 'paused'
    WHEN ${due} < ${at} THEN 'breached'
    WHEN ${due} <= ${at} + make_interval(mins => ${SLA_AT_RISK_MINUTES}) THEN 'at_risk'
    ELSE 'candidate'
  END)`;
}

/** Sort key of `sla_due_asc`: the running due time, tickets without one last. */
export function runningDueSortKey(): SQL<Date> {
  return sql<Date>`coalesce(${runningDueSql()}, 'infinity'::timestamptz)`;
}

// --- candidates: what the calendar rule is applied to ---

interface Candidate {
  readonly priority: TicketPriority;
  readonly kind: 'first_response' | 'resolution';
  readonly dueMs: number;
  readonly createdMs: number;
  readonly policyId: string | null;
}

interface PolicyClock {
  readonly targets: SlaTargets;
  readonly calendar: BusinessCalendar;
}

const WALL_CLOCK: PolicyClock = { targets: {}, calendar: FALLBACK_CALENDAR };

/** Applies the at-risk rule to candidates, reading each policy and its calendar once. */
class AtRiskRule {
  private readonly clocks = new Map<string, PolicyClock>();

  constructor(
    private readonly database: Database,
    private readonly now: Date,
  ) {}

  private async clockOf(policyId: string | null): Promise<PolicyClock> {
    if (policyId === null) return WALL_CLOCK;
    const known = this.clocks.get(policyId);
    if (known !== undefined) return known;
    const [policy] = await this.database.db
      .select()
      .from(schema.slaPolicy)
      .where(eq(schema.slaPolicy.id, policyId))
      .limit(1);
    const clock: PolicyClock =
      policy === undefined
        ? WALL_CLOCK
        : {
            targets: targetsFromRow(policy),
            calendar: await slaCalendarFor(this.database.db, policy),
          };
    this.clocks.set(policyId, clock);
    return clock;
  }

  async atRisk(candidate: Candidate): Promise<boolean> {
    const clock = await this.clockOf(candidate.policyId);
    const target = clock.targets[candidate.priority];
    const mode: SlaCalendarMode = target?.calendar ?? '24x7';
    const targetMinutes =
      target === undefined
        ? (candidate.dueMs - candidate.createdMs) / 60_000
        : candidate.kind === 'first_response'
          ? target.first_response_min
          : target.resolution_min;
    return isSlaAtRisk({
      now: this.now,
      dueAt: new Date(candidate.dueMs),
      targetMinutes: targetMinutes > 0 ? targetMinutes : null,
      // A ticket whose policy is gone has no calendar to count on: wall clock.
      mode: clock === WALL_CLOCK ? '24x7' : mode,
      calendar: clock.calendar,
    });
  }
}

// --- the stats query ---

const statsRowSchema = z.object({
  status: ticketStatusSchema,
  queue_id: z.uuid().nullable(),
  assignee_id: z.uuid().nullable(),
  priority: ticketPrioritySchema,
  sla_class: z.enum(['none', 'paused', 'breached', 'at_risk', 'candidate']),
  n: z.number().int(),
  due_ms: z.number().nullable(),
  kind: z.enum(['first_response', 'resolution']).nullable(),
  policy_id: z.uuid().nullable(),
  created_ms: z.number().nullable(),
});
type StatsRow = z.infer<typeof statsRowSchema>;

const idRowSchema = z.object({
  id: z.uuid(),
  priority: ticketPrioritySchema,
  kind: z.enum(['first_response', 'resolution']),
  due_ms: z.number(),
  created_ms: z.number(),
  policy_id: z.uuid().nullable(),
});

interface MutableBucket {
  count: number;
  open: number;
  sla: SlaCounts;
}

const emptyBucket = (): MutableBucket => ({
  count: 0,
  open: 0,
  sla: { ok: 0, at_risk: 0, breached: 0, paused: 0 },
});

function addTo(bucket: MutableBucket, status: TicketStatus, n: number, state: SlaState | null) {
  bucket.count += n;
  if (OPEN_STATUSES.includes(status)) bucket.open += n;
  if (state !== null) bucket.sla[state] += n;
}

const frozen = (bucket: MutableBucket): TicketStatsBucket => ({
  count: bucket.count,
  open: bucket.open,
  sla: { ...bucket.sla },
});

/** Largest group first; ties by id so the order is stable. */
function bySize<T extends { readonly count: number }>(
  items: readonly T[],
  id: (item: T) => string,
): T[] {
  return [...items].sort((a, b) => b.count - a.count || id(a).localeCompare(id(b)));
}

@Injectable()
export class TicketSlaStates {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  /**
   * Counts of the tickets that match `filters`, grouped by status, queue, assignee and priority,
   * each group with its SLA states. One statement: SQL counts every group that needs no calendar
   * and returns the few running tickets that do, which TypeScript then classifies.
   */
  async stats(filters: readonly (SQL | undefined)[], now: Date): Promise<TicketStats> {
    const klass = slaClassSql(now);
    const result = await this.database.db.execute(sql`
      WITH base AS (
        SELECT ${ticket.status} AS status, ${ticket.queueId} AS queue_id,
               ${ticket.assigneeId} AS assignee_id, ${ticket.priority} AS priority,
               ${ticket.slaPolicyId} AS policy_id, ${ticket.createdAt} AS created_at,
               ${runningDueSql()} AS due, ${runningKindSql()} AS kind, ${klass} AS sla_class
          FROM ${ticket}
         WHERE ${sql.join(
           filters.filter((filter): filter is SQL => filter !== undefined),
           sql` AND `,
         )}
      )
      SELECT status, queue_id, assignee_id, priority, sla_class, count(*)::int AS n,
             NULL::float8 AS due_ms, NULL::text AS kind, NULL::uuid AS policy_id, NULL::float8 AS created_ms
        FROM base
       WHERE sla_class <> 'candidate'
       GROUP BY status, queue_id, assignee_id, priority, sla_class
      UNION ALL
      SELECT status, queue_id, assignee_id, priority, sla_class, 1,
             (extract(epoch FROM due) * 1000)::float8, kind, policy_id,
             (extract(epoch FROM created_at) * 1000)::float8
        FROM base
       WHERE sla_class = 'candidate'
    `);
    const rows = z.array(statsRowSchema).parse(result.rows);

    const rule = new AtRiskRule(this.database, now);
    const total = emptyBucket();
    const byStatus = new Map<TicketStatus, MutableBucket>();
    const byQueue = new Map<string | null, MutableBucket>();
    const byAssignee = new Map<string | null, MutableBucket>();
    const byPriority = new Map<TicketPriority, MutableBucket>();
    const bucketOf = <K>(map: Map<K, MutableBucket>, key: K): MutableBucket => {
      const found = map.get(key);
      if (found !== undefined) return found;
      const fresh = emptyBucket();
      map.set(key, fresh);
      return fresh;
    };

    for (const row of rows) {
      const state = await this.stateOf(row, rule);
      addTo(total, row.status, row.n, state);
      addTo(bucketOf(byStatus, row.status), row.status, row.n, state);
      addTo(bucketOf(byQueue, row.queue_id), row.status, row.n, state);
      addTo(bucketOf(byAssignee, row.assignee_id), row.status, row.n, state);
      addTo(bucketOf(byPriority, row.priority), row.status, row.n, state);
    }

    return {
      generatedAt: now.toISOString(),
      total: frozen(total),
      byStatus: TICKET_STATUSES.flatMap((status) => {
        const bucket = byStatus.get(status);
        return bucket === undefined ? [] : [{ status, ...frozen(bucket) }];
      }),
      byQueue: bySize(
        [...byQueue].map(([queueId, bucket]) => ({ queueId, ...frozen(bucket) })),
        (item) => item.queueId ?? '',
      ),
      byAssignee: bySize(
        [...byAssignee].map(([assigneeId, bucket]) => ({ assigneeId, ...frozen(bucket) })),
        (item) => item.assigneeId ?? '',
      ),
      byPriority: TICKET_PRIORITIES.flatMap((priority) => {
        const bucket = byPriority.get(priority);
        return bucket === undefined ? [] : [{ priority, ...frozen(bucket) }];
      }),
    };
  }

  private async stateOf(row: StatsRow, rule: AtRiskRule): Promise<SlaState | null> {
    switch (row.sla_class) {
      case 'none':
        return null;
      case 'paused':
        return 'paused';
      case 'breached':
        return 'breached';
      case 'at_risk':
        return 'at_risk';
      case 'candidate': {
        if (row.kind === null || row.due_ms === null || row.created_ms === null) return 'ok';
        return (await rule.atRisk({
          priority: row.priority,
          kind: row.kind,
          dueMs: row.due_ms,
          createdMs: row.created_ms,
          policyId: row.policy_id,
        }))
          ? 'at_risk'
          : 'ok';
      }
    }
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
    const rule = new AtRiskRule(this.database, now);
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
