import type { Notification, NotificationKind } from '@watchtower/shared';

import type { MessageKey } from '@/i18n';

/** The catalogue key of each kind, under `notifications.kind` and `notifications.kindName`. */
export const KIND_KEY = {
  'ticket.p1': 'ticketP1',
  'ticket.assigned': 'ticketAssigned',
  'ticket.escalation_requested': 'ticketEscalationRequested',
  'shift.handoff_overdue': 'shiftHandoffOverdue',
  'shift.no_show': 'shiftNoShow',
  'alert.fired': 'alertFired',
  'alert.escalated': 'alertEscalated',
  'ops.smtp_auth_failed': 'opsSmtpAuthFailed',
  'ops.upload_quota_global': 'opsUploadQuotaGlobal',
  'ops.outbox_dead': 'opsOutboxDead',
} as const satisfies Record<NotificationKind, string>;

export function kindMessageKey(kind: NotificationKind): MessageKey {
  return `notifications.kind.${KIND_KEY[kind]}`;
}

export function kindNameKey(kind: NotificationKind): MessageKey {
  return `notifications.kindName.${KIND_KEY[kind]}`;
}

/** The placeholders a kind's sentence needs: the ticket key, or the count of items. */
export function kindValues(item: Notification): Record<string, string | number> {
  const count = item.data.count;
  return {
    key: item.ticket?.key ?? '',
    count: typeof count === 'number' ? count : 0,
  };
}

/** The ticket a notification opens, as a path of the queue workspace; null for a shift alert. */
export function notificationHref(item: Notification): string | null {
  return item.ticket === null ? null : `/?ticket=${encodeURIComponent(item.ticket.key)}`;
}

/** True when two instants fall on the same calendar day in the viewer's time zone. */
export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
