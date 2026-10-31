import { Injectable } from '@nestjs/common';
import { nextRoundRobin, peekRoundRobin, pickNextMember, takeTurn } from '@watchtower/domain';

import { translating } from '../domain/domain-errors.js';
import type { DbTransaction } from '../realtime/unit-of-work.js';

// The rotation logic moved to @watchtower/domain (ADR-009), where the worker uses it too.
export { pickNextMember };

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
  /** The next member of the queue to receive a ticket, or null when it has no active member. Takes the turn. */
  async nextRoundRobin(tx: DbTransaction, queueId: string): Promise<string | null> {
    return translating(() => nextRoundRobin(tx, queueId));
  }

  /**
   * Whose turn it is, without taking it. Locks the queue row for the rest of the transaction, so
   * the answer stays true until the caller calls `takeTurn` (or ends the transaction).
   */
  async peekRoundRobin(tx: DbTransaction, queueId: string): Promise<string | null> {
    return translating(() => peekRoundRobin(tx, queueId));
  }

  /** Records that `userId` took the turn, so the next one goes to the member after them. */
  async takeTurn(tx: DbTransaction, queueId: string, userId: string): Promise<void> {
    await takeTurn(tx, queueId, userId);
  }
}
