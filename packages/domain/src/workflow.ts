import { schema } from '@watchtower/db';
import type { TicketStatus } from '@watchtower/shared';
import { and, eq } from 'drizzle-orm';

import type { ReadExecutor } from './types.js';

/**
 * Whether the configurable workflow (`ticket_status_transition`, R-1.2) allows `from` -> `to`.
 * Read inside the caller's transaction, so a change a head just made counts at once. (The api's
 * `WorkflowService` keeps its 5 s cache for the settings screen; a status change needs the truth.)
 */
export async function workflowAllows(
  executor: ReadExecutor,
  from: TicketStatus,
  to: TicketStatus,
): Promise<boolean> {
  const [row] = await executor
    .select({ fromStatus: schema.ticketStatusTransition.fromStatus })
    .from(schema.ticketStatusTransition)
    .where(
      and(
        eq(schema.ticketStatusTransition.fromStatus, from),
        eq(schema.ticketStatusTransition.toStatus, to),
      ),
    )
    .limit(1);
  return row !== undefined;
}
