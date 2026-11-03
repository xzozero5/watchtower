import type { EmailAddress, Message, TimelineEntry } from '@watchtower/shared';

type MessageEntry = Extract<TimelineEntry, { kind: 'message' }>;

/** A message that is shown as an email: public, on the email channel. Internal notes stay notes. */
export function isEmailMessage(message: Message): boolean {
  return message.channel === 'gmail' && message.visibility === 'public';
}

export function emailMessages(entries: readonly TimelineEntry[]): MessageEntry[] {
  return entries.filter(
    (entry): entry is MessageEntry => entry.kind === 'message' && isEmailMessage(entry),
  );
}

/**
 * Which messages of a thread start open. Like Gmail: the newest one is open and the rest are one
 * line each. A message that still needs attention (waiting to send, or failed) stays open so its
 * Undo or failure note is not hidden.
 */
export function defaultExpandedIds(entries: readonly TimelineEntry[]): Set<string> {
  const mails = emailMessages(entries);
  const open = new Set<string>();
  const last = mails.at(-1);
  if (last) open.add(last.id);
  for (const mail of mails) {
    if (mail.deliveryStatus === 'scheduled' || mail.deliveryStatus === 'failed') open.add(mail.id);
  }
  return open;
}

/** The subject of the thread: the first email that has one. */
export function threadSubject(entries: readonly TimelineEntry[]): string | null {
  for (const mail of emailMessages(entries)) {
    const subject = mail.emailMeta?.subject?.trim();
    if (subject) return subject;
  }
  return null;
}

export interface Party {
  readonly name: string | null;
  readonly address: string | null;
}

/** Who sent it: the address in the header block when there is one, else the sender the api names. */
export function senderParty(message: Message): Party {
  const from = message.emailMeta?.from;
  return {
    name: from?.name?.trim() || message.sender.name,
    address: from?.address ?? null,
  };
}

export function formatAddress(address: EmailAddress): string {
  const name = address.name?.trim();
  return name ? `${name} <${address.address}>` : address.address;
}

/** The first non-empty line of the visible text: what a collapsed row shows after the name. */
export function snippetOf(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** "Re: " once, whatever the language of the existing prefix. */
export function replySubject(subject: string): string {
  const base = subject.trim();
  return /^(re|ตอบ|ตอบกลับ)\s*:/i.test(base) ? base : `Re: ${base}`;
}

export interface ReplyDefaults {
  readonly to: EmailAddress[];
  /** Everyone else on the last inbound mail: offered by "Reply all", not filled in. */
  readonly others: EmailAddress[];
  readonly subject: string;
  readonly quoted: MessageEntry | null;
}

/**
 * Who a reply goes to and what it is called. To: the sender of the last mail from the customer,
 * else the requester. Others: the rest of that mail's To and Cc, minus the people already in To
 * and the writer's own address.
 */
export function replyDefaults(
  entries: readonly TimelineEntry[],
  context: { requester: EmailAddress | null; self: string | null; ticketSubject: string },
): ReplyDefaults {
  const mails = emailMessages(entries);
  const lastInbound = [...mails].reverse().find((mail) => mail.direction === 'inbound') ?? null;
  const from = lastInbound?.emailMeta?.from ?? null;
  const to: EmailAddress[] = from ? [from] : context.requester ? [context.requester] : [];
  const seen = new Set(to.map((entry) => entry.address.toLowerCase()));
  if (context.self) seen.add(context.self.toLowerCase());
  const others: EmailAddress[] = [];
  for (const entry of [
    ...(lastInbound?.emailMeta?.to ?? []),
    ...(lastInbound?.emailMeta?.cc ?? []),
  ]) {
    const key = entry.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    others.push(entry);
  }
  const subject = threadSubject(entries) ?? context.ticketSubject;
  return { to, others, subject: replySubject(subject), quoted: lastInbound };
}
