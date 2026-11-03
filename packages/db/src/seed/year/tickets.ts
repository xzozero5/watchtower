import { createHash } from 'node:crypto';

import {
  AUDIT_ACTIONS,
  REOPEN_WINDOW_DAYS,
  TICKET_EVENT_TYPES,
  addSlaMinutes,
  computeSlaDueDates,
  type SlaPause,
  type TicketPriority,
} from '@watchtower/shared';

import {
  GENERIC,
  INTENT_CONTENT,
  TABLE_HEADERS,
  failingRows,
  fillText,
  makeVars,
  type IntentContent,
} from './content.js';
import { renderMail, type MailParts, type MailPerson, type MailStyle } from './email.js';
import { makeScreenshotPng } from './png.js';
import type { Rng } from './prng.js';
import { DAY, HOUR, MINUTE, addDays, bangkokTime, localParts } from './prng.js';
import type { Duty } from './roster.js';
import type { IntentRef, Reference, Row, StoredAttachmentFile } from './types.js';
import type { Lang, World, WorldContact, WorldOrg, WorldStaff } from './world.js';

/**
 * Plays one year of tickets the way the product would have produced them: arrival with seasonality,
 * assignment to whoever is on shift, SLA clocks computed with the shared calendar code, multi-turn
 * conversations in Thai and English, internal notes, dev hand-offs, reopenings and merges. Pure and
 * deterministic: no database, no clock (`now` is a parameter).
 */

export interface IncidentWindow {
  readonly id: string;
  readonly index: number;
  readonly startsAt: Date;
  /** Null while the incident is still open. */
  readonly resolvedAt: Date | null;
  readonly severity: 'SEV1' | 'SEV2' | 'SEV3' | 'SEV4';
  readonly intentKeys: readonly string[];
  readonly orgIndexes: readonly number[];
  readonly ticketCount: number;
}

export type TicketChannel = 'gmail' | 'line' | 'portal' | 'phone' | 'chat';

export interface SimReply {
  readonly messageId: string;
  readonly at: Date;
  readonly by: WorldStaff;
  readonly text: string;
}

/** What other planners (AI, CSAT, shifts, notifications) need to know about a finished ticket. */
export interface SimTicket {
  readonly id: string;
  readonly number: number;
  readonly org: WorldOrg;
  readonly contact: WorldContact;
  readonly intent: IntentRef;
  readonly priority: TicketPriority;
  readonly channel: TicketChannel;
  readonly lang: Lang;
  readonly subject: string;
  readonly createdAt: Date;
  readonly status: string;
  readonly assignee: WorldStaff | null;
  readonly devOwner: WorldStaff | null;
  readonly queue: string;
  readonly firstRespondedAt: Date | null;
  readonly firstResponseDueAt: Date | null;
  readonly resolutionDueAt: Date | null;
  readonly resolvedAt: Date | null;
  readonly closedAt: Date | null;
  readonly reopenCount: number;
  readonly incidentId: string | null;
  readonly lastCustomerMessage: { readonly id: string; readonly at: Date; readonly text: string };
  readonly replies: readonly SimReply[];
  readonly firstBreached: boolean;
  readonly resolutionBreached: boolean;
  readonly updatedAt: Date;
}

export interface TicketBundle {
  readonly sim: SimTicket;
  readonly ticket: Row;
  readonly messages: Row[];
  readonly events: Row[];
  readonly audits: Row[];
}

export interface TicketPlanInput {
  readonly rng: Rng;
  readonly world: World;
  readonly reference: Reference;
  readonly duty: Duty;
  readonly now: Date;
  readonly start: Date;
  readonly target: number;
  readonly incidents: readonly IncidentWindow[];
  readonly attachments: boolean;
  readonly firstNumber: number;
}

export interface TicketPlanOutput {
  readonly bundles: TicketBundle[];
  readonly files: StoredAttachmentFile[];
}

const SUPPORT_MAILBOX: MailPerson = {
  name: 'Tech Ops Support',
  address: 'support@helpdesk.example.com',
};
const QUEUE_OF_INTENT: Record<string, 'Support' | 'Integrations' | 'Billing'> = {
  api_error: 'Integrations',
  webhook_not_received: 'Integrations',
  processing_failure: 'Integrations',
  upstream_timeout: 'Integrations',
  workspace_config: 'Integrations',
  billing_report: 'Billing',
  result_dispute: 'Billing',
};
const INTENT_WEIGHTS: readonly (readonly [string, number])[] = [
  ['api_error', 16],
  ['webhook_not_received', 11],
  ['processing_failure', 12],
  ['upstream_timeout', 5],
  ['account_access', 14],
  ['billing_report', 9],
  ['feature_question', 10],
  ['workspace_config', 9],
  ['result_dispute', 6],
  ['incident_inquiry', 3],
  ['other', 5],
];
const HOUR_WEIGHTS = [
  0.12, 0.1, 0.08, 0.08, 0.1, 0.15, 0.3, 0.6, 1.4, 3.2, 4.2, 3.9, 2.3, 3.4, 3.7, 3.3, 2.7, 1.8, 1.0,
  0.7, 0.6, 0.4, 0.22, 0.15,
];
const KIND_WEIGHTS: Record<'tech' | 'light' | 'dispute', readonly (readonly [Kind, number])[]> = {
  tech: [
    ['quick', 10],
    ['standard', 35],
    ['dev', 35],
    ['long', 20],
  ],
  light: [
    ['quick', 45],
    ['standard', 40],
    ['dev', 3],
    ['long', 12],
  ],
  dispute: [
    ['quick', 10],
    ['standard', 40],
    ['dev', 20],
    ['long', 30],
  ],
};
type Kind = 'quick' | 'standard' | 'dev' | 'long';
const TECH_INTENTS = new Set([
  'api_error',
  'webhook_not_received',
  'processing_failure',
  'upstream_timeout',
]);

/** Extra Thai holidays before the example calendar starts (2026-01-01); [ASSUMED] dates. */
export const EXTRA_HOLIDAYS = ['2025-12-05', '2025-12-10', '2025-12-31'] as const;

export function isOffDay(dateKey: string, weekday: number, holidays: ReadonlySet<string>): boolean {
  return weekday === 0 || weekday === 6 || holidays.has(dateKey);
}

export function dayWeights(
  start: Date,
  now: Date,
  holidays: ReadonlySet<string>,
): { dateKey: string; weight: number }[] {
  const out: { dateKey: string; weight: number }[] = [];
  const first = localParts(start).dateKey;
  const last = localParts(now).dateKey;
  let key = first;
  let index = 0;
  while (key <= last) {
    const parts = localParts(bangkokTime(key, 12));
    let weight = 1;
    if (parts.weekday === 6) weight = 0.2;
    else if (parts.weekday === 0) weight = 0.12;
    else if (holidays.has(key)) weight = 0.14;
    else {
      // Mondays carry the weekend backlog; Fridays are a little quieter.
      if (parts.weekday === 1) weight = 1.25;
      if (parts.weekday === 5) weight = 0.9;
      // Month-end close and the first days of a month.
      const daysInMonth = new Date(Date.UTC(parts.year, parts.month, 0)).getUTCDate();
      if (parts.day >= daysInMonth - 2 || parts.day <= 2) weight *= 1.45;
    }
    weight *= 1 + 0.5 * (index / 365); // customers and usage grow through the year
    out.push({ dateKey: key, weight });
    key = addDays(key, 1);
    index += 1;
  }
  return out;
}

function clampPriority(value: number): TicketPriority {
  return (['P1', 'P2', 'P3', 'P4'] as const)[Math.max(0, Math.min(3, value))] ?? 'P3';
}

function priorityIndex(priority: string): number {
  return Math.max(0, ['P1', 'P2', 'P3', 'P4'].indexOf(priority));
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
}

function localClock(at: Date): string {
  const p = localParts(at);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

interface Planned {
  readonly at: Date;
  readonly org: WorldOrg;
  readonly contact: WorldContact;
  readonly intent: IntentRef;
  readonly priority: TicketPriority;
  readonly channel: TicketChannel;
  readonly incident: IncidentWindow | null;
}

export function planTickets(input: TicketPlanInput): TicketPlanOutput {
  const { rng, world, reference, now } = input;
  const intentByKey = new Map(reference.intents.map((i) => [i.key, i]));
  const days = dayWeights(input.start, now, reference.holidays);
  const burstTotal = input.incidents.reduce((sum, i) => sum + i.ticketCount, 0);
  const totalWeight = days.reduce((sum, d) => sum + d.weight, 0);
  const baseline = Math.max(0, input.target - burstTotal);

  const arrivals: Planned[] = [];
  const pickIntentKey = (parts: ReturnType<typeof localParts>): string => {
    const daysInMonth = new Date(Date.UTC(parts.year, parts.month, 0)).getUTCDate();
    const monthEnd = parts.day >= daysInMonth - 2 || parts.day <= 3;
    return rng.weighted(
      INTENT_WEIGHTS.map(
        ([key, weight]) =>
          [key, key === 'billing_report' && monthEnd ? weight * 3.5 : weight] as const,
      ),
    );
  };
  const makeArrival = (
    at: Date,
    intentKey: string,
    org: WorldOrg,
    incident: IncidentWindow | null,
  ): Planned | null => {
    const intent = intentByKey.get(intentKey) ?? intentByKey.get('other');
    if (!intent) return null;
    const contact = rng.pick(org.contacts);
    const canLine = contact.lineUserId !== null;
    const channel = rng.weighted<TicketChannel>([
      ['gmail', 55],
      ['line', canLine ? 30 : 0],
      ['portal', 22],
      ['phone', 4],
      ['chat', 3],
    ]);
    let p = priorityIndex(intent.defaultPriority);
    if (incident) p = Math.min(p, incident.severity === 'SEV1' ? 0 : 1);
    else {
      const roll = rng.next();
      if (roll < (org.tier === 'gold' ? 0.16 : 0.09)) p -= 1;
      else if (roll > 0.88) p += 1;
      if (rng.chance(0.006)) p = 0;
    }
    return { at, org, contact, intent, priority: clampPriority(p), channel, incident };
  };
  const pickOrg = (at: Date): WorldOrg | null => {
    const pool = world.orgs.filter((o) => o.createdAt.getTime() <= at.getTime());
    if (pool.length === 0) return null;
    return rng.weighted(pool.map((o) => [o, o.weight] as const));
  };
  const hourPick = rng.fork('hours');
  for (const day of days) {
    const mean = (baseline * day.weight) / totalWeight;
    const count = rng.count(mean);
    const parts = localParts(bangkokTime(day.dateKey, 12));
    for (let i = 0; i < count; i += 1) {
      const hour = hourPick.weighted(HOUR_WEIGHTS.map((w, h) => [h, w] as const));
      const at = bangkokTime(day.dateKey, hour, hourPick.int(0, 59));
      at.setTime(at.getTime() + hourPick.int(0, 59) * 1000);
      if (at.getTime() > now.getTime() - 2 * MINUTE) continue;
      const org = pickOrg(at);
      if (!org) continue;
      const arrival = makeArrival(at, pickIntentKey(parts), org, null);
      if (arrival) arrivals.push(arrival);
    }
  }
  for (const incident of input.incidents) {
    const end = incident.resolvedAt ?? now;
    const span = Math.max(end.getTime() - incident.startsAt.getTime(), 30 * MINUTE);
    for (let i = 0; i < incident.ticketCount; i += 1) {
      // Reports arrive front-loaded: most within the first third of the incident.
      const frac = Math.min(1, -Math.log(1 - rng.next() * 0.95) / 3);
      const at = new Date(incident.startsAt.getTime() + 4 * MINUTE + frac * span);
      if (at.getTime() > now.getTime() - 2 * MINUTE) continue;
      const orgIndex = rng.pick(incident.orgIndexes);
      const org = world.orgs[orgIndex];
      if (!org || org.createdAt.getTime() > at.getTime()) continue;
      const arrival = makeArrival(at, rng.pick(incident.intentKeys), org, incident);
      if (arrival) arrivals.push(arrival);
    }
  }
  arrivals.sort((a, b) => a.at.getTime() - b.at.getTime());

  const files = new Map<number, StoredAttachmentFile>();
  const env: Env = {
    ...input,
    intentByKey,
    files,
    roundRobin: new Map(),
    recent: new Map(),
    done: [],
  };
  const bundles: TicketBundle[] = [];
  arrivals.forEach((arrival, index) => {
    bundles.push(
      simulateTicket(env, arrival, input.firstNumber + index, rng.fork(`t${String(index)}`)),
    );
  });
  return { bundles, files: [...files.values()] };
}

interface Env extends TicketPlanInput {
  readonly intentByKey: ReadonlyMap<string, IntentRef>;
  readonly files: Map<number, StoredAttachmentFile>;
  readonly roundRobin: Map<string, number>;
  /** Last live ticket per organization and intent, for duplicate detection. */
  readonly recent: Map<string, DuplicateCandidate>;
  readonly done: TicketBundle[];
}

interface DuplicateCandidate {
  readonly bundle: TicketBundle;
  readonly at: Date;
}

const SCREENSHOT_VARIANTS = 8;

function attachmentRecord(
  env: Env,
  variant: number,
  inline: boolean,
  index: number,
  at: Date,
  rng: Rng,
): { record: Row; contentId: string | null } {
  let file = env.files.get(variant);
  if (!file) {
    const bytes = makeScreenshotPng(variant);
    file = {
      objectKey: `attachments/seed/year/screenshot-${String(variant + 1)}.png`,
      filename: 'screenshot.png',
      contentType: 'image/png',
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    env.files.set(variant, file);
  }
  const p = localParts(at);
  const stamp = `${String(p.year)}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} at ${String(p.hour).padStart(2, '0')}.${String(p.minute).padStart(2, '0')}.${String(rng.int(0, 59)).padStart(2, '0')}`;
  const contentId = inline ? `ii_${rng.hex(10)}` : null;
  return {
    contentId,
    record: {
      partId: `part-${String(index + 1)}`,
      filename: inline ? 'image.png' : `Screenshot ${stamp}.png`,
      contentType: file.contentType,
      size: file.bytes.length,
      sha256: file.sha256,
      objectKey: file.objectKey,
      disposition: inline ? 'inline' : 'attachment',
      contentId,
      referencedByHtml: inline,
    },
  };
}

function simulateTicket(env: Env, spec: Planned, number: number, rng: Rng): TicketBundle {
  const { reference, now, duty, world } = env;
  const { org, contact, intent, priority, channel } = spec;
  const policy = reference.policies[org.tier];
  const target = policy.targets[priority];
  const urgent = priority === 'P1' || priority === 'P2';
  const lang = contact.lang;
  const content: IntentContent =
    INTENT_CONTENT[intent.key] ?? (INTENT_CONTENT.other as IntentContent);
  const queueName = QUEUE_OF_INTENT[intent.key] ?? 'Support';
  const t0 = spec.at;
  const id = rng.uuid();
  const incident = spec.incident;

  const biz = (from: Date, minutes: number): Date =>
    target
      ? addSlaMinutes(from, Math.max(1, Math.round(minutes)), target.calendar, policy.calendar)
      : new Date(from.getTime() + minutes * MINUTE);
  const covered = (at: Date): Date => duty.coveredFrom(at, urgent, rng);
  const customerTime = (at: Date): Date => {
    let t = at;
    for (let guard = 0; guard < 200; guard += 1) {
      const p = localParts(t);
      const off = isOffDay(p.dateKey, p.weekday, reference.holidays);
      const inHours = p.hour >= 9 && p.hour < 18;
      const evening = p.hour >= 18 && p.hour < 22 && rng.chance(0.12);
      if ((!off && inHours) || evening) return t;
      t = new Date(t.getTime() + 30 * MINUTE);
      if (guard % 8 === 7) t = new Date(t.getTime() + rng.int(0, 30) * MINUTE);
    }
    return t;
  };

  // --- content ---
  const vars = makeVars({
    lang,
    rng,
    whenLabel: localClock(new Date(t0.getTime() - rng.int(20, 180) * MINUTE)),
    monthIndex: (localParts(t0).month + 10) % 12,
    userEmail: contact.email,
  });
  const opening = rng.pick(content.openings[lang]);
  const subject = fillText(opening.subject, vars);
  const openingBody = fillText(opening.body, vars);

  // --- state ---
  const messages: Row[] = [];
  const events: Row[] = [];
  const audits: Row[] = [];
  const replies: SimReply[] = [];
  const pauses: SlaPause[] = [];
  const st = {
    status: 'new',
    assignee: null as WorldStaff | null,
    devOwner: null as WorldStaff | null,
    firstRespondedAt: null as Date | null,
    resolvedAt: null as Date | null,
    closedAt: null as Date | null,
    reopenCount: 0,
    pausedAt: null as Date | null,
    parentId: null as string | null,
    updatedAt: t0,
  };
  let messageCount = 0;
  let lastCustomer = { id: '', at: t0, text: openingBody };
  let lastAgent: { at: Date; text: string; by: WorldStaff } | null = null;
  const threadKey = `thread-${rng.hex(16)}`;
  const accountId =
    channel === 'gmail'
      ? reference.channelAccounts.gmail
      : channel === 'line'
        ? reference.channelAccounts.line
        : channel === 'portal'
          ? reference.channelAccounts.portal
          : null;

  const dues = (): ReturnType<typeof computeSlaDueDates> =>
    computeSlaDueDates({
      startedAt: t0,
      priority,
      targets: policy.targets,
      calendar: policy.calendar,
      pauses,
    });

  const actorRow = (actor: WorldStaff | 'system' | 'customer') =>
    actor === 'system'
      ? ({ type: 'system', id: null } as const)
      : actor === 'customer'
        ? ({ type: 'user', id: org.clientUser.id } as const)
        : ({ type: 'user', id: actor.id } as const);
  const event = (
    at: Date,
    type: string,
    actor: WorldStaff | 'system' | 'customer',
    visibility: 'public' | 'internal',
    payload: Row,
  ): void => {
    const a = actorRow(actor);
    events.push({
      id: rng.uuid(),
      created_at: at,
      ticket_id: id,
      type,
      actor_type: a.type,
      actor_id: a.id,
      visibility,
      payload,
    });
    st.updatedAt = at;
  };
  const audit = (
    at: Date,
    action: string,
    actor: WorldStaff | 'system' | 'customer',
    metadata: Row = {},
    before: Row | null = null,
    after: Row | null = null,
  ): void => {
    const a = actorRow(actor);
    audits.push({
      id: rng.uuid(),
      created_at: at,
      actor_type: a.type,
      actor_id: a.id,
      action,
      outcome: 'success',
      target_type: 'ticket',
      target_id: id,
      before,
      after,
      ip: null,
      request_id: null,
      metadata: { seed: 'year', ...metadata },
    });
  };

  const attachmentsAllowed = env.attachments && TECH_INTENTS.has(intent.key);
  const signatureOf = (person: WorldStaff): string[] => [
    person.name,
    person.title,
    'Watchtower Tech Ops',
    'support@helpdesk.example.com',
  ];
  const customerSignature = [contact.name, `${contact.roleInOrg}, ${org.name}`];

  // A customer message (first one or a follow-up).
  const customerMessage = (
    at: Date,
    text: string,
    opts: { first?: boolean; table?: boolean; withShot?: boolean } = {},
  ): void => {
    messageCount += 1;
    const messageId = rng.uuid();
    let bodyText = text;
    let bodyHtml: string | null = null;
    let emailMeta: Row | null = null;
    const attachments: Row[] = [];
    let inlineImage: MailParts['inlineImage'];
    if (opts.withShot && attachmentsAllowed) {
      const inline = channel === 'gmail' && rng.chance(0.5);
      const made = attachmentRecord(env, rng.int(0, SCREENSHOT_VARIANTS - 1), inline, 0, at, rng);
      attachments.push(made.record);
      if (inline && made.contentId)
        inlineImage = {
          contentId: made.contentId,
          alt: lang === 'th' ? 'ภาพหน้าจอ error' : 'error screenshot',
        };
    }
    if (channel === 'gmail') {
      const style: MailStyle = rng.chance(0.6) ? 'gmail' : 'outlook';
      const table = opts.table
        ? { headers: TABLE_HEADERS[lang], rows: failingRows(rng, vars, localParts(at).hour) }
        : undefined;
      const quote =
        !opts.first && lastAgent
          ? {
              author: { name: lastAgent.by.name, address: SUPPORT_MAILBOX.address },
              at: lastAgent.at,
              text: lastAgent.text,
            }
          : undefined;
      const paragraphs = splitParagraphs(text);
      const rendered = renderMail({
        style,
        lang,
        paragraphs,
        signature: customerSignature,
        ...(table ? { table } : {}),
        ...(inlineImage ? { inlineImage } : {}),
        ...(quote ? { quote } : {}),
      });
      bodyText = rendered.text;
      bodyHtml = rendered.html;
      emailMeta = {
        from: { address: contact.email, name: contact.name },
        to: [{ address: SUPPORT_MAILBOX.address, name: SUPPORT_MAILBOX.name }],
        cc:
          rng.chance(0.12) && org.contacts.length > 1
            ? [
                {
                  address: (org.contacts.find((c) => c.id !== contact.id) ?? contact).email,
                  name: (org.contacts.find((c) => c.id !== contact.id) ?? contact).name,
                },
              ]
            : [],
        bcc: [],
        subject: opts.first ? subject : `Re: ${subject}`,
      };
    } else if (opts.table) {
      const rows = failingRows(rng, vars, localParts(at).hour);
      bodyText = `${text}\n\n${TABLE_HEADERS[lang].join(' | ')}\n${rows.map((r) => r.join(' | ')).join('\n')}`;
    } else if (channel === 'line') {
      bodyText = splitParagraphs(text).slice(0, 2).join('\n');
    }
    messages.push({
      id: messageId,
      ticket_id: id,
      channel_account_id: accountId,
      direction: 'inbound',
      external_id: accountId
        ? channel === 'gmail'
          ? `<y${String(number)}.${String(messageCount)}@mail.example.com>`
          : `seed-y-${String(number)}-${String(messageCount)}`
        : null,
      thread_key: channel === 'gmail' ? threadKey : null,
      sender_contact_id: contact.id,
      sender_user_id: null,
      body_text: bodyText,
      body_html: bodyHtml,
      body_redacted: null,
      attachments,
      visibility: 'public',
      delivery_status: 'not_applicable',
      created_at: at,
      email_meta: emailMeta,
    });
    lastCustomer = { id: messageId, at, text };
    st.updatedAt = at;
    if (!opts.first)
      audit(at, AUDIT_ACTIONS.ticketReply, 'customer', {
        direction: 'inbound',
        firstResponse: false,
      });
  };

  const agentMessage = (at: Date, by: WorldStaff, text: string, links = false): string => {
    messageCount += 1;
    const messageId = rng.uuid();
    const greeting = GENERIC[lang].greeting(contact.name);
    const body = links
      ? `${text}\n\nhttps://support.example.com/kb/${intent.key.replaceAll('_', '-')}`
      : text;
    let bodyText = `${greeting}\n\n${body}\n\n${GENERIC[lang].regards}\n${by.name}`;
    let bodyHtml: string | null = null;
    let emailMeta: Row | null = null;
    if (channel === 'gmail') {
      const rendered = renderMail({
        style: 'composer',
        lang,
        greeting,
        paragraphs: splitParagraphs(body),
        regards: GENERIC[lang].regards,
        signature: signatureOf(by),
        quote: {
          author: { name: contact.name, address: contact.email },
          at: lastCustomer.at,
          text: lastCustomer.text,
        },
      });
      bodyText = rendered.text;
      bodyHtml = rendered.html;
      emailMeta = {
        from: { address: SUPPORT_MAILBOX.address, name: by.name },
        to: [{ address: contact.email, name: contact.name }],
        cc: [],
        bcc: [],
        subject: `Re: ${subject}`,
      };
    } else if (channel === 'line') {
      bodyText = `${greeting}\n${splitParagraphs(body).slice(0, 2).join('\n')}`;
    }
    const first = st.firstRespondedAt === null;
    if (first) st.firstRespondedAt = at;
    messages.push({
      id: messageId,
      ticket_id: id,
      channel_account_id: accountId,
      direction: 'outbound',
      external_id: accountId
        ? channel === 'gmail'
          ? `<y${String(number)}.${String(messageCount)}@mail.example.com>`
          : `seed-y-${String(number)}-${String(messageCount)}`
        : null,
      thread_key: channel === 'gmail' ? threadKey : null,
      sender_contact_id: null,
      sender_user_id: by.id,
      body_text: bodyText,
      body_html: bodyHtml,
      body_redacted: null,
      attachments: [],
      visibility: 'public',
      delivery_status: 'delivered',
      created_at: at,
      email_meta: emailMeta,
    });
    replies.push({ messageId, at, by, text: body });
    lastAgent = { at, text: body, by };
    audit(at, AUDIT_ACTIONS.ticketReply, by, { direction: 'outbound', firstResponse: first });
    st.updatedAt = at;
    return messageId;
  };

  const internalNote = (at: Date, by: WorldStaff, text: string): void => {
    messageCount += 1;
    messages.push({
      id: rng.uuid(),
      ticket_id: id,
      channel_account_id: null,
      direction: 'internal',
      external_id: null,
      thread_key: null,
      sender_contact_id: null,
      sender_user_id: by.id,
      body_text: text,
      body_html: null,
      body_redacted: null,
      attachments: [],
      visibility: 'internal',
      delivery_status: 'not_applicable',
      created_at: at,
      email_meta: null,
    });
    audit(at, AUDIT_ACTIONS.ticketNote, by);
    st.updatedAt = at;
  };

  const snapshot = (): Row => ({
    id,
    orgId: org.id,
    status: st.status,
    priority,
    intentId: intent.id,
    assigneeId: st.assignee?.id ?? null,
    queueId: reference.queues[queueName],
  });

  const setStatus = (
    at: Date,
    to: string,
    actor: WorldStaff | 'system' | 'customer',
    reason?: string,
  ): void => {
    const from = st.status;
    if (from === to) return;
    const before = snapshot();
    if (st.pausedAt !== null && to !== 'waiting_on_customer') {
      pauses.push({ pausedAt: st.pausedAt, resumedAt: at });
      const d = dues();
      event(at, TICKET_EVENT_TYPES.slaResumed, actor, 'internal', {
        pausedAt: st.pausedAt.toISOString(),
        resumedAt: at.toISOString(),
        firstResponseDueAt: d.firstResponseDueAt?.toISOString() ?? null,
        resolutionDueAt: d.resolutionDueAt?.toISOString() ?? null,
      });
      st.pausedAt = null;
    } else if (st.pausedAt === null && to === 'waiting_on_customer') {
      st.pausedAt = at;
      event(at, TICKET_EVENT_TYPES.slaPaused, actor, 'internal', { reason: to });
    }
    let reopened = false;
    if (to === 'resolved') {
      st.resolvedAt = at;
      st.closedAt = null;
    } else if (to === 'closed') {
      st.closedAt = at;
      st.resolvedAt = st.resolvedAt ?? at;
    } else if (from === 'resolved' || from === 'closed') {
      st.resolvedAt = null;
      st.closedAt = null;
      st.reopenCount += 1;
      reopened = true;
    }
    st.status = to;
    event(at, TICKET_EVENT_TYPES.statusChanged, actor, 'public', {
      from,
      to,
      ...(reason ? { reason } : {}),
      ...(reopened ? { reopened: true } : {}),
    });
    if (reopened)
      event(at, TICKET_EVENT_TYPES.reopened, actor, 'internal', {
        from,
        to,
        reopenCount: st.reopenCount,
        ...(reason ? { reason } : {}),
      });
    audit(
      at,
      AUDIT_ACTIONS.ticketStatusChange,
      actor,
      { from, to, ...(reason === 'auto_close' ? { automatic: true } : {}) },
      before,
      snapshot(),
    );
  };

  // --- creation ---
  const kindOfTicket: Kind = rng.weighted(
    KIND_WEIGHTS[
      TECH_INTENTS.has(intent.key) ? 'tech' : intent.key === 'result_dispute' ? 'dispute' : 'light'
    ],
  );
  customerMessage(t0, openingBody, {
    first: true,
    table: TECH_INTENTS.has(intent.key) && rng.chance(0.3),
    withShot: rng.chance(0.2),
  });
  event(t0, TICKET_EVENT_TYPES.created, 'customer', 'public', {
    channel,
    priority,
    intentKey: intent.key,
  });
  audit(t0, AUDIT_ACTIONS.ticketCreate, 'customer', { channel }, null, snapshot());

  const members = (): WorldStaff[] =>
    world.staff.filter(
      (s) => s.queues.includes(queueName) && s.createdAt.getTime() <= t0.getTime(),
    );
  const pickResponder = (at: Date): WorldStaff => {
    const now_ = duty.active(at);
    const onDuty = [...now_.desk, ...now_.oncall].filter(
      (p) => p.role === 'agent' || p.role === 'lead',
    );
    const preferred = onDuty.filter((p) => members().some((m) => m.id === p.id));
    const pool = preferred.length > 0 ? preferred : onDuty.length > 0 ? onDuty : members();
    const counter = env.roundRobin.get(queueName) ?? 0;
    env.roundRobin.set(queueName, counter + 1);
    return pool[counter % pool.length] as WorldStaff;
  };
  const developer = (at: Date): WorldStaff => {
    const devs = world.staff.filter(
      (s) => s.role === 'dev' && s.createdAt.getTime() <= at.getTime(),
    );
    return rng.pick(devs);
  };

  const script = (): void => {
    // Work that the team has not got to yet: recent tickets sometimes stand still at some point, so
    // the queue of today shows new, open and waiting work in every state.
    const age = now.getTime() - t0.getTime();
    const stands =
      age < 14 * DAY && rng.chance(priority === 'P1' ? 0 : priority === 'P2' ? 0.1 : 0.3);
    const cutoff = stands ? t0.getTime() + (0.04 + rng.next() * 0.9) * age : now.getTime();
    const live = (t: Date): boolean => t.getTime() <= cutoff;
    // assignment
    const tAssign = covered(new Date(t0.getTime() + rng.int(1, 6) * MINUTE));
    if (!live(tAssign)) return;
    st.assignee = pickResponder(tAssign);
    event(tAssign, TICKET_EVENT_TYPES.assigned, 'system', 'internal', {
      from: null,
      to: st.assignee.id,
      strategy: 'round_robin',
      queueId: reference.queues[queueName],
    });
    audit(
      tAssign,
      AUDIT_ACTIONS.ticketAssign,
      'system',
      { strategy: 'round_robin' },
      { assigneeId: null, queueId: reference.queues[queueName] },
      { assigneeId: st.assignee.id, queueId: reference.queues[queueName] },
    );
    if (!target) return;

    const f1 = Math.min(6, Math.max(0.03, rng.logNormal(0.28, 0.85)));
    const f2 = Math.min(3, Math.max(0.02, rng.logNormal(0.42, 0.8)));
    const effort = target.resolution_min * f2;
    let tR = covered(biz(t0, Math.max(2, target.first_response_min * f1)));
    if (tR.getTime() < tAssign.getTime() + 2 * MINUTE)
      tR = new Date(tAssign.getTime() + 2 * MINUTE);
    if (!live(tR)) {
      if (rng.chance(0.4) && live(new Date(tAssign.getTime() + 20 * MINUTE)))
        setStatus(new Date(tAssign.getTime() + 20 * MINUTE), 'triage', st.assignee);
      return;
    }

    const responder = (at: Date): WorldStaff => {
      const dutyNow = duty.active(at);
      const onDuty = [...dutyNow.desk, ...dutyNow.oncall].filter(
        (p) => p.role === 'agent' || p.role === 'lead',
      );
      if (st.assignee && onDuty.some((p) => p.id === st.assignee?.id)) return st.assignee;
      const next = onDuty.length > 0 ? rng.pick(onDuty) : (st.assignee as WorldStaff);
      if (next.id !== st.assignee?.id) {
        event(at, TICKET_EVENT_TYPES.assigned, next, 'internal', {
          from: st.assignee?.id ?? null,
          to: next.id,
          strategy: 'manual',
          queueId: reference.queues[queueName],
        });
        audit(
          at,
          AUDIT_ACTIONS.ticketAssign,
          next,
          { strategy: 'manual' },
          { assigneeId: st.assignee?.id ?? null },
          { assigneeId: next.id },
        );
        st.assignee = next;
      }
      return next;
    };
    const work = (from: Date, share: number): Date =>
      covered(biz(from, Math.max(3, effort * share)));
    const generic = GENERIC[lang];
    const resolutionText = fillText(rng.pick(content.resolutions[lang]), vars);
    const askText = fillText(rng.pick(content.asks[lang]), vars);
    const noteText = rng.pick(content.notes);
    const resolve = (at: Date, text: string): boolean => {
      if (!live(at)) return false;
      const by = responder(at);
      agentMessage(at, by, `${text}\n\n${rng.pick(generic.agentClose)}`, true);
      setStatus(new Date(at.getTime() + 20_000), 'resolved', by);
      return true;
    };
    const afterResolution = (tRes: Date): void => {
      const tResolved = tRes;
      // Thanks from the customer.
      if (rng.chance(0.45)) {
        const tThanks = customerTime(new Date(tResolved.getTime() + rng.logNormal(3, 0.9) * HOUR));
        if (live(tThanks))
          customerMessage(tThanks, fillText(rng.pick(generic.customerThanks), vars));
      }
      // Reopened within the window.
      let resolvedAt = tResolved;
      if (rng.chance(0.06)) {
        const tBack = customerTime(new Date(tResolved.getTime() + rng.logNormal(30, 0.8) * HOUR));
        if (tBack.getTime() - tResolved.getTime() < REOPEN_WINDOW_DAYS * DAY && live(tBack)) {
          customerMessage(tBack, fillText(rng.pick(generic.customerReopen), vars));
          setStatus(new Date(tBack.getTime() + 5_000), 'open', 'customer', 'customer_reply');
          const tAck = covered(new Date(tBack.getTime() + rng.logNormal(45, 0.7) * MINUTE));
          if (live(tAck)) {
            const by = responder(tAck);
            const tFix = work(tAck, 0.15);
            internalNote(
              new Date(tAck.getTime() + 5 * MINUTE),
              by,
              'Customer reports it again; re-checking the earlier fix and the logs since then.',
            );
            if (live(tFix)) {
              const by2 = responder(tFix);
              agentMessage(tFix, by2, fillText(rng.pick(content.resolutions[lang]), vars), true);
              resolvedAt = new Date(tFix.getTime() + 20_000);
              setStatus(resolvedAt, 'resolved', by2);
            }
          }
        }
      }
      if (st.status === 'resolved') {
        const tClose = new Date(
          resolvedAt.getTime() + REOPEN_WINDOW_DAYS * DAY + rng.int(0, 300) * MINUTE,
        );
        if (live(tClose)) setStatus(tClose, 'closed', 'system', 'auto_close');
      }
    };

    // Duplicate of a recent ticket of the same organization (merged away).
    const dupKey = `${org.id}|${intent.key}`;
    const candidate = env.recent.get(dupKey);
    if (
      candidate &&
      t0.getTime() - candidate.at.getTime() < 6 * HOUR &&
      (candidate.bundle.sim.resolvedAt === null ||
        candidate.bundle.sim.resolvedAt.getTime() > tR.getTime() + 30 * MINUTE) &&
      rng.chance(0.4) &&
      candidate.bundle.sim.status !== 'merged' &&
      live(tR)
    ) {
      const by = responder(tR);
      const target_ = candidate.bundle;
      st.status = 'open';
      event(tR, TICKET_EVENT_TYPES.statusChanged, by, 'public', { from: 'new', to: 'open' });
      const tMerge = new Date(tR.getTime() + rng.int(3, 20) * MINUTE);
      if (!live(tMerge)) return;
      internalNote(
        new Date(tMerge.getTime() - 60_000),
        by,
        `Same report as ${reference.ticketKeyPrefix}-${String(target_.sim.number)} from the same organization. Merging.`,
      );
      st.status = 'merged';
      st.parentId = target_.sim.id;
      event(tMerge, TICKET_EVENT_TYPES.merged, by, 'public', {
        intoTicketId: target_.sim.id,
        intoKey: `${reference.ticketKeyPrefix}-${String(target_.sim.number)}`,
        reason: 'duplicate',
      });
      target_.events.push({
        id: rng.uuid(),
        created_at: tMerge,
        ticket_id: target_.sim.id,
        type: TICKET_EVENT_TYPES.mergeReceived,
        actor_type: 'user',
        actor_id: by.id,
        visibility: 'internal',
        payload: {
          fromTicketId: id,
          fromKey: `${reference.ticketKeyPrefix}-${String(number)}`,
          movedChildren: 0,
        },
      });
      audit(tMerge, AUDIT_ACTIONS.ticketMerge, by, {
        intoTicketId: target_.sim.id,
        movedChildren: 0,
      });
      st.firstRespondedAt = tR;
      return;
    }

    // First reply of every path.
    const by1 = responder(tR);
    st.status = 'new';
    const openFirst = (): void => {
      setStatus(tR, 'open', by1);
    };

    if (incident) {
      openFirst();
      const holding =
        lang === 'th'
          ? 'ขณะนี้เรากำลังตรวจสอบเหตุขัดข้องที่ส่งผลต่อบริการดังกล่าว ทีมวิศวกรกำลังแก้ไข จะแจ้งความคืบหน้าให้ทราบเป็นระยะค่ะ'
          : 'We are aware of an issue affecting this service and our engineers are working on it. We will keep you updated here as we make progress.';
      agentMessage(new Date(tR.getTime() + 30_000), by1, holding);
      audit(tR, AUDIT_ACTIONS.ticketReferenceAdd, by1, {
        kind: 'incident',
        incidentId: incident.id,
      });
      event(new Date(tR.getTime() + 60_000), TICKET_EVENT_TYPES.referenceAdded, by1, 'internal', {
        kind: 'incident',
        incidentId: incident.id,
      });
      internalNote(new Date(tR.getTime() + 2 * MINUTE), by1, content.notes[0] ?? noteText);
      const end = incident.resolvedAt;
      if (end) {
        const tRes = covered(
          new Date(
            Math.max(end.getTime() + rng.logNormal(50, 0.7) * MINUTE, tR.getTime() + 10 * MINUTE),
          ),
        );
        if (resolve(tRes, resolutionText)) afterResolution(tRes);
      }
      return;
    }

    if (kindOfTicket === 'quick') {
      openFirst();
      const tRes = new Date(tR.getTime() + rng.int(1, 4) * MINUTE);
      if (resolve(tRes, resolutionText)) afterResolution(tRes);
      return;
    }

    // Ack and ask path (standard and long) or ack and investigate (dev).
    const ackText = rng.pick(generic.agentAck);
    if (kindOfTicket === 'dev') {
      openFirst();
      agentMessage(new Date(tR.getTime() + 30_000), by1, ackText);
      const tNote = new Date(tR.getTime() + rng.int(6, 25) * MINUTE);
      if (!live(tNote)) return;
      internalNote(tNote, by1, noteText);
      const tDev = work(tNote, 0.12);
      if (!live(tDev)) return;
      const dev = developer(tDev);
      st.devOwner = dev;
      event(tDev, TICKET_EVENT_TYPES.devPickedUp, dev, 'internal', { devOwnerId: dev.id });
      audit(tDev, AUDIT_ACTIONS.ticketDevPickup, dev, {});
      setStatus(new Date(tDev.getTime() + 1000), 'waiting_on_dev', by1);
      // A few stay with development for a long time.
      if (now.getTime() - t0.getTime() < 40 * DAY && rng.chance(0.05)) {
        const tUpd = new Date(tDev.getTime() + rng.int(1, 3) * DAY);
        if (live(tUpd))
          internalNote(
            covered(tUpd),
            dev,
            'Needs a change in the scheduler; planned for the next release. Customer informed of the workaround.',
          );
        return;
      }
      const tDevNote = work(tDev, 0.4);
      if (!live(tDevNote)) return;
      internalNote(
        tDevNote,
        dev,
        rng.pick([
          'Root cause found and a fix is ready in a branch; deploying after review.',
          'Reproduced locally. The fix is a one-line guard plus a regression test; will ship in the next deploy.',
          'Not a defect: configuration on the tenant. Reverted the setting and verified.',
        ]),
      );
      const tUpdate = new Date(tDevNote.getTime() + rng.int(10, 40) * MINUTE);
      if (live(tUpdate))
        agentMessage(covered(tUpdate), responder(covered(tUpdate)), rng.pick(generic.agentUpdate));
      const tBack = work(tDevNote, 0.12);
      if (!live(tBack)) return;
      event(tBack, TICKET_EVENT_TYPES.devReleased, dev, 'internal', { devOwnerId: dev.id });
      audit(tBack, AUDIT_ACTIONS.ticketDevRelease, dev, {});
      st.devOwner = null;
      setStatus(new Date(tBack.getTime() + 1000), 'open', by1);
      const tRes = work(tBack, 0.2);
      if (resolve(tRes, resolutionText)) afterResolution(tRes);
      return;
    }

    // standard / long: ask the customer something first
    openFirst();
    agentMessage(
      new Date(tR.getTime() + 30_000),
      by1,
      `${rng.pick(generic.agentAsk)}\n\n${askText}`,
    );
    const tAsk = new Date(tR.getTime() + 60_000);
    if (!live(tAsk)) return;
    setStatus(tAsk, 'waiting_on_customer', by1);
    const stalled = rng.chance(age < 14 * DAY ? 0.14 : 0.045);
    const tC1 = customerTime(new Date(tAsk.getTime() + rng.logNormal(7, 1.1) * HOUR));
    if (stalled) {
      const tNudge = customerTime(new Date(tAsk.getTime() + 3 * DAY));
      if (live(tNudge)) {
        agentMessage(
          covered(tNudge),
          responder(covered(tNudge)),
          lang === 'th'
            ? 'ขอติดตามเรื่องนี้ค่ะ หากยังต้องการความช่วยเหลือ รบกวนส่งข้อมูลที่ขอไว้ มิฉะนั้นเราจะปิดเรื่องภายในสัปดาห์นี้'
            : 'Following up on this ticket. If you still need help, please send the details above, otherwise we will close it later this week.',
        );
      }
      const tClose = new Date(tAsk.getTime() + 7 * DAY + rng.int(0, 400) * MINUTE);
      if (live(tClose)) setStatus(tClose, 'closed', 'system', 'no_customer_response');
      return;
    }
    if (!live(tC1)) return;
    const shot1 = attachmentsAllowed && rng.chance(0.55);
    customerMessage(
      tC1,
      fillText(rng.pick(shot1 ? generic.customerInfoShot : generic.customerInfo), vars),
      { withShot: shot1 },
    );
    setStatus(new Date(tC1.getTime() + 5000), 'open', 'customer', 'customer_reply');
    const tNote = new Date(tC1.getTime() + rng.logNormal(35, 0.8) * MINUTE);
    const tNoteCovered = covered(tNote);
    if (!live(tNoteCovered)) return;
    internalNote(tNoteCovered, responder(tNoteCovered), noteText);

    if (kindOfTicket === 'long') {
      const tUpd = work(tNoteCovered, 0.2);
      if (!live(tUpd)) return;
      agentMessage(tUpd, responder(tUpd), rng.pick(generic.agentUpdate));
      const tNudge = customerTime(new Date(tUpd.getTime() + rng.logNormal(20, 0.6) * HOUR));
      if (!live(tNudge)) return;
      customerMessage(tNudge, fillText(rng.pick(generic.customerNudge), vars));
      const tAsk2 = covered(new Date(tNudge.getTime() + rng.logNormal(40, 0.7) * MINUTE));
      if (!live(tAsk2)) return;
      const by = responder(tAsk2);
      agentMessage(
        tAsk2,
        by,
        `${rng.pick(generic.agentAsk)}\n\n${fillText(rng.pick(content.asks[lang]), vars)}`,
      );
      setStatus(new Date(tAsk2.getTime() + 20_000), 'waiting_on_customer', by);
      const tC2 = customerTime(new Date(tAsk2.getTime() + rng.logNormal(5, 0.9) * HOUR));
      if (!live(tC2)) return;
      const shot2 = attachmentsAllowed && rng.chance(0.4);
      customerMessage(
        tC2,
        fillText(rng.pick(shot2 ? generic.customerInfoShot : generic.customerInfo), vars),
        { withShot: shot2, table: TECH_INTENTS.has(intent.key) && rng.chance(0.4) },
      );
      setStatus(new Date(tC2.getTime() + 5000), 'open', 'customer', 'customer_reply');
      const tNote2 = covered(new Date(tC2.getTime() + rng.logNormal(30, 0.7) * MINUTE));
      if (live(tNote2)) internalNote(tNote2, responder(tNote2), rng.pick(content.notes));
      const tRes = work(tNote2, 0.3);
      if (resolve(tRes, resolutionText)) afterResolution(tRes);
      return;
    }
    const tRes = work(tNoteCovered, 0.5);
    if (resolve(tRes, resolutionText)) afterResolution(tRes);
  };
  script();

  // --- the rows ---
  const finalDues = dues();
  const firstDue = finalDues.firstResponseDueAt;
  const resDue = finalDues.resolutionDueAt;
  const firstBreached =
    firstDue !== null &&
    (st.firstRespondedAt
      ? st.firstRespondedAt.getTime() > firstDue.getTime()
      : now.getTime() > firstDue.getTime() && st.status !== 'merged');
  const resolutionBreached =
    resDue !== null &&
    (st.resolvedAt
      ? st.resolvedAt.getTime() > resDue.getTime()
      : now.getTime() > resDue.getTime() &&
        !['merged', 'closed'].includes(st.status) &&
        st.pausedAt === null);

  const tags: string[] = [];
  if (incident) tags.push('incident');
  if (org.tier === 'gold' && urgent) tags.push('vip');
  if (TECH_INTENTS.has(intent.key)) tags.push('integration');

  const ticket: Row = {
    id,
    number,
    subject,
    org_id: org.id,
    requester_contact_id: contact.id,
    channel_account_id: accountId,
    channel,
    intent_id: intent.id,
    priority,
    status: st.status,
    assignee_id: st.assignee?.id ?? null,
    dev_owner_id: st.devOwner?.id ?? null,
    queue_id: reference.queues[queueName],
    sla_policy_id: policy.id,
    first_response_due_at: firstDue,
    resolution_due_at: resDue,
    sla_paused_at: st.pausedAt,
    first_responded_at: st.firstRespondedAt,
    resolved_at: st.resolvedAt,
    closed_at: st.closedAt,
    incident_id: incident?.id ?? null,
    parent_ticket_id: st.parentId,
    tags,
    custom_fields: {},
    autonomy_stage_at_creation: intent.autonomyStage,
    ai_handled: false,
    reopen_count: st.reopenCount,
    csat_score: null,
    created_at: t0,
    updated_at: st.updatedAt,
  };
  const sim: SimTicket = {
    id,
    number,
    org,
    contact,
    intent,
    priority,
    channel,
    lang,
    subject,
    createdAt: t0,
    status: st.status,
    assignee: st.assignee,
    devOwner: st.devOwner,
    queue: queueName,
    firstRespondedAt: st.firstRespondedAt,
    firstResponseDueAt: firstDue,
    resolutionDueAt: resDue,
    resolvedAt: st.resolvedAt,
    closedAt: st.closedAt,
    reopenCount: st.reopenCount,
    incidentId: incident?.id ?? null,
    lastCustomerMessage: lastCustomer,
    replies,
    firstBreached,
    resolutionBreached,
    updatedAt: st.updatedAt,
  };
  const bundle: TicketBundle = { sim, ticket, messages, events, audits };
  if (st.status !== 'merged') env.recent.set(`${org.id}|${intent.key}`, { bundle, at: t0 });
  return bundle;
}
