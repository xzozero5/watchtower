import { z } from 'zod';

import type { NormalizedEmail } from './normalize.js';

/**
 * Thread matching keys for inbound mail (R-2.3).
 *
 * The adapter only *lists* candidates in priority order; looking them up in the database and
 * deciding "append to ticket X or open a new one" is `domain.ingestInbound` (ADR-009 section 3).
 *
 * Priority, from R-2.3:
 *   1. Gmail `threadId`
 *   2. `In-Reply-To`
 *   3. `References`, newest reference first (the last id is the direct parent)
 *   4. a ticket key token such as `[OPS-1234]` in the subject
 */

export const THREAD_CANDIDATE_KINDS = [
  'gmail_thread_id',
  'in_reply_to',
  'references',
  'subject_token',
] as const;

export const threadCandidateSchema = z.object({
  kind: z.enum(THREAD_CANDIDATE_KINDS),
  /** `gmail_thread_id`: the id. `in_reply_to` / `references`: normalised Message-ID. `subject_token`: `PREFIX-n`. */
  value: z.string().min(1),
});

export type ThreadCandidate = z.infer<typeof threadCandidateSchema>;

/**
 * Message-ID comparison key: angle brackets and whitespace removed, lower-cased. Gmail and most
 * MTAs compare Message-IDs case-insensitively; a collision between two ids differing only in case
 * is not a realistic risk.
 */
export function normalizeMessageId(value: string): string {
  return value.trim().replace(/^<|>$/g, '').trim().toLowerCase();
}

const TICKET_PREFIX_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,15}$/;

/** `[OPS-1234]` -> `OPS-1234`. The prefix is the instance's `TICKET_KEY_PREFIX`. */
export function extractTicketKeys(subject: string, prefix: string): string[] {
  if (!TICKET_PREFIX_PATTERN.test(prefix)) {
    throw new Error('ticket key prefix must be 1-16 letters or digits, starting with a letter');
  }
  const pattern = new RegExp(`\\[(${prefix}-\\d{1,9})\\]`, 'gi');
  const keys: string[] = [];
  for (const match of subject.matchAll(pattern)) {
    const key = match[1];
    if (key !== undefined) keys.push(key.toUpperCase());
  }
  return [...new Set(keys)];
}

export interface ThreadKeyInput {
  readonly email: Pick<NormalizedEmail, 'messageId' | 'inReplyTo' | 'references' | 'subject'>;
  /** Gmail's own thread id for this message, when the provider supplied one. */
  readonly gmailThreadId?: string | null;
  /** The instance's ticket key prefix. Omit to skip subject-token matching. */
  readonly ticketKeyPrefix?: string;
}

export interface ThreadKeys {
  /** In priority order, without duplicates. */
  readonly candidates: readonly ThreadCandidate[];
  /**
   * Stable key to store on the message (`inbound_message.thread_key`): the Gmail thread id when
   * known, else the root of the reference chain, else the message's own id.
   */
  readonly threadKey: string | null;
  /** Normalised `Message-ID` of this message (the key for R-2.2 dedupe), or null if absent. */
  readonly messageIdKey: string | null;
}

export function buildThreadKeys(input: ThreadKeyInput): ThreadKeys {
  const { email } = input;
  const candidates: ThreadCandidate[] = [];
  const seen = new Set<string>();
  const add = (kind: ThreadCandidate['kind'], value: string | null | undefined): void => {
    if (value === null || value === undefined || value === '') return;
    const key = `${kind}:${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ kind, value });
  };

  add('gmail_thread_id', input.gmailThreadId);
  if (email.inReplyTo !== null) add('in_reply_to', normalizeMessageId(email.inReplyTo));
  for (const reference of [...email.references].reverse()) {
    add('references', normalizeMessageId(reference));
  }
  if (input.ticketKeyPrefix !== undefined) {
    for (const key of extractTicketKeys(email.subject, input.ticketKeyPrefix)) {
      add('subject_token', key);
    }
  }

  const root = email.references[0] ?? email.inReplyTo ?? email.messageId;
  const threadKey =
    input.gmailThreadId !== undefined && input.gmailThreadId !== null && input.gmailThreadId !== ''
      ? `gmail:${input.gmailThreadId}`
      : root === null
        ? null
        : `msgid:${normalizeMessageId(root)}`;

  return {
    candidates,
    threadKey,
    messageIdKey: email.messageId === null ? null : normalizeMessageId(email.messageId),
  };
}
