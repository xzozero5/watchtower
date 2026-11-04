import {
  notificationPageSchema,
  notificationPreferencesSchema,
  notificationReadAllResultSchema,
  webPushStatusSchema,
  type SetNotificationPreferences,
  type WebPushSubscribe,
} from '@watchtower/shared';

import type { ApiClient } from './client';

const withSignal = (signal?: AbortSignal) => (signal ? { signal } : {});

/** The caller's own notifications (T-105). One function per endpoint, no component builds a URL. */
export function createNotificationEndpoints(client: ApiClient) {
  return {
    notifications: (params: { unread?: boolean; limit?: number }, signal?: AbortSignal) =>
      client.request({
        path: '/v1/notifications',
        query: {
          ...(params.unread === undefined ? {} : { unread: String(params.unread) }),
          ...(params.limit === undefined ? {} : { limit: params.limit }),
        },
        schema: notificationPageSchema,
        ...withSignal(signal),
      }),

    markNotificationRead: (id: string) =>
      client.request({
        method: 'POST',
        path: `/v1/notifications/${encodeURIComponent(id)}/read`,
        schema: null,
      }),

    markAllNotificationsRead: () =>
      client.request({
        method: 'POST',
        path: '/v1/notifications/read-all',
        schema: notificationReadAllResultSchema,
      }),

    notificationPreferences: (signal?: AbortSignal) =>
      client.request({
        path: '/v1/notifications/preferences',
        schema: notificationPreferencesSchema,
        ...withSignal(signal),
      }),

    webPushStatus: (signal?: AbortSignal) =>
      client.request({
        path: '/v1/notifications/push',
        schema: webPushStatusSchema,
        ...withSignal(signal),
      }),

    webPushSubscribe: (body: WebPushSubscribe) =>
      client.request({
        method: 'POST',
        path: '/v1/notifications/push/subscriptions',
        body,
        schema: webPushStatusSchema,
      }),

    webPushUnsubscribe: (endpoint: string) =>
      client.request({
        method: 'DELETE',
        path: '/v1/notifications/push/subscriptions',
        body: { endpoint },
        schema: webPushStatusSchema,
      }),

    setNotificationPreferences: (body: SetNotificationPreferences) =>
      client.request({
        method: 'PUT',
        path: '/v1/notifications/preferences',
        body,
        schema: notificationPreferencesSchema,
      }),
  };
}
