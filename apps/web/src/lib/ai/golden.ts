import type { Message } from '@watchtower/shared';

import { isApiError } from '@/lib/api/errors';

/**
 * A reply a customer has: sent by staff on a public thread and either delivered or sent on a channel with no
 * delivery step (the portal). A reply still waiting out the undo window, scheduled, cancelled or failed is
 * not one yet, so it cannot be kept as an example.
 */
export function canMarkGolden(
  message: Pick<Message, 'direction' | 'visibility' | 'deliveryStatus'>,
): boolean {
  return (
    message.direction === 'outbound' &&
    message.visibility === 'public' &&
    (message.deliveryStatus === 'delivered' || message.deliveryStatus === 'not_applicable')
  );
}

export type GoldenErrorKey = 'noIntent' | 'notSent' | 'redact' | 'already' | 'generic';

/** Which sentence to show for a refused "Mark as golden". The api's answers are stable: 400 and 409 only. */
export function goldenErrorKey(error: unknown): GoldenErrorKey {
  if (!isApiError(error)) return 'generic';
  const message = error.message.toLowerCase();
  if (error.status === 409) {
    if (message.includes('already')) return 'already';
    if (message.includes('intent')) return 'noIntent';
    return 'generic';
  }
  if (error.status === 400) {
    return message.includes('redact') ? 'redact' : 'notSent';
  }
  return 'generic';
}
