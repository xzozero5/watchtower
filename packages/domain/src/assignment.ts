import { schema } from '@watchtower/db';
import { STAFF_ROLES } from '@watchtower/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';

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

/**
 * Whose turn it is in a round-robin queue (R-1.7), without taking it. Locks the queue row for the
 * rest of the transaction, so the answer stays true until `takeTurn` (or the end of the
 * transaction): two tickets created at the same moment go to two different members in turn.
 *
 * Only active staff count: the shift system does not exist yet, so "on shift" is `[ASSUMED]` to
 * mean "active" until the shifts task adds clock-in.
 */
export async function peekRoundRobin(tx: DbTransaction, queueId: string): Promise<string | null> {
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
      ),
    )
    .orderBy(asc(schema.users.id));

  return pickNextMember(
    members.map((member) => member.id),
    queue.last,
  );
}

/** Records that `userId` took the turn, so the next one goes to the member after them. */
export async function takeTurn(tx: DbTransaction, queueId: string, userId: string): Promise<void> {
  await tx
    .update(schema.teamQueue)
    .set({ lastAssignedUserId: userId })
    .where(eq(schema.teamQueue.id, queueId));
}

/** The next member of the queue to receive a ticket, or null when it has no active member. Takes the turn. */
export async function nextRoundRobin(tx: DbTransaction, queueId: string): Promise<string | null> {
  const next = await peekRoundRobin(tx, queueId);
  if (next !== null) await takeTurn(tx, queueId, next);
  return next;
}

/** Anyone who can be handed a ticket: active staff. (Shifts do not exist yet, so on-shift is `[ASSUMED]` to mean active.) */
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
