import { randomUUID } from 'node:crypto';

import { schema } from '@watchtower/db';
import {
  AUDIT_ACTIONS,
  CHANNEL_TYPES,
  INBOUND_TICKET_EVENTS,
  stripCsatLinkTokens,
  type ChannelType,
  type InboundClassification,
} from '@watchtower/shared';
import { and, eq, ne } from 'drizzle-orm';

import { recordAuditInTx } from '../audit.js';
import { badRequest } from '../errors.js';
import { sealReplyToken } from '../outbound/reply-token.js';
import type { TicketRow } from '../rows.js';
import { applyStatus } from '../tickets/status.js';
import { createTicket } from '../tickets/create.js';
import {
  insertMessage,
  messageEvent,
  recordTicketEvent,
  ticketEvent,
  ticketKeysOf,
} from '../tickets/support.js';
import { Effects, type DbTransaction, type DomainContext, type DomainResult } from '../types.js';
import {
  UNIDENTIFIED_ORG_ID,
  ensureSenderContact,
  lookupSender,
  type SenderLookup,
} from './identity.js';
import { findTicketForMessage, isMatch, type TicketMatch } from './match.js';
import type {
  AutomatedVerdict,
  IngestInboundInput,
  IngestOutcome,
  NormalisedInboundMessage,
  ThreadMatchKind,
} from './types.js';

type InboundMessageRow = typeof schema.inboundMessage.$inferSelect;
type Disposition = IngestOutcome['disposition'];

/**
 * The classification when nothing smarter answered (no classifier configured, timeout, failure,
 * kill switch): header rules only (PRD section 5.1 step 3, ADR-009 step 4). A message the rules
 * cannot place is `triage`, which a person looks at; the rules never guess an intent.
 */
export function ruleClassification(automated: AutomatedVerdict): InboundClassification {
  return {
    type: automated.disposition === 'human' ? 'triage' : 'noise',
    intentKey: null,
    confidence: null,
    source: 'rules',
    aiRunId: null,
  };
}

/** Matches by these keys are made by the conversation itself, so they beat a "noise" label. */
const EXACT_KINDS: readonly ThreadMatchKind[] = [
  'gmail_thread_id',
  'in_reply_to',
  'references',
  'subject_token',
];

const NO_SUBJECT = '(no subject)';
const SUBJECT_FROM_BODY_MAX = 80;

/**
 * The ticket subject: the mail's own subject, or for a channel without one (a chat) the first line
 * of the text, cut to 80 characters (code points, so Thai is not split inside a character).
 */
export function ticketSubject(
  message: Pick<NormalisedInboundMessage, 'subject' | 'bodyText'>,
): string {
  const subject = message.subject.trim();
  if (subject !== '') return subject;
  const firstLine =
    message.bodyText
      .split(/\r?\n/)
      .find((line) => line.trim() !== '')
      ?.trim() ?? '';
  if (firstLine === '') return NO_SUBJECT;
  const characters = Array.from(firstLine);
  return characters.length <= SUBJECT_FROM_BODY_MAX
    ? firstLine
    : `${characters.slice(0, SUBJECT_FROM_BODY_MAX - 1).join('')}…`;
}

function isChannelType(value: string): value is ChannelType {
  return (CHANNEL_TYPES as readonly string[]).includes(value);
}

async function channelTypeOf(tx: DbTransaction, accountId: string): Promise<ChannelType> {
  const [account] = await tx
    .select({ type: schema.channelAccount.type })
    .from(schema.channelAccount)
    .where(eq(schema.channelAccount.id, accountId))
    .limit(1);
  if (!account) throw badRequest('channelAccountId does not refer to a channel account');
  if (!isChannelType(account.type)) throw badRequest('This channel account has an unknown type');
  return account.type;
}

/** An intent key from the classifier counts only when an active intent has it. */
async function knownIntentKey(tx: DbTransaction, key: string | null): Promise<string | undefined> {
  if (key === null) return undefined;
  const [row] = await tx
    .select({ key: schema.intent.key, isActive: schema.intent.isActive })
    .from(schema.intent)
    .where(eq(schema.intent.key, key))
    .limit(1);
  return row?.isActive === true ? row.key : undefined;
}

async function outcomeFromRow(
  tx: DbTransaction,
  ctx: DomainContext,
  row: InboundMessageRow,
  channel: ChannelType,
  extra: Partial<IngestOutcome>,
): Promise<IngestOutcome> {
  let ticketKey: string | null = null;
  if (row.ticketId !== null) {
    const [ticket] = await tx
      .select({ number: schema.ticket.number })
      .from(schema.ticket)
      .where(eq(schema.ticket.id, row.ticketId))
      .limit(1);
    ticketKey = ticket ? ticketKeysOf(ctx).format(ticket.number) : null;
  }
  return {
    inboundMessageId: row.id,
    disposition: row.disposition as Disposition,
    ticketId: row.ticketId,
    ticketKey,
    messageId: row.messageId,
    matchedBy: null,
    alreadyIngested: false,
    duplicateOf: null,
    reopened: false,
    channel,
    ...extra,
  };
}

interface Decision {
  readonly disposition: Disposition;
  readonly ticketId: string | null;
  readonly messageId: string | null;
  readonly matchedBy: ThreadMatchKind | null;
  readonly reopened: boolean;
  readonly reason: string;
}

/**
 * Takes one received message to its end (ADR-009 section 2 step 5, PRD sections 5.1 and 5.2): saves
 * it as an `inbound_message`, finds out whether it is noise, an automatic reply or a person, and
 * either opens a ticket, joins the one it belongs to, or leaves it in "Other mail". One audit row
 * says what became of it. Nothing is sent to anyone (no auto-ack here: that goes through the policy
 * gate in its own task).
 *
 * Idempotent: the `inbound_message` row is keyed by (channel account, provider message id) and
 * locked `FOR UPDATE`, so a redelivered notification or a retried job finds the decision already
 * made and writes nothing. The same mail under a second provider id (one `Message-ID`, R-2.2)
 * follows the first and writes no second ticket or message.
 *
 * Rules, in order:
 *  1. header rules say automatic reply (bounce, out of office, `Precedence: bulk`) -> `auto_reply`.
 *     Never a ticket, never reopens anything (R-2.6). The classifier cannot overrule it.
 *  2. classified as internal or machine -> `internal` (visible in Other mail; no alert pipeline yet).
 *  3. the thread key, a reply header or a subject token finds a ticket of the sender's organization
 *     -> `appended`, reopening it if the customer answers a waiting or recently resolved ticket
 *     (R-1.10). A resolved ticket past the window, or a closed one, does not take the message: a new
 *     ticket opens and remembers which one it follows.
 *  4. noise (header rules or classifier), or an inactive organization -> `noise`: no ticket, no
 *     contact is created.
 *  5. same contact, open ticket, same subject in the last 14 days `[ASSUMED]` -> `appended`.
 *  6. otherwise a new ticket; an unknown sender becomes an unverified contact (R-2.11).
 */
export async function ingestInbound(
  tx: DbTransaction,
  ctx: DomainContext,
  input: IngestInboundInput,
): Promise<DomainResult<IngestOutcome>> {
  const fx = new Effects();
  // A customer may quote our survey link back; it is a bearer token, so it is not stored (T-171 review C-8).
  const message: NormalisedInboundMessage = {
    ...input.message,
    subject: stripCsatLinkTokens(input.message.subject),
    bodyText: stripCsatLinkTokens(input.message.bodyText),
    bodyHtml: input.message.bodyHtml === null ? null : stripCsatLinkTokens(input.message.bodyHtml),
  };

  // 1. Record the message (once) and lock its row for the rest of the transaction.
  // The id is chosen here so the reply token can be sealed bound to the row it will live in.
  const inboundMessageId = randomUUID();
  await tx
    .insert(schema.inboundMessage)
    .values({
      id: inboundMessageId,
      replyTokenSealed:
        message.replyToken === undefined || message.replyToken === null || message.replyToken === ''
          ? null
          : sealReplyToken(ctx, inboundMessageId, message.replyToken),
      channelAccountId: message.channelAccountId,
      inboundEventId: input.inboundEventId ?? null,
      providerMessageId: message.providerMessageId,
      rfc822MessageId: message.rfc822MessageId,
      threadKey: message.threadKey,
      threadCandidates: [...message.threadCandidates],
      fromAddress: message.from.address,
      fromName: message.from.name,
      lineUserId: message.from.lineUserId,
      subject: message.subject,
      bodyText: message.bodyText,
      bodyHtml: message.bodyHtml,
      emailMeta: message.emailMeta ?? null,
      attachments: [...message.attachments],
      receivedAt: message.receivedAt,
      rawObjectKey: message.rawObjectKey,
      automated: { ...message.automated, signals: [...message.automated.signals] },
    })
    .onConflictDoNothing({
      target: [schema.inboundMessage.channelAccountId, schema.inboundMessage.providerMessageId],
    });
  const [row] = await tx
    .select()
    .from(schema.inboundMessage)
    .where(
      and(
        eq(schema.inboundMessage.channelAccountId, message.channelAccountId),
        eq(schema.inboundMessage.providerMessageId, message.providerMessageId),
      ),
    )
    .for('update');
  if (!row) throw new Error('inbound_message row is missing after insert');
  const channel = await channelTypeOf(tx, message.channelAccountId);
  if (row.disposition !== 'pending') {
    return fx.result(await outcomeFromRow(tx, ctx, row, channel, { alreadyIngested: true }));
  }

  const classification = input.classification ?? ruleClassification(message.automated);

  // 2. The same mail under another provider id (R-2.2): follow the first, write nothing new.
  const duplicate = await findOriginal(tx, row);
  if (duplicate) {
    const decision: Decision = {
      disposition: duplicate.disposition as Disposition,
      ticketId: duplicate.ticketId,
      messageId: duplicate.messageId,
      matchedBy: null,
      reopened: false,
      reason: 'duplicate_message_id',
    };
    const done = await finish(tx, ctx, fx, row, input, classification, decision, duplicate.id);
    return fx.result(await outcomeFromRow(tx, ctx, done, channel, { duplicateOf: duplicate.id }));
  }

  // 3. Decide.
  const decision = await decide(tx, ctx, fx, message, classification, channel);
  const done = await finish(tx, ctx, fx, row, input, classification, decision, null);
  return fx.result(
    await outcomeFromRow(tx, ctx, done, channel, {
      matchedBy: decision.matchedBy,
      reopened: decision.reopened,
    }),
  );
}

/** An earlier, finished `inbound_message` of the same account with the same RFC Message-ID. */
async function findOriginal(
  tx: DbTransaction,
  row: InboundMessageRow,
): Promise<InboundMessageRow | undefined> {
  if (row.rfc822MessageId === null) return undefined;
  const [original] = await tx
    .select()
    .from(schema.inboundMessage)
    .where(
      and(
        eq(schema.inboundMessage.channelAccountId, row.channelAccountId),
        eq(schema.inboundMessage.rfc822MessageId, row.rfc822MessageId),
        ne(schema.inboundMessage.id, row.id),
        ne(schema.inboundMessage.disposition, 'pending'),
      ),
    )
    .orderBy(schema.inboundMessage.createdAt)
    .limit(1);
  return original;
}

async function decide(
  tx: DbTransaction,
  ctx: DomainContext,
  fx: Effects,
  message: NormalisedInboundMessage,
  classification: InboundClassification,
  channel: ChannelType,
): Promise<Decision> {
  const nowhere = (disposition: Disposition, reason: string): Decision => ({
    disposition,
    ticketId: null,
    messageId: null,
    matchedBy: null,
    reopened: false,
    reason,
  });

  // Automatic replies are never conversation, whatever the classifier thinks (R-2.6).
  if (message.automated.disposition === 'auto_reply') {
    return nowhere('auto_reply', message.automated.subtype);
  }
  if (classification.type === 'internal_or_machine') return nowhere('internal', 'classifier');

  const sender = await lookupSender(tx, message.from);
  const noise = message.automated.disposition === 'noise' || classification.type === 'noise';
  const found = await findTicketForMessage(tx, ctx, message, sender);

  if (isMatch(found)) {
    if (!noise || EXACT_KINDS.includes(found.matchedBy)) {
      return append(tx, ctx, fx, message, sender, found);
    }
    return nowhere('noise', message.automated.subtype);
  }
  if (noise) {
    return nowhere(
      'noise',
      message.automated.disposition === 'noise' ? message.automated.subtype : 'classifier',
    );
  }

  // A customer whose organization is switched off cannot get a ticket (createTicket refuses):
  // keep the message where a person sees it instead of failing the job forever.
  if (sender.orgId !== null && !(await orgIsActive(tx, sender.orgId))) {
    return nowhere('noise', 'org_inactive');
  }

  const { contact } = await ensureSenderContact(tx, ctx, fx, message.from, sender);
  const intentKey = await knownIntentKey(tx, classification.intentKey);
  const created = await createTicket(tx, ctx, {
    orgId: contact.orgId,
    subject: ticketSubject(message),
    body: message.bodyText,
    ...(message.bodyHtml === null ? {} : { bodyHtml: message.bodyHtml }),
    ...(message.emailMeta == null ? {} : { emailMeta: message.emailMeta }),
    attachments: message.attachments.map((attachment) => ({ ...attachment })),
    channel,
    channelAccountId: message.channelAccountId,
    externalId: message.providerMessageId,
    ...(message.threadKey === null ? {} : { threadKey: message.threadKey }),
    requesterContactId: contact.id,
    ...(intentKey === undefined ? {} : { intentKey }),
  });
  fx.events.push(...created.events);
  if (created.audited) fx.audited = true;
  if (found.followsUp) {
    await recordTicketEvent(
      tx,
      created.value.ticket.id,
      INBOUND_TICKET_EVENTS.followsUp,
      ctx.actor,
      'internal',
      { previousTicketId: found.followsUp.id, previousStatus: found.followsUp.status },
    );
  }
  return {
    disposition: 'ticket',
    ticketId: created.value.ticket.id,
    messageId: created.value.message.id,
    matchedBy: null,
    reopened: false,
    reason: sender.contact === null ? 'new_contact' : 'known_contact',
  };
}

async function orgIsActive(tx: DbTransaction, orgId: string): Promise<boolean> {
  if (orgId === UNIDENTIFIED_ORG_ID) return true;
  const [org] = await tx
    .select({ status: schema.organization.status })
    .from(schema.organization)
    .where(eq(schema.organization.id, orgId))
    .limit(1);
  return org?.status === 'active';
}

/** Saves the message on the ticket it belongs to and, if the customer answered, restarts the clock. */
async function append(
  tx: DbTransaction,
  ctx: DomainContext,
  fx: Effects,
  message: NormalisedInboundMessage,
  sender: SenderLookup,
  match: TicketMatch,
): Promise<Decision> {
  const [locked] = await tx
    .select()
    .from(schema.ticket)
    .where(eq(schema.ticket.id, match.ticket.id))
    .for('update');
  if (!locked) throw new Error('matched ticket disappeared');
  let ticket: TicketRow = locked;
  const { contact } = await ensureSenderContact(tx, ctx, fx, message.from, sender);

  const now = ctx.now();
  const { message: saved, touched } = await insertMessage(
    tx,
    {
      ticketId: ticket.id,
      channelAccountId: message.channelAccountId,
      direction: 'inbound',
      externalId: message.providerMessageId,
      threadKey: message.threadKey,
      senderContactId: contact.id,
      bodyText: message.bodyText,
      bodyHtml: message.bodyHtml,
      emailMeta: message.emailMeta ?? null,
      attachments: message.attachments.map((attachment) => ({ ...attachment })),
      visibility: 'public',
      deliveryStatus: 'not_applicable',
    },
    { updatedAt: now },
  );
  if (touched) ticket = touched;
  fx.emit(messageEvent(ctx, ticket, saved));

  let reopened = false;
  if (ticket.status === 'waiting_on_customer' || ticket.status === 'resolved') {
    reopened = ticket.status === 'resolved';
    ticket = await applyStatus(tx, ctx, fx, ticket, 'open', {
      reason: 'customer_reply',
      automatic: true,
    });
  } else {
    fx.emit(ticketEvent(ctx, 'ticket.updated', ticket, []));
  }
  return {
    disposition: 'appended',
    ticketId: ticket.id,
    messageId: saved.id,
    matchedBy: match.matchedBy,
    reopened,
    reason: match.matchedBy,
  };
}

/** Writes the outcome on the `inbound_message` row and the one audit row. */
async function finish(
  tx: DbTransaction,
  ctx: DomainContext,
  fx: Effects,
  row: InboundMessageRow,
  input: IngestInboundInput,
  classification: InboundClassification,
  decision: Decision,
  duplicateOf: string | null,
): Promise<InboundMessageRow> {
  const now = ctx.now();
  const [done] = await tx
    .update(schema.inboundMessage)
    .set({
      disposition: decision.disposition,
      ticketId: decision.ticketId,
      messageId: decision.messageId,
      classification: duplicateOf === null ? classification : { ...classification, duplicateOf },
      rawObjectKey: input.message.rawObjectKey ?? row.rawObjectKey,
      inboundEventId: input.inboundEventId ?? row.inboundEventId,
      dispositionBy: 'system',
      dispositionAt: now,
    })
    .where(eq(schema.inboundMessage.id, row.id))
    .returning();
  if (!done) throw new Error('inbound_message update returned no row');

  // Ids and labels only: the sender's address and the text stay in inbound_message / message.
  await recordAuditInTx(tx, ctx, fx, {
    action: AUDIT_ACTIONS.inboundIngest,
    targetType: 'inbound_message',
    targetId: row.id,
    metadata: {
      disposition: decision.disposition,
      reason: decision.reason,
      channelAccountId: row.channelAccountId,
      ticketId: decision.ticketId,
      messageId: decision.messageId,
      matchedBy: decision.matchedBy,
      reopened: decision.reopened,
      classifier: { type: classification.type, source: classification.source },
      automated: input.message.automated.subtype,
      ...(duplicateOf === null ? {} : { duplicateOf }),
    },
  });
  return done;
}
