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
    cancellable: row.state === 'scheduled' && row.nextAttemptAt.getTime() > now.getTime(),
    attempts: row.attempts,
    errorCode: row.errorCode,
    outcomeUnknown: row.outcomeUnknown,
    sentAt: row.sentAt?.toISOString() ?? null,
  };
}
