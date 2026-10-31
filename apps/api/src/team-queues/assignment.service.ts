import { Injectable } from '@nestjs/common';
import { schema } from '@watchtower/db';
import { STAFF_ROLES } from '@watchtower/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';

import { badRequest } from '../auth/http-errors.js';
import type { DbTransaction } from '../realtime/unit-of-work.js';

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
 * Round-robin assignment inside a team queue (R-1.7). Only active staff count: the shift system
 * does not exist yet, so "on shift" is `[ASSUMED]` to mean "active" until T-2xx adds clock-in.
 *
 * Safe under concurrency: the queue row is locked (`FOR UPDATE`) for the rest of the caller's
 * transaction, so two tickets created at the same moment are handed to two different members in
 * turn, never the same one twice because both read the same cursor.
 */
@Injectable()
export class AssignmentService {
  /** The next member of the queue to receive a ticket, or null when it has no active member. */
  async nextRoundRobin(tx: DbTransaction, queueId: string): Promise<string | null> {
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

    const next = pickNextMember(
      members.map((member) => member.id),
      queue.last,
    );
    if (next === null) return null;
    await tx
      .update(schema.teamQueue)
      .set({ lastAssignedUserId: next })
      .where(eq(schema.teamQueue.id, queueId));
    return next;
  }
}
