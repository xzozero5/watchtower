import { userScope } from '@/lib/tickets/queries';

/** Query keys of the notification center, scoped by user like every other cache of the app. */
export const notificationKeys = (userId: string) => {
  const all = [...userScope(userId), 'notifications'] as const;
  return {
    all,
    list: [...all, 'list'] as const,
    /** Unread critical ones: what the sticky banner shows. */
    critical: [...all, 'critical'] as const,
    preferences: [...all, 'preferences'] as const,
  };
};
