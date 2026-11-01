'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Notification, SetNotificationPreferences } from '@watchtower/shared';

import { useApi } from '@/lib/api/api-context';
import { useUserId } from '@/lib/auth/session';

import { notificationKeys } from './keys';

/**
 * Safety net under the realtime feed (which has no replay): the badge and the banner are re-read
 * this often even if an event was missed. `[ASSUMED]`
 */
export const NOTIFICATION_POLL_MS = 60_000;

/** The newest notifications of the signed-in person, and how many are unread. */
export function useNotifications(enabled: boolean) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: notificationKeys(userId).list,
    queryFn: ({ signal }) => api.notifications({ limit: 30 }, signal),
    enabled,
    refetchInterval: NOTIFICATION_POLL_MS,
    staleTime: NOTIFICATION_POLL_MS / 2,
  });
}

/** Unread critical (P1) notifications, newest first: what the sticky banner shows. */
export function useCriticalNotifications(enabled: boolean) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: notificationKeys(userId).critical,
    queryFn: async ({ signal }): Promise<Notification[]> => {
      const page = await api.notifications({ unread: true, limit: 50 }, signal);
      return page.items.filter((item) => item.severity === 'critical');
    },
    enabled,
    refetchInterval: NOTIFICATION_POLL_MS,
    staleTime: NOTIFICATION_POLL_MS / 2,
  });
}

export function useNotificationMutations() {
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: notificationKeys(userId).all });
  const markRead = useMutation({
    mutationFn: (id: string) => api.markNotificationRead(id),
    onSuccess: refresh,
  });
  const markAllRead = useMutation({
    mutationFn: () => api.markAllNotificationsRead(),
    onSuccess: refresh,
  });
  return { markRead, markAllRead };
}

export function useNotificationPreferences(enabled: boolean) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: notificationKeys(userId).preferences,
    queryFn: ({ signal }) => api.notificationPreferences(signal),
    enabled,
  });
}

export function useSetNotificationPreferences() {
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: SetNotificationPreferences) => api.setNotificationPreferences(body),
    onSuccess: (preferences) => {
      queryClient.setQueryData(notificationKeys(userId).preferences, preferences);
    },
  });
}
