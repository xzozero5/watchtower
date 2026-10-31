import type { QueryClient } from '@tanstack/react-query';

import { draftStore } from '@/lib/tickets/templates';

import { markSignedOut } from './session-hint';
import { SESSION_QUERY_KEY } from './session-key';

/**
 * Forgets everything this tab holds for the person who was signed in: the "had a session" hint,
 * the unsent drafts and every cached query except the session itself, which becomes `null` ("signed
 * out") so the auth gate leaves. Used by sign out and by an expired session alike, so the next
 * person to sign in on this tab can never see the previous person's tickets or half-written replies.
 * Query keys are also scoped by user id (see `userScope`) as a second line of defence.
 */
export function endSession(queryClient: QueryClient): void {
  markSignedOut();
  draftStore.clear();
  // An answer that is still on its way for the old person must not land in the cache afterwards.
  void queryClient.cancelQueries({
    predicate: (query) => query.queryKey[0] !== SESSION_QUERY_KEY[0],
  });
  queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== SESSION_QUERY_KEY[0] });
  queryClient.setQueryData(SESSION_QUERY_KEY, null);
}
