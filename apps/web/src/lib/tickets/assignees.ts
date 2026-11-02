'use client';

import { useQuery } from '@tanstack/react-query';

import { useApi } from '@/lib/api/api-context';
import { useUserId } from '@/lib/auth/session';

/**
 * Who a bulk "Assign to..." can name (`GET /v1/assignees`): staff with their queue membership for
 * the given queue, and a `scope` that says whether that queue narrowed the list.
 */
export function useQueueAssignees(queueId: string | undefined, enabled: boolean) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: ['user', userId, 'queue-assignees', queueId ?? null],
    queryFn: ({ signal }) => api.assignees(queueId ? { queueId } : {}, signal),
    enabled,
    staleTime: 15_000,
  });
}
