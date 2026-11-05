import { HttpException, HttpStatus } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import {
  rosterQuery,
  sessionQuery,
  shiftTimezone,
  toRosterEntry,
  toSession,
  type RosterViewRow,
  type SessionViewRow,
} from '@watchtower/domain';
import type { HandoffIncomplete } from '@watchtower/shared';
import { and, eq, isNull } from 'drizzle-orm';

export { rosterQuery, sessionQuery, shiftTimezone, toRosterEntry, toSession };
export type { RosterViewRow, SessionViewRow };

/** The clock of the shift features. Tests replace it to move time; production uses the system clock. */
export const SHIFT_NOW = Symbol('SHIFT_NOW');
export type ShiftNow = () => Date;

export type Executor = Pick<Database['db'], 'select'>;

/**
 * 409 `handoff_incomplete`: the answer to a clock out (or a confirm) that AC-7 refuses. The body
 * carries what is missing, so the web can list it (UI spec 9.3 error summary).
 */
export class HandoffIncompleteError extends HttpException {
  readonly code = 'handoff_incomplete';

  constructor(readonly details: HandoffIncomplete) {
    const message = details.noConfirmedHandoff
      ? 'Finish the handoff first: it is not confirmed yet'
      : `Finish the handoff first: ${String(details.blockers.length)} ticket(s) need a next action`;
    super(
      {
        statusCode: HttpStatus.CONFLICT,
        error: 'Conflict',
        code: 'handoff_incomplete',
        message,
        noConfirmedHandoff: details.noConfirmedHandoff,
        blockers: details.blockers,
      },
      HttpStatus.CONFLICT,
    );
  }
}

/** A handoff or item in a state that does not allow the change (409 `handoff_locked`). */
export class HandoffLockedError extends HttpException {
  readonly code = 'handoff_locked';

  constructor(message: string) {
    super(
      { statusCode: HttpStatus.CONFLICT, error: 'Conflict', code: 'handoff_locked', message },
      HttpStatus.CONFLICT,
    );
  }
}

// --- sessions ---

/** The open session of a person, if they are clocked in. */
export async function openSessionOf(
  executor: Executor,
  userId: string,
): Promise<SessionViewRow | undefined> {
  const [row] = await sessionQuery(executor)
    .where(and(eq(schema.shiftSession.userId, userId), isNull(schema.shiftSession.clockedOutAt)))
    .limit(1);
  return row;
}

export async function sessionById(
  executor: Executor,
  id: string,
): Promise<SessionViewRow | undefined> {
  const [row] = await sessionQuery(executor).where(eq(schema.shiftSession.id, id)).limit(1);
  return row;
}
