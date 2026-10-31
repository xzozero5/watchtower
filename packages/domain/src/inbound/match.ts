import { schema } from '@watchtower/db';
import { OPEN_STATUSES, type TicketStatus } from '@watchtower/shared';
import { and, desc, eq, gte, inArray, isNotNull } from 'drizzle-orm';

import type { TicketRow } from '../rows.js';
import { TicketKeys } from '../ticket-keys.js';
import type { DbTransaction, DomainContext } from '../types.js';
import type { SenderLookup } from './identity.js';
import type { NormalisedInboundMessage, ThreadCandidate, ThreadMatchKind } from './types.js';

/**
 * Which ticket does a received message belong to (PRD R-2.3)?
 *
 * Exact keys first, in the order the adapter lists them: the provider's thread id, `In-Reply-To`,
 * `References` (newest first), then a `[OPS-1234]` token in the subject. If none of them finds a
 * ticket, a heuristic `[ASSUMED]` looks for the same contact's open ticket with the same subject.
 *
 * A key only counts when the sender belongs to the ticket's organization. Headers and subject
 * tokens are written by the sender, so without this check anybody could write into another
 * customer's ticket by quoting its key. A reply from an address nobody knows, in a conversation
 * that belongs to a customer, therefore opens its own ticket (a person can merge them).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** A ticket still counts as "the same conversation" for the heuristic this long after its last update. */
export const HEURISTIC_WINDOW_DAYS = 14;
/** Hops followed from a merged ticket to the ticket it was merged into. */
const MAX_MERGE_HOPS = 5;
const HEURISTIC_CANDIDATES = 20;

export interface TicketMatch {
  readonly ticket: TicketRow;
  readonly matchedBy: ThreadMatchKind;
}

export interface NoMatch {
  /** A ticket the message pointed at but could not join (closed, or resolved too long ago). */
  readonly followsUp: TicketRow | null;
}

const PREFIXES = ['re', 'fw', 'fwd', 'aw', 'sv', 'ตอบกลับ', 'ตอบ', 'ส่งต่อ'];
const PREFIX_PATTERN = new RegExp(`^\\s*(?:${PREFIXES.join('|')})\\s*[:：]\\s*`, 'iu');

/**
 * A subject reduced to what identifies the conversation: no `Re:` / `Fwd:` / `ตอบกลับ:` prefixes
 * (any number, any mix), no `[OPS-12]` tokens, one space between words, Unicode-normalised and
 * case-folded.
 */
export function normalizeSubject(subject: string): string {
  let value = subject.normalize('NFKC');
  value = value.replace(/\[[A-Za-z][A-Za-z0-9]{0,15}-\d{1,9}\]/g, ' ');
  for (;;) {
    const stripped = value.replace(PREFIX_PATTERN, '');
    if (stripped === value) break;
    value = stripped;
  }
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

async function ticketById(tx: DbTransaction, id: string): Promise<TicketRow | undefined> {
  return (await tx.select().from(schema.ticket).where(eq(schema.ticket.id, id)).limit(1))[0];
}

/** The ticket a candidate key points at, before any checks on the ticket or the sender. */
async function ticketForCandidate(
  tx: DbTransaction,
  ctx: DomainContext,
  accountId: string,
  candidate: ThreadCandidate,
): Promise<TicketRow | undefined> {
  switch (candidate.kind) {
    case 'gmail_thread_id':
      return byThreadKey(tx, accountId, `gmail:${candidate.value}`);
    case 'line_conversation':
      return byThreadKey(tx, accountId, `line:${candidate.value}`);
    case 'in_reply_to':
    case 'references': {
      const [viaInbound] = await tx
        .select({ ticketId: schema.inboundMessage.ticketId })
        .from(schema.inboundMessage)
        .where(
          and(
            eq(schema.inboundMessage.channelAccountId, accountId),
            eq(schema.inboundMessage.rfc822MessageId, candidate.value),
            isNotNull(schema.inboundMessage.ticketId),
          ),
        )
        .limit(1);
      if (viaInbound?.ticketId) return ticketById(tx, viaInbound.ticketId);
      return byThreadKey(tx, accountId, `msgid:${candidate.value}`);
    }
    case 'subject_token': {
      const number = new TicketKeys(ctx.config.ticketKeyPrefix).parse(candidate.value);
      if (number === null) return undefined;
      return (
        await tx.select().from(schema.ticket).where(eq(schema.ticket.number, number)).limit(1)
      )[0];
    }
  }
}

async function byThreadKey(
  tx: DbTransaction,
  accountId: string,
  threadKey: string,
): Promise<TicketRow | undefined> {
  const [row] = await tx
    .select({ ticketId: schema.message.ticketId })
    .from(schema.message)
    .where(
      and(eq(schema.message.channelAccountId, accountId), eq(schema.message.threadKey, threadKey)),
    )
    .orderBy(desc(schema.message.createdAt))
    .limit(1);
  return row ? ticketById(tx, row.ticketId) : undefined;
}

/** A merged ticket stands for the ticket it was merged into. */
async function followMerge(tx: DbTransaction, ticket: TicketRow): Promise<TicketRow | undefined> {
  let current: TicketRow | undefined = ticket;
  for (let hop = 0; hop < MAX_MERGE_HOPS && current?.status === 'merged'; hop += 1) {
    current =
      current.parentTicketId === null ? undefined : await ticketById(tx, current.parentTicketId);
  }
  return current?.status === 'merged' ? undefined : current;
}

type Joinability = 'join' | 'closed' | 'too_old';

/** Can this message join the ticket, given its state? `resolved` reopens only inside the window (R-1.10). */
export function joinability(
  ticket: TicketRow,
  kind: ThreadMatchKind,
  now: Date,
  reopenWindowDays: number,
): Joinability {
  const open = (OPEN_STATUSES as readonly string[]).includes(ticket.status);
  if (open) return 'join';
  // A chat has no thread: a message after the ticket was resolved is more likely a new question.
  if (kind === 'line_conversation') return ticket.status === 'closed' ? 'closed' : 'too_old';
  if (ticket.status === 'closed') return 'closed';
  if (ticket.status === 'resolved') {
    const resolvedAt = ticket.resolvedAt;
    if (resolvedAt !== null && now.getTime() - resolvedAt.getTime() <= reopenWindowDays * DAY_MS) {
      return 'join';
    }
    return 'too_old';
  }
  return 'closed';
}

export async function findTicketForMessage(
  tx: DbTransaction,
  ctx: DomainContext,
  message: NormalisedInboundMessage,
  sender: SenderLookup,
): Promise<TicketMatch | NoMatch> {
  const now = ctx.now();
  let followsUp: TicketRow | null = null;
  const belongsToSender = (ticket: TicketRow): boolean =>
    sender.orgId !== null && ticket.orgId === sender.orgId;

  for (const candidate of message.threadCandidates) {
    const found = await ticketForCandidate(tx, ctx, message.channelAccountId, candidate);
    const ticket = found ? await followMerge(tx, found) : undefined;
    if (!ticket || !belongsToSender(ticket)) continue;
    const verdict = joinability(ticket, candidate.kind, now, ctx.config.reopenWindowDays);
    if (verdict === 'join') return { ticket, matchedBy: candidate.kind };
    followsUp ??= ticket;
  }

  const heuristic = await heuristicMatch(tx, ctx, message, sender);
  if (heuristic) return heuristic;
  return { followsUp };
}

/**
 * The same contact's open ticket with the same (normalised) subject in the last two weeks,
 * from the same channel account `[ASSUMED]`. Only contacts we already know: for a stranger there
 * is nothing to compare. Messages without a subject (chats) never match here; a chat has its own
 * conversation key.
 */
async function heuristicMatch(
  tx: DbTransaction,
  ctx: DomainContext,
  message: NormalisedInboundMessage,
  sender: SenderLookup,
): Promise<TicketMatch | null> {
  const wanted = normalizeSubject(message.subject);
  if (sender.contact === null || wanted === '') return null;
  const since = new Date(ctx.now().getTime() - HEURISTIC_WINDOW_DAYS * DAY_MS);
  const rows = await tx
    .select()
    .from(schema.ticket)
    .where(
      and(
        eq(schema.ticket.requesterContactId, sender.contact.id),
        eq(schema.ticket.channelAccountId, message.channelAccountId),
        inArray(schema.ticket.status, [...OPEN_STATUSES] as TicketStatus[]),
        gte(schema.ticket.updatedAt, since),
      ),
    )
    .orderBy(desc(schema.ticket.updatedAt))
    .limit(HEURISTIC_CANDIDATES);
  const ticket = rows.find((row) => normalizeSubject(row.subject) === wanted);
  return ticket ? { ticket, matchedBy: 'subject_heuristic' } : null;
}

export function isMatch(result: TicketMatch | NoMatch): result is TicketMatch {
  return 'ticket' in result;
}
