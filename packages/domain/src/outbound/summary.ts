import type { DeliverySummary } from '@watchtower/shared';

import type { OutboundDeliveryRow } from '../rows.js';

/** A delivery as staff see it next to a message: enough to draw Undo, "sending" and Retry. No text, no ids of the provider. */
export function toDeliverySummary(row: OutboundDeliveryRow, now: Date): DeliverySummary {
  return {
    id: row.id,
    state: row.state as DeliverySummary['state'],
    origin: row.origin as DeliverySummary['origin'],
    channel: row.channel as DeliverySummary['channel'],
    sendAt: row.nextAttemptAt.toISOString(),
    // A hold of 0 is "send now"; and a push that was attempted before can no longer be undone (T-122f F-1).
    // The endpoint decides; this is the hint that draws the button, read with the caller's clock.
    cancellable:
      row.state === 'scheduled' &&
      row.holdSeconds !== 0 &&
      !(row.route === 'line_push' && row.attempts > 0) &&
      row.nextAttemptAt.getTime() > now.getTime(),
    attempts: row.attempts,
    errorCode: row.errorCode,
    outcomeUnknown: row.outcomeUnknown,
    sentAt: row.sentAt?.toISOString() ?? null,
  };
}
