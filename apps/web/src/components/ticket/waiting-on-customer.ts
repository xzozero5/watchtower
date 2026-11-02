import type { TimelineEntry } from '@watchtower/shared';

/**
 * True when the customer wrote last and nobody has answered them in public since: setting the
 * ticket to "Waiting on customer" then leaves them looking at "waiting for your reply" with no
 * question. A reply that was undone or failed does not count; one held for the undo window does
 * (it is on its way). A ticket the customer never wrote on has nothing to answer, so it is false.
 */
export function awaitsFirstAnswer(entries: readonly TimelineEntry[]): boolean {
  let lastInbound = -1;
  entries.forEach((entry, index) => {
    if (
      entry.kind === 'message' &&
      entry.direction === 'inbound' &&
      entry.visibility === 'public'
    ) {
      lastInbound = index;
    }
  });
  if (lastInbound === -1) return false;
  return !entries
    .slice(lastInbound + 1)
    .some(
      (entry) =>
        entry.kind === 'message' &&
        entry.direction === 'outbound' &&
        entry.visibility === 'public' &&
        entry.deliveryStatus !== 'cancelled' &&
        entry.deliveryStatus !== 'failed',
    );
}
