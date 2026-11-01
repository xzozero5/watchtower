import { schema } from '@watchtower/db';
import { OPEN_STATUSES, SHIFT_SESSION_MAX_HOURS, STAFF_ROLES } from '@watchtower/shared';
import { and, asc, desc, eq, inArray, isNotNull, ne, sql, type SQL } from 'drizzle-orm';

import { badRequest } from './errors.js';
import type { DbTransaction, ReadExecutor } from './types.js';

/**
 * The member after `last` in id order, wrapping round to the first. Ordering by id (not by when a
 * member joined) keeps the rotation stable when members come and go: a removed `last` simply means
 * "continue from where that id would have been".
 */
export function pickNextMember(sortedIds: readonly string[], last: string | null): string | null {
  const first = sortedIds[0];
  if (first === undefined) return null;
  if (last === null) return first;
  return sortedIds.find((id) => id > last) ?? first;
}

/** The ways a queue picks a person for a ticket (R-1.7); `manual` picks nobody. */
export const ASSIGN_STRATEGIES = [
  'round_robin',
  'load_balanced',
  'stay_with_last_handler',
] as const;
export type AssignStrategy = (typeof ASSIGN_STRATEGIES)[number];

export function isAssignStrategy(value: string): value is AssignStrategy {
  return (ASSIGN_STRATEGIES as readonly string[]).includes(value);
}

/** Facts about the ticket that some strategies use. */
export interface AssignHints {
  /** Who asked: `stay_with_last_handler` looks for the last person who handled this requester. */
  readonly requesterContactId?: string | null;
  /** A ticket that does not count as "the last one" (the ticket being assigned). */
  readonly excludeTicketId?: string;
}

/**
 * The least loaded of `candidates` (fewest open tickets). Ties go to whoever is next in turn after
 * `last`, so equal load rotates instead of always choosing the lowest id.
 */
export function pickLeastLoaded(
  candidates: readonly { readonly id: string; readonly open: number }[],
  last: string | null,
): string | null {
  if (candidates.length === 0) return null;
  const fewest = Math.min(...candidates.map((candidate) => candidate.open));
  const tied = candidates
    .filter((candidate) => candidate.open === fewest)
    .map((candidate) => candidate.id)
    .toSorted();
  return pickNextMember(tied, last);
}

/**
 * Is `users.id` of the surrounding query clocked in? A session counts while it is open and younger
 * than `SHIFT_SESSION_MAX_HOURS` (a forgotten clock out must not keep tickets coming for ever).
 * The outer id is written table-qualified on purpose: drizzle prints a bare column name in a query
 * over one table, and inside the subquery that name would bind to `shift_session` itself.
 */
export function onShiftCondition(): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${schema.shiftSession}
     WHERE ${schema.shiftSession.userId} = ${schema.users}."id"
       AND ${schema.shiftSession.clockedOutAt} IS NULL
       AND ${schema.shiftSession.clockedInAt} > now() - make_interval(hours => ${SHIFT_SESSION_MAX_HOURS})
  )`;
}

/** Open tickets per person (the load of R-1.7). People without any are present with 0. */
export async function openTicketCounts(
  executor: ReadExecutor,
  userIds: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map(userIds.map((id): [string, number] => [id, 0]));
  if (userIds.length === 0) return counts;
  const rows = await executor
    .select({ id: schema.ticket.assigneeId, n: sql<number>`count(*)::int` })
    .from(schema.ticket)
    .where(
      and(
        inArray(schema.ticket.assigneeId, [...userIds]),
        inArray(schema.ticket.status, [...OPEN_STATUSES]),
      ),
    )
    .groupBy(schema.ticket.assigneeId);
  for (const row of rows) if (row.id !== null) counts.set(row.id, row.n);
  return counts;
}

/**
 * Who a queue would give the next ticket to under `strategy`, without taking the turn. Only
 * members who are active staff and clocked in are candidates (R-1.7, T-111). Locks the queue row
 * for the rest of the transaction, so the answer stays true until `takeTurn` (or the end of the
 * transaction): two tickets created at the same moment go to two different people, and the load
 * counts of `load_balanced` are not read by two callers at once.
 *
 * - `round_robin`: the next candidate in id order after the last one chosen.
 * - `load_balanced`: the candidate with the fewest open tickets; ties rotate.
 * - `stay_with_last_handler`: the person who handled the requester's latest assigned ticket, if
 *   they are a candidate; otherwise the same as `load_balanced` `[ASSUMED]`.
 */
export async function peekAssignee(
  tx: DbTransaction,
  queueId: string,
  strategy: AssignStrategy,
  hints: AssignHints = {},
): Promise<string | null> {
  const [queue] = await tx
    .select({ last: schema.teamQueue.lastAssignedUserId })
    .from(schema.teamQueue)
    .where(eq(schema.teamQueue.id, queueId))
    .for('update');
  if (!queue) throw badRequest('queueId does not refer to a queue');

  const members = await tx
    .select({ id: schema.users.id })
    .from(schema.teamQueueMember)
    .innerJoin(schema.users, eq(schema.users.id, schema.teamQueueMember.userId))
    .where(
      and(
        eq(schema.teamQueueMember.queueId, queueId),
        eq(schema.users.status, 'active'),
        inArray(schema.users.role, [...STAFF_ROLES]),
        onShiftCondition(),
      ),
    )
    .orderBy(asc(schema.users.id));
  const ids = members.map((member) => member.id);

  if (strategy === 'round_robin') return pickNextMember(ids, queue.last);

  if (strategy === 'stay_with_last_handler' && hints.requesterContactId) {
    const [previous] = await tx
      .select({ assigneeId: schema.ticket.assigneeId })
      .from(schema.ticket)
      .where(
        and(
          eq(schema.ticket.requesterContactId, hints.requesterContactId),
          isNotNull(schema.ticket.assigneeId),
          hints.excludeTicketId === undefined
            ? undefined
            : ne(schema.ticket.id, hints.excludeTicketId),
        ),
      )
      .orderBy(desc(schema.ticket.createdAt), desc(schema.ticket.id))
      .limit(1);
    if (previous?.assigneeId && ids.includes(previous.assigneeId)) return previous.assigneeId;
  }

  const load = await openTicketCounts(tx, ids);
  return pickLeastLoaded(
    ids.map((id) => ({ id, open: load.get(id) ?? 0 })),
    queue.last,
  );
}

/**
 * Whose turn it is in a round-robin queue (R-1.7), without taking it: `peekAssignee` with the
 * `round_robin` strategy. Only active staff who are clocked in count.
 */
export async function peekRoundRobin(tx: DbTransaction, queueId: string): Promise<string | null> {
  return peekAssignee(tx, queueId, 'round_robin');
}

/** Records that `userId` took the turn, so the next one goes to the member after them. */
export async function takeTurn(tx: DbTransaction, queueId: string, userId: string): Promise<void> {
  await tx
    .update(schema.teamQueue)
    .set({ lastAssignedUserId: userId })
    .where(eq(schema.teamQueue.id, queueId));
}

/** The person `strategy` picks, or null when no member is clocked in. Takes the turn. */
export async function nextAssignee(
  tx: DbTransaction,
  queueId: string,
  strategy: AssignStrategy,
  hints: AssignHints = {},
): Promise<string | null> {
  const next = await peekAssignee(tx, queueId, strategy, hints);
  if (next !== null) await takeTurn(tx, queueId, next);
  return next;
}

/** The next member of the queue to receive a ticket, or null when none is clocked in. Takes the turn. */
export async function nextRoundRobin(tx: DbTransaction, queueId: string): Promise<string | null> {
  return nextAssignee(tx, queueId, 'round_robin');
}

/** Anyone who can be handed a ticket by hand: active staff (a manual assignment does not need a clock in). */
export async function assertAssignableStaff(
  executor: ReadExecutor,
  userIds: readonly string[],
): Promise<void> {
  if (userIds.length === 0) return;
  const rows = await executor
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(
      and(
        inArray(schema.users.id, [...userIds]),
        eq(schema.users.status, 'active'),
        inArray(schema.users.role, [...STAFF_ROLES]),
      ),
    );
  const found = new Set(rows.map((row) => row.id));
  const missing = userIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw badRequest('Every member must be an existing, active staff user');
  }
}
