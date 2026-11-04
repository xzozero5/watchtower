/**
 * English copy of the notification center and the P1 banner (T-105, docs/06-UI-SPEC.md section 8).
 * Kept in its own file, like the AI and portal copy, and merged into the catalogue by one line in
 * en/index.ts. ../th/notifications.ts must have the same keys. Phase 1 has no sound and no Web Push, so no
 * copy for them.
 */
export const notificationsEn = {
  center: {
    title: 'Notifications',
    openLabel: 'Notifications',
    openLabelUnread: 'Notifications, {count} unread',
    unreadBadge: '{count} unread',
    markAllRead: 'Mark all read',
    markRead: 'Mark read',
    unread: 'Unread',
    loading: 'Loading…',
    error: 'Notifications are not available.',
    retry: 'Try again',
    empty: 'You are all caught up.',
    today: 'Today',
    earlier: 'Earlier',
    settings: 'Settings',
    settingsTitle: 'Tell me about',
    settingsHint: 'Only in the app. A P1 ticket is always shown.',
    alwaysOn: 'Always on',
    saveError: 'The setting was not saved.',
  },
  kind: {
    ticketP1: 'P1 ticket {key}',
    ticketAssigned: '{key} was assigned to you',
    shiftHandoffOverdue: '{count} handoff items were not acknowledged in time',
    shiftNoShow: 'Someone has not clocked in for their shift',
    alertFired: 'An alert needs you',
    alertEscalated: 'An alert was not acknowledged and has reached you',
  },
  kindName: {
    ticketP1: 'P1 tickets',
    ticketAssigned: 'Tickets assigned to me',
    shiftHandoffOverdue: 'Handoff items not acknowledged (leads)',
    shiftNoShow: 'Shift no-shows (leads)',
    alertFired: 'Alerts that need me (on shift)',
    alertEscalated: 'Alerts that were not acknowledged in time',
  },
  banner: {
    label: 'Critical alert',
    title: 'P1 Critical',
    notAcknowledged: 'not acknowledged',
    open: 'Open ticket',
    acknowledge: 'Acknowledge',
    moreCount: '+{count} more P1',
    showAll: 'Show all',
    hideAll: 'Show less',
    list: 'Unacknowledged P1 tickets',
    openNamed: 'Open ticket {key}',
    acknowledgeNamed: 'Acknowledge {key}',
    tabPrefix: '(P1)',
  },
} as const;
