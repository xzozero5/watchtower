import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { NormalizedEmail } from './normalize.js';
import { normalizeMessageId } from './threads.js';

/**
 * Builds an in-thread reply for `users.messages.send` (R-2.3, ADR-010 section 6).
 *
 * Gmail threads a sent message when the request carries the `threadId`, the `References` /
 * `In-Reply-To` headers are RFC 2822 compliant, and the `Subject` matches
 * (https://developers.google.com/workspace/gmail/api/guides/threads, read 2026-10-31). So this
 * keeps the original subject by default and only adds the ticket key token when asked.
 */

export class ReplyBuildError extends Error {
  readonly code: 'header_injection' | 'invalid_input';

  constructor(code: ReplyBuildError['code'], detail: string) {
    super(`reply build failed: ${code} (${detail})`);
    this.name = 'ReplyBuildError';
    this.code = code;
  }
}

const addressSchema = z.object({
  address: z.email(),
  name: z.string().max(200).nullable().optional(),
});

/** The parent message as the ticket stores it. */
const parentSchema = z.object({
  messageId: z.string().min(1).nullable(),
  references: z.array(z.string().min(1)).default([]),
  subject: z.string(),
  from: addressSchema.nullable(),
  replyTo: z.array(addressSchema).default([]),
});

export const replyInputSchema = z.object({
  /** The mailbox or send-as alias the reply goes out as (R-2.4). */
  from: addressSchema,
  /** Parent message. Recipients default to its `Reply-To`, else `From`. */
  inReplyTo: parentSchema,
  /** Overrides the default recipients. */
  to: z.array(addressSchema).min(1).optional(),
  cc: z.array(addressSchema).default([]),
  /** Blind copies: sent as a `Bcc` header, which Gmail uses for delivery and removes `[UNVERIFIED 80%]`. */
  bcc: z.array(addressSchema).default([]),
  /** The person's own subject (an email reply composer). Replaces the parent's; the ticket token rule still applies. */
  subject: z.string().max(998).optional(),
  /** Files that travel with the mail. `contentId` + `inline` makes it an inline image (`cid:`), else an attachment. */
  attachments: z
    .array(
      z.object({
        filename: z.string().min(1).max(255),
        contentType: z.string().regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i),
        data: z.custom<Uint8Array>((value) => value instanceof Uint8Array),
        contentId: z
          .string()
          .regex(/^[^\s<>@]+(@[^\s<>@]+)?$/)
          .optional(),
        inline: z.boolean().default(false),
      }),
    )
    .max(20)
    .default([]),
  textBody: z.string().min(1),
  htmlBody: z.string().optional(),
  /** This message's `Message-ID` without angle brackets, for example from `makeMessageId`. */
  messageId: z.string().regex(/^[^\s<>@]+@[^\s<>@]+$/),
  /** Gmail thread to attach to. */
  threadId: z.string().min(1).optional(),
  /** Ticket key token (`OPS-1234`) to include in the subject as `[OPS-1234]` if missing. */
  ticketKey: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9]{0,15}-\d{1,9}$/)
    .optional(),
  /** `reuse` keeps the parent subject exactly (R-2.3); `prefix_re` adds "Re: " when absent. */
  subjectMode: z.enum(['reuse', 'prefix_re']).default('reuse'),
  /** Automatic response: marks it `Auto-Submitted: auto-replied` (RFC 3834 section 5) to stop loops. */
  automatic: z.boolean().default(false),
  date: z.date().optional(),
});

export type ReplyInput = z.input<typeof replyInputSchema>;

export interface BuiltReply {
  /** Base64url of the RFC 5322 message: the `raw` field of `users.messages.send`. */
  readonly raw: string;
  readonly threadId: string | undefined;
  readonly headers: {
    readonly messageId: string;
    readonly inReplyTo: string | null;
    readonly references: readonly string[];
    readonly subject: string;
    readonly to: readonly string[];
  };
}

const MAX_REFERENCES = 30;

/** `wt.<id>@<host>`: derived from the outbound delivery id so a message can be found again (ADR-010). */
export function makeMessageId(deliveryId: string, host: string): string {
  const local = `wt.${deliveryId.replace(/[^A-Za-z0-9._-]/g, '')}`;
  const domain = host.replace(/[^A-Za-z0-9.-]/g, '').toLowerCase();
  if (local === 'wt.' || domain === '') {
    throw new ReplyBuildError('invalid_input', 'delivery id or host is empty');
  }
  return `${local}@${domain}`;
}

function assertSingleLine(label: string, value: string): string {
  if (/[\r\n\0]/.test(value)) throw new ReplyBuildError('header_injection', label);
  return value;
}

function isAscii(value: string): boolean {
  // eslint-disable-next-line no-control-regex -- testing for non-ASCII
  return /^[\x00-\x7f]*$/.test(value);
}

/** RFC 2047 "B" encoded-words of at most 36 raw bytes each, split on code point boundaries. */
export function encodeHeaderText(value: string): string {
  if (isAscii(value)) return value;
  const words: string[] = [];
  let chunk = '';
  const flush = (): void => {
    if (chunk !== '') words.push(`=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`);
    chunk = '';
  };
  for (const char of value) {
    if (Buffer.byteLength(chunk + char, 'utf8') > 36) flush();
    chunk += char;
  }
  flush();
  return words.join('\r\n ');
}

function formatAddress(address: { address: string; name?: string | null | undefined }): string {
  assertSingleLine('address', address.address);
  const name = address.name?.trim();
  if (name === undefined || name === '') return address.address;
  assertSingleLine('display name', name);
  if (!isAscii(name)) return `${encodeHeaderText(name)}\r\n <${address.address}>`;
  if (/^[A-Za-z0-9 !#$%&'*+/=?^_`{|}~-]+$/.test(name)) return `${name} <${address.address}>`;
  return `"${name.replace(/(["\\])/g, '\\$1')}" <${address.address}>`;
}

/** Folds at spaces to stay under 78 columns. A "\r\n " inside the value is a fold chosen by the caller. */
function foldHeader(name: string, value: string): string {
  const lines: string[] = [];
  let line = `${name}:`;
  for (const [index, segment] of value.split('\r\n ').entries()) {
    if (index > 0) {
      lines.push(line);
      line = '';
    }
    for (const word of segment.split(' ')) {
      if (line.length + 1 + word.length > 76 && line.trim() !== '' && line !== `${name}:`) {
        lines.push(line);
        line = ` ${word}`;
      } else {
        line += ` ${word}`;
      }
    }
  }
  lines.push(line);
  return lines.join('\r\n');
}

function base64Lines(text: string): string {
  const encoded = Buffer.from(text.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64');
  return (encoded.match(/.{1,76}/g) ?? []).join('\r\n');
}

function toBase64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

type ReplyAttachment = z.output<typeof replyInputSchema>['attachments'][number];

function textPart(text: string): string[] {
  return [
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(text),
  ];
}

function htmlPart(html: string): string[] {
  return [
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(html),
  ];
}

function isInline(file: ReplyAttachment): boolean {
  return file.inline && file.contentId !== undefined;
}

/**
 * RFC 8187 `ext-value` text: percent-encoded UTF-8 where only `attr-char` stays literal. `encodeURIComponent`
 * leaves `' ( ) *` alone, which `attr-char` does not allow (T-171 C-7), and `%` must always be encoded.
 */
export function encodeRfc8187(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function filePart(file: ReplyAttachment): string[] {
  assertSingleLine('attachment name', file.filename);
  const quoted = file.filename.replace(/[^\x20-\x7e]/g, '_').replace(/(["\\])/g, '\\$1');
  const star = isAscii(file.filename) ? '' : `; filename*=UTF-8''${encodeRfc8187(file.filename)}`;
  const encoded = Buffer.from(file.data).toString('base64');
  return [
    `Content-Type: ${file.contentType}; name="${quoted}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: ${isInline(file) ? 'inline' : 'attachment'}; filename="${quoted}"${star}`,
    ...(file.contentId === undefined ? [] : [`Content-ID: <${file.contentId}>`]),
    '',
    (encoded.match(/.{1,76}/g) ?? []).join('\r\n'),
  ];
}

interface Wrapped {
  readonly header: string;
  readonly body: string;
}

/**
 * The MIME tree: `multipart/alternative` (text, html) at the core, `multipart/related` when the html
 * has inline images (`cid:`), `multipart/mixed` on top when files are attached.
 */
function buildBody(
  input: z.output<typeof replyInputSchema>,
  boundary: string,
  headerLines: string[],
): string {
  const wrap = (kind: string, suffix: string, parts: string[][]): Wrapped => {
    const id = suffix === '' ? boundary : `${boundary}-${suffix}`;
    return {
      header: `Content-Type: ${kind}; boundary="${id}"`,
      body: [...parts.flatMap((part) => [`--${id}`, ...part]), `--${id}--`, ''].join('\r\n'),
    };
  };
  const nested = (w: Wrapped): string[] => [w.header, '', w.body];
  const inlineFiles = input.attachments.filter(isInline);
  const regularFiles = input.attachments.filter((file) => !isInline(file));

  if (input.htmlBody === undefined) {
    if (input.attachments.length === 0) {
      headerLines.push(
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: base64',
      );
      return base64Lines(input.textBody);
    }
    const mixed = wrap('multipart/mixed', 'm', [
      textPart(input.textBody),
      ...input.attachments.map(filePart),
    ]);
    headerLines.push(mixed.header);
    return mixed.body;
  }
  const htmlSide =
    inlineFiles.length === 0
      ? htmlPart(input.htmlBody)
      : nested(
          wrap('multipart/related', 'r', [htmlPart(input.htmlBody), ...inlineFiles.map(filePart)]),
        );
  const alternative = wrap('multipart/alternative', '', [textPart(input.textBody), htmlSide]);
  if (regularFiles.length === 0) {
    headerLines.push(alternative.header);
    return alternative.body;
  }
  const mixed = wrap('multipart/mixed', 'm', [nested(alternative), ...regularFiles.map(filePart)]);
  headerLines.push(mixed.header);
  return mixed.body;
}

export function buildReply(rawInput: ReplyInput): BuiltReply {
  const parsed = replyInputSchema.safeParse(rawInput);
  if (!parsed.success) throw new ReplyBuildError('invalid_input', 'schema validation failed');
  const input = parsed.data;

  const parent = input.inReplyTo;
  const recipients =
    input.to ??
    (parent.replyTo.length > 0 ? parent.replyTo : parent.from === null ? [] : [parent.from]);
  if (recipients.length === 0) throw new ReplyBuildError('invalid_input', 'no recipient');

  // Subject: same as the parent (R-2.3), plus the ticket token when it is not already there.
  let subject = assertSingleLine('subject', (input.subject ?? parent.subject).trim());
  if (input.subject === undefined && input.subjectMode === 'prefix_re' && !/^re:/i.test(subject))
    subject = `Re: ${subject}`;
  if (input.ticketKey !== undefined) {
    const token = `[${input.ticketKey.toUpperCase()}]`;
    if (!subject.toUpperCase().includes(token)) subject = `${subject} ${token}`.trim();
  }

  const parentId = parent.messageId === null ? null : normalizeMessageIdKeepCase(parent.messageId);
  const referenceIds = parent.references.map(normalizeMessageIdKeepCase);
  if (parentId !== null && referenceIds.at(-1)?.toLowerCase() !== parentId.toLowerCase()) {
    referenceIds.push(parentId);
  }
  // Keep the root and the newest ids when a long chain has to be trimmed.
  const references =
    referenceIds.length > MAX_REFERENCES
      ? [referenceIds[0] ?? '', ...referenceIds.slice(-(MAX_REFERENCES - 1))]
      : referenceIds;

  const messageId = assertSingleLine('message-id', input.messageId);
  const date = (input.date ?? new Date()).toUTCString().replace('GMT', '+0000');
  const boundary = `wt-${createHash('sha256').update(messageId).digest('hex').slice(0, 24)}`;

  // Each address appears once, in the most visible place it was given (To, then Cc, then Bcc): a blind
  // copy to someone who is already on the visible list is no secret, and Gmail would deliver twice.
  const seenAddresses = new Set(recipients.map((entry) => entry.address.toLowerCase()));
  const uniqueOnly = (list: typeof input.cc): typeof input.cc =>
    list.filter((entry) => {
      const key = entry.address.toLowerCase();
      if (seenAddresses.has(key)) return false;
      seenAddresses.add(key);
      return true;
    });
  const cc = uniqueOnly(input.cc);
  const bcc = uniqueOnly(input.bcc);

  // `Bcc` is written to the raw message on purpose: `users.messages.send` has no envelope parameter,
  // so the header is the only way to name a blind copy. Gmail delivers to it and does not show it to
  // the other recipients `[UNVERIFIED 80%]` (T-171 C-4: confirm once with a real mailbox). Nothing else
  // in this module or the returned `headers` repeats these addresses.
  const headerLines = [
    foldHeader('From', formatAddress(input.from)),
    foldHeader('To', recipients.map(formatAddress).join(', ')),
    ...(cc.length > 0 ? [foldHeader('Cc', cc.map(formatAddress).join(', '))] : []),
    ...(bcc.length > 0 ? [foldHeader('Bcc', bcc.map(formatAddress).join(', '))] : []),
    `Subject: ${encodeHeaderText(subject)}`,
    `Date: ${date}`,
    `Message-ID: <${messageId}>`,
    ...(parentId === null ? [] : [`In-Reply-To: <${parentId}>`]),
    ...(references.length > 0
      ? [foldHeader('References', references.map((id) => `<${id}>`).join(' '))]
      : []),
    ...(input.automatic ? ['Auto-Submitted: auto-replied'] : []),
    'MIME-Version: 1.0',
  ];

  const body = buildBody(input, boundary, headerLines);

  const message = `${headerLines.join('\r\n')}\r\n\r\n${body}`;
  return {
    raw: toBase64Url(Buffer.from(message, 'utf8')),
    threadId: input.threadId,
    headers: {
      messageId,
      inReplyTo: parentId,
      references,
      subject,
      to: recipients.map((recipient) => recipient.address.toLowerCase()),
    },
  };
}

/** Strips brackets and whitespace but keeps the case, which is how the id was originally sent. */
function normalizeMessageIdKeepCase(value: string): string {
  const stripped = value.trim().replace(/^<|>$/g, '').trim();
  assertSingleLine('message-id reference', stripped);
  // Reuse normalizeMessageId only to validate that something is left.
  if (normalizeMessageId(stripped) === '') {
    throw new ReplyBuildError('invalid_input', 'empty message id');
  }
  return stripped;
}

/** Convenience for callers holding a normalised inbound email. */
export function parentFromEmail(email: NormalizedEmail): z.input<typeof parentSchema> {
  return {
    messageId: email.messageId,
    references: email.references,
    subject: email.subject,
    from: email.from,
    replyTo: email.replyTo,
  };
}
