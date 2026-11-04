/**
 * Phase 1 features (T-123a). Each feature owns one file in this directory with its audit actions,
 * ticket event types and queue names, so parallel tasks never edit the same lines of
 * `auth.ts` / `ticketing.ts` / `queues.ts`. To add one: put an entry in your own feature file;
 * nothing else in `packages/shared` needs to change.
 *
 * This file only composes the records. It is edited when a new feature file is created.
 */
import { INBOUND_AUDIT_ACTIONS, INBOUND_QUEUES, INBOUND_TICKET_EVENTS } from './inbound.js';
import { OUTBOUND_AUDIT_ACTIONS, OUTBOUND_QUEUES, OUTBOUND_TICKET_EVENTS } from './outbound.js';
import { GMAIL_AUDIT_ACTIONS, GMAIL_QUEUES, GMAIL_TICKET_EVENTS } from './gmail.js';
import { LINE_AUDIT_ACTIONS, LINE_QUEUES, LINE_TICKET_EVENTS } from './line.js';
import { DISCORD_AUDIT_ACTIONS, DISCORD_QUEUES, DISCORD_TICKET_EVENTS } from './discord.js';
import {
  NOTIFICATIONS_AUDIT_ACTIONS,
  NOTIFICATIONS_QUEUES,
  NOTIFICATIONS_TICKET_EVENTS,
} from './notifications.js';
import { AI_AUDIT_ACTIONS, AI_QUEUES, AI_TICKET_EVENTS } from './ai.js';
import { KB_AUDIT_ACTIONS, KB_QUEUES, KB_TICKET_EVENTS } from './kb.js';
import { CSAT_AUDIT_ACTIONS, CSAT_QUEUES, CSAT_TICKET_EVENTS } from './csat.js';
import { SHIFTS_AUDIT_ACTIONS, SHIFTS_QUEUES, SHIFTS_TICKET_EVENTS } from './shifts.js';
import { AUTONOMY_AUDIT_ACTIONS, AUTONOMY_QUEUES, AUTONOMY_TICKET_EVENTS } from './autonomy.js';
import {
  CREDENTIALS_AUDIT_ACTIONS,
  CREDENTIALS_QUEUES,
  CREDENTIALS_TICKET_EVENTS,
} from './credentials.js';
import { VIEWS_AUDIT_ACTIONS, VIEWS_QUEUES, VIEWS_TICKET_EVENTS } from './views.js';
import { ADMIN_AUDIT_ACTIONS, ADMIN_QUEUES, ADMIN_TICKET_EVENTS } from './admin.js';
import {
  CHANNEL_ACCOUNTS_AUDIT_ACTIONS,
  CHANNEL_ACCOUNTS_QUEUES,
  CHANNEL_ACCOUNTS_TICKET_EVENTS,
} from './channel-accounts.js';

import { ALERTS_AUDIT_ACTIONS, ALERTS_QUEUES, ALERTS_TICKET_EVENTS } from './alerts.js';
import { INCIDENTS_AUDIT_ACTIONS, INCIDENTS_QUEUES, INCIDENTS_TICKET_EVENTS } from './incidents.js';
import { TOOLS_AUDIT_ACTIONS, TOOLS_QUEUES, TOOLS_TICKET_EVENTS } from './tools.js';
import {
  STATUSPAGE_AUDIT_ACTIONS,
  STATUSPAGE_QUEUES,
  STATUSPAGE_TICKET_EVENTS,
} from './statuspage.js';
import { USAGE_AUDIT_ACTIONS, USAGE_QUEUES, USAGE_TICKET_EVENTS } from './usage.js';
import { DASHBOARD_AUDIT_ACTIONS, DASHBOARD_QUEUES, DASHBOARD_TICKET_EVENTS } from './dashboard.js';
import { UPLOADS_AUDIT_ACTIONS, UPLOADS_QUEUES, UPLOADS_TICKET_EVENTS } from './uploads.js';

export * from './inbound.js';
export * from './outbound.js';
export * from './gmail.js';
export * from './line.js';
export * from './discord.js';
export * from './notifications.js';
export * from './ai.js';
export * from './claims.js';
export * from './assistant.js';
export * from './kb.js';
export * from './csat.js';
export * from './shifts.js';
export * from './autonomy.js';
export * from './credentials.js';
export * from './views.js';
export * from './admin.js';
export * from './channel-accounts.js';
export * from './alerts.js';
export * from './incidents.js';
export * from './tools.js';
export * from './statuspage.js';
export * from './usage.js';
export * from './dashboard.js';
export * from './uploads.js';
export { assertDisjoint } from './compose.js';

export const FEATURES = [
  {
    name: 'inbound',
    auditActions: INBOUND_AUDIT_ACTIONS,
    ticketEvents: INBOUND_TICKET_EVENTS,
    queues: INBOUND_QUEUES,
  },
  {
    name: 'outbound',
    auditActions: OUTBOUND_AUDIT_ACTIONS,
    ticketEvents: OUTBOUND_TICKET_EVENTS,
    queues: OUTBOUND_QUEUES,
  },
  {
    name: 'gmail',
    auditActions: GMAIL_AUDIT_ACTIONS,
    ticketEvents: GMAIL_TICKET_EVENTS,
    queues: GMAIL_QUEUES,
  },
  {
    name: 'line',
    auditActions: LINE_AUDIT_ACTIONS,
    ticketEvents: LINE_TICKET_EVENTS,
    queues: LINE_QUEUES,
  },
  {
    name: 'discord',
    auditActions: DISCORD_AUDIT_ACTIONS,
    ticketEvents: DISCORD_TICKET_EVENTS,
    queues: DISCORD_QUEUES,
  },
  {
    name: 'notifications',
    auditActions: NOTIFICATIONS_AUDIT_ACTIONS,
    ticketEvents: NOTIFICATIONS_TICKET_EVENTS,
    queues: NOTIFICATIONS_QUEUES,
  },
  { name: 'ai', auditActions: AI_AUDIT_ACTIONS, ticketEvents: AI_TICKET_EVENTS, queues: AI_QUEUES },
  { name: 'kb', auditActions: KB_AUDIT_ACTIONS, ticketEvents: KB_TICKET_EVENTS, queues: KB_QUEUES },
  {
    name: 'csat',
    auditActions: CSAT_AUDIT_ACTIONS,
    ticketEvents: CSAT_TICKET_EVENTS,
    queues: CSAT_QUEUES,
  },
  {
    name: 'shifts',
    auditActions: SHIFTS_AUDIT_ACTIONS,
    ticketEvents: SHIFTS_TICKET_EVENTS,
    queues: SHIFTS_QUEUES,
  },
  {
    name: 'autonomy',
    auditActions: AUTONOMY_AUDIT_ACTIONS,
    ticketEvents: AUTONOMY_TICKET_EVENTS,
    queues: AUTONOMY_QUEUES,
  },
  {
    name: 'credentials',
    auditActions: CREDENTIALS_AUDIT_ACTIONS,
    ticketEvents: CREDENTIALS_TICKET_EVENTS,
    queues: CREDENTIALS_QUEUES,
  },
  {
    name: 'views',
    auditActions: VIEWS_AUDIT_ACTIONS,
    ticketEvents: VIEWS_TICKET_EVENTS,
    queues: VIEWS_QUEUES,
  },
  {
    name: 'admin',
    auditActions: ADMIN_AUDIT_ACTIONS,
    ticketEvents: ADMIN_TICKET_EVENTS,
    queues: ADMIN_QUEUES,
  },
  {
    name: 'channelAccounts',
    auditActions: CHANNEL_ACCOUNTS_AUDIT_ACTIONS,
    ticketEvents: CHANNEL_ACCOUNTS_TICKET_EVENTS,
    queues: CHANNEL_ACCOUNTS_QUEUES,
  },
  {
    name: 'alerts',
    auditActions: ALERTS_AUDIT_ACTIONS,
    ticketEvents: ALERTS_TICKET_EVENTS,
    queues: ALERTS_QUEUES,
  },
  {
    name: 'incidents',
    auditActions: INCIDENTS_AUDIT_ACTIONS,
    ticketEvents: INCIDENTS_TICKET_EVENTS,
    queues: INCIDENTS_QUEUES,
  },
  {
    name: 'tools',
    auditActions: TOOLS_AUDIT_ACTIONS,
    ticketEvents: TOOLS_TICKET_EVENTS,
    queues: TOOLS_QUEUES,
  },
  {
    name: 'statuspage',
    auditActions: STATUSPAGE_AUDIT_ACTIONS,
    ticketEvents: STATUSPAGE_TICKET_EVENTS,
    queues: STATUSPAGE_QUEUES,
  },
  {
    name: 'usage',
    auditActions: USAGE_AUDIT_ACTIONS,
    ticketEvents: USAGE_TICKET_EVENTS,
    queues: USAGE_QUEUES,
  },
  {
    name: 'dashboard',
    auditActions: DASHBOARD_AUDIT_ACTIONS,
    ticketEvents: DASHBOARD_TICKET_EVENTS,
    queues: DASHBOARD_QUEUES,
  },
  {
    name: 'uploads',
    auditActions: UPLOADS_AUDIT_ACTIONS,
    ticketEvents: UPLOADS_TICKET_EVENTS,
    queues: UPLOADS_QUEUES,
  },
] as const;

export type FeatureName = (typeof FEATURES)[number]['name'];

/** Every feature's audit actions in one record. Composed into `AUDIT_ACTIONS`. */
export const FEATURE_AUDIT_ACTIONS = {
  ...INBOUND_AUDIT_ACTIONS,
  ...OUTBOUND_AUDIT_ACTIONS,
  ...GMAIL_AUDIT_ACTIONS,
  ...LINE_AUDIT_ACTIONS,
  ...DISCORD_AUDIT_ACTIONS,
  ...NOTIFICATIONS_AUDIT_ACTIONS,
  ...AI_AUDIT_ACTIONS,
  ...KB_AUDIT_ACTIONS,
  ...CSAT_AUDIT_ACTIONS,
  ...SHIFTS_AUDIT_ACTIONS,
  ...AUTONOMY_AUDIT_ACTIONS,
  ...CREDENTIALS_AUDIT_ACTIONS,
  ...VIEWS_AUDIT_ACTIONS,
  ...ADMIN_AUDIT_ACTIONS,
  ...CHANNEL_ACCOUNTS_AUDIT_ACTIONS,
  ...ALERTS_AUDIT_ACTIONS,
  ...INCIDENTS_AUDIT_ACTIONS,
  ...TOOLS_AUDIT_ACTIONS,
  ...STATUSPAGE_AUDIT_ACTIONS,
  ...USAGE_AUDIT_ACTIONS,
  ...DASHBOARD_AUDIT_ACTIONS,
  ...UPLOADS_AUDIT_ACTIONS,
} as const;

/** Every feature's ticket event types in one record. Composed into `TICKET_EVENT_TYPES`. */
export const FEATURE_TICKET_EVENTS = {
  ...INBOUND_TICKET_EVENTS,
  ...OUTBOUND_TICKET_EVENTS,
  ...GMAIL_TICKET_EVENTS,
  ...LINE_TICKET_EVENTS,
  ...DISCORD_TICKET_EVENTS,
  ...NOTIFICATIONS_TICKET_EVENTS,
  ...AI_TICKET_EVENTS,
  ...KB_TICKET_EVENTS,
  ...CSAT_TICKET_EVENTS,
  ...SHIFTS_TICKET_EVENTS,
  ...AUTONOMY_TICKET_EVENTS,
  ...CREDENTIALS_TICKET_EVENTS,
  ...VIEWS_TICKET_EVENTS,
  ...ADMIN_TICKET_EVENTS,
  ...CHANNEL_ACCOUNTS_TICKET_EVENTS,
  ...ALERTS_TICKET_EVENTS,
  ...INCIDENTS_TICKET_EVENTS,
  ...TOOLS_TICKET_EVENTS,
  ...STATUSPAGE_TICKET_EVENTS,
  ...USAGE_TICKET_EVENTS,
  ...DASHBOARD_TICKET_EVENTS,
  ...UPLOADS_TICKET_EVENTS,
} as const;

/** Every feature's queue names in one record. Composed into `QUEUE_NAMES`. */
export const FEATURE_QUEUES = {
  ...INBOUND_QUEUES,
  ...OUTBOUND_QUEUES,
  ...GMAIL_QUEUES,
  ...LINE_QUEUES,
  ...DISCORD_QUEUES,
  ...NOTIFICATIONS_QUEUES,
  ...AI_QUEUES,
  ...KB_QUEUES,
  ...CSAT_QUEUES,
  ...SHIFTS_QUEUES,
  ...AUTONOMY_QUEUES,
  ...CREDENTIALS_QUEUES,
  ...VIEWS_QUEUES,
  ...ADMIN_QUEUES,
  ...CHANNEL_ACCOUNTS_QUEUES,
  ...ALERTS_QUEUES,
  ...INCIDENTS_QUEUES,
  ...TOOLS_QUEUES,
  ...STATUSPAGE_QUEUES,
  ...USAGE_QUEUES,
  ...DASHBOARD_QUEUES,
  ...UPLOADS_QUEUES,
} as const;
