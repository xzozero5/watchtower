import type {
  AlertSeverity,
  EscalationTarget,
  IncidentSeverity,
  IncidentStatus,
  IncidentTimelineType,
} from '@watchtower/shared';

import { BOT_MAX_CONTENT, threadName, type BotMessage } from './bot.js';

/**
 * What Watchtower says in Discord, built from ids, enumerations, counts and catalog names only (N4).
 * Never an alert title or payload, a ticket subject, a message text, an organization's name or a
 * person's name: a service name comes from the catalog (an infrastructure name a lead chose) and is
 * made inert here; the rest is a link back to the app, where the access rules live.
 */

/** `alert:ack:<uuid>`, `incident:ack:<uuid>`, `incident:assign:<uuid>`: what a button sends back. */
export type ButtonAction =
  | { readonly kind: 'alert.ack'; readonly alertId: string }
  | { readonly kind: 'incident.ack'; readonly incidentId: string }
  | { readonly kind: 'incident.assign'; readonly incidentId: string };

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export const customIds = {
  alertAck: (alertId: string): string => `alert:ack:${alertId}`,
  incidentAck: (incidentId: string): string => `incident:ack:${incidentId}`,
  incidentAssign: (incidentId: string): string => `incident:assign:${incidentId}`,
} as const;

export function parseCustomId(customId: string): ButtonAction | null {
  const match = new RegExp(`^(alert:ack|incident:ack|incident:assign):(${UUID})$`).exec(customId);
  const kind = match?.[1];
  const id = match?.[2];
  if (kind === undefined || id === undefined) return null;
  if (kind === 'alert:ack') return { kind: 'alert.ack', alertId: id };
  if (kind === 'incident:ack') return { kind: 'incident.ack', incidentId: id };
  return { kind: 'incident.assign', incidentId: id };
}

/** Catalog text made safe to put in a message: no mentions, no markdown, no line breaks, bounded. */
export function inert(text: string, max = 60): string {
  return text
    .replace(/[\r\n]+/g, ' ')
    .replace(/[@#`*_~|>\\[\]()<]/g, '')
    .trim()
    .slice(0, max);
}

const SEVERITY_WORD: Readonly<Record<AlertSeverity, string>> = {
  critical: 'CRITICAL',
  error: 'ERROR',
  warning: 'WARNING',
  info: 'INFO',
  unknown: 'UNRATED',
};

export interface AlertChatFacts {
  readonly alertId: string;
  readonly level: number;
  readonly target: EscalationTarget;
  readonly severity: AlertSeverity;
  readonly serviceName: string | null;
  readonly count: number;
  readonly fallback: boolean;
  readonly mentionUserIds: readonly string[];
  readonly link: string;
}

const TARGET_WORD: Readonly<Record<EscalationTarget, string>> = {
  on_shift: 'on shift',
  lead: 'lead',
  head: 'head',
};

/** The page for one escalation step, with the Ack button (R-3.8, AC-3). */
export function buildAlertEscalationMessage(facts: AlertChatFacts): BotMessage {
  const service = facts.serviceName === null ? 'no service (unmapped)' : inert(facts.serviceName);
  const mentions = facts.mentionUserIds.map((id) => `<@${id}>`).join(' ');
  const lines = [
    `${mentions === '' ? '' : `${mentions} `}${SEVERITY_WORD[facts.severity]} alert needs an answer`,
    `Service: ${service} | fired ${String(facts.count)}x | step ${String(facts.level + 1)}: ${TARGET_WORD[facts.target]}${facts.fallback ? ' (nobody on shift)' : ''}`,
    facts.link,
  ];
  return {
    content: lines.join('\n').slice(0, BOT_MAX_CONTENT),
    buttons: [{ customId: customIds.alertAck(facts.alertId), label: 'Ack', style: 'primary' }],
    mentionUserIds: [...facts.mentionUserIds],
  };
}

/** The same message after somebody pressed Ack: no button, and who is by Discord id only. */
export function buildAlertAckedMessage(
  facts: AlertChatFacts,
  ackedByDiscordUserId: string | null,
): BotMessage {
  const service = facts.serviceName === null ? 'no service (unmapped)' : inert(facts.serviceName);
  const by = ackedByDiscordUserId === null ? 'on the web' : `by <@${ackedByDiscordUserId}>`;
  return {
    content: [
      `${SEVERITY_WORD[facts.severity]} alert acknowledged ${by}`,
      `Service: ${service} | fired ${String(facts.count)}x`,
      facts.link,
    ]
      .join('\n')
      .slice(0, BOT_MAX_CONTENT),
    buttons: [],
    mentionUserIds: [],
  };
}

export interface IncidentChatFacts {
  readonly incidentId: string;
  /** `INC-12`. */
  readonly key: string;
  readonly severity: IncidentSeverity;
  readonly status: IncidentStatus;
  readonly serviceSlugs: readonly string[];
  readonly link: string;
}

/** The opening message of an incident thread, with Ack and Assign-to-me buttons (R-3.13). */
export function buildIncidentOpeningMessage(facts: IncidentChatFacts): BotMessage {
  const services =
    facts.serviceSlugs.length === 0
      ? 'none yet'
      : facts.serviceSlugs.map((s) => inert(s, 40)).join(', ');
  return {
    content: [
      `${facts.key} ${facts.severity} | ${facts.status}`,
      `Services: ${services}`,
      facts.link,
    ]
      .join('\n')
      .slice(0, BOT_MAX_CONTENT),
    buttons: [
      { customId: customIds.incidentAck(facts.incidentId), label: 'Ack alerts', style: 'primary' },
      {
        customId: customIds.incidentAssign(facts.incidentId),
        label: 'Assign to me',
        style: 'secondary',
      },
    ],
    mentionUserIds: [],
  };
}

/** The thread's name: the key, the severity and the service slugs. Never the free-text title. */
export function incidentThreadName(
  facts: Pick<IncidentChatFacts, 'key' | 'severity' | 'serviceSlugs'>,
): string {
  const services = facts.serviceSlugs.map((slug) => inert(slug, 30)).join(' ');
  return threadName(`${facts.key} ${facts.severity}${services === '' ? '' : ` ${services}`}`);
}

/** One line for a key timeline entry: what kind of thing happened, from enumerations only. */
export function buildIncidentMirrorLine(
  type: IncidentTimelineType,
  payload: Readonly<Record<string, unknown>>,
  key: string,
): BotMessage {
  const text = (value: unknown): string => (typeof value === 'string' ? inert(value, 30) : '?');
  let line: string;
  switch (type) {
    case 'created':
      line = `${key} opened as ${text(payload.severity)}`;
      break;
    case 'status_changed':
      line = `${key} status: ${text(payload.from)} -> ${text(payload.to)}`;
      break;
    case 'severity_changed':
      line = `${key} severity: ${text(payload.from)} -> ${text(payload.to)}`;
      break;
    case 'commander_changed':
      line = `${key} has a new commander`;
      break;
    case 'comms_sent':
      line = `${key} an update was sent to affected customers`;
      break;
    default:
      line = `${key} ${type}`;
  }
  return { content: line, buttons: [], mentionUserIds: [] };
}
