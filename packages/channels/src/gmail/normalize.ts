import { z } from 'zod';

import { sanitizeHtml } from './html.js';
import {
  decodeEncodedWords,
  decodeTextPart,
  type HeaderBag,
  parseAddressList,
  parseMessageIds,
  parseMime,
  sha256Hex,
  type MailAddress,
  type MimeLimits,
  type MimePart,
} from './mime.js';

/**
 * MIME -> normalised email (R-2.5). Structure only; whether the mail is a bounce or noise is
 * `classify.ts`, and which ticket it belongs to is `threads.ts`.
 */

export const mailAddressSchema = z.object({
  address: z.string().min(3),
  name: z.string().nullable(),
});

export const attachmentRefSchema = z.object({
  /** Stable within the message; the key into `attachmentData`. */
  partId: z.string(),
  filename: z.string().nullable(),
  contentType: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string().length(64),
  /** `Content-ID` without angle brackets, lower-case. */
  contentId: z.string().nullable(),
  disposition: z.enum(['attachment', 'inline']),
  /** True when the sanitised HTML body points at this part through `cid:`. */
  referencedByHtml: z.boolean(),
});

export const normalizedEmailSchema = z.object({
  /** RFC 5322 `Message-ID` without angle brackets, as sent (case preserved). */
  messageId: z.string().nullable(),
  inReplyTo: z.string().nullable(),
  /** Oldest first, as in the header. */
  references: z.array(z.string()),
  subject: z.string(),
  from: mailAddressSchema.nullable(),
  replyTo: z.array(mailAddressSchema),
  to: z.array(mailAddressSchema),
  cc: z.array(mailAddressSchema),
  /** From the `Date` header; senders can lie, so prefer the provider's receive time. */
  sentAt: z.string().nullable(),
  /** Plain-text body: the `text/plain` part when present, else derived from the HTML. */
  textBody: z.string(),
  textSource: z.enum(['plain', 'html', 'none']),
  /** Sanitised HTML fragment (allow-list rebuild), or null when the message has no HTML part. */
  safeHtml: z.string().nullable(),
  remoteImagesBlocked: z.number().int().nonnegative(),
  attachments: z.array(attachmentRefSchema),
});

export type NormalizedEmail = z.infer<typeof normalizedEmailSchema>;
export type AttachmentRef = z.infer<typeof attachmentRefSchema>;

export interface NormalizeResult {
  readonly email: NormalizedEmail;
  /** Bytes per `AttachmentRef.partId`, for the caller to store in object storage. */
  readonly attachmentData: ReadonlyMap<string, Uint8Array>;
  /** Parsed header fields, for classification. */
  readonly headers: HeaderBag;
  /** Root content type, for classification (`multipart/report` is a delivery status notification). */
  readonly rootContentType: string;
  readonly rootContentTypeParams: Readonly<Record<string, string>>;
  /** Decoded text of every `message/delivery-status` part. */
  readonly deliveryStatusParts: readonly string[];
}

interface Bodies {
  text: string[];
  html: string[];
}

function addressToSchema(address: MailAddress): z.infer<typeof mailAddressSchema> {
  return { address: address.address, name: address.name };
}

function isAttachmentPart(part: MimePart): boolean {
  const type = part.contentType.main;
  if (part.disposition.main === 'attachment') return true;
  if (part.contentType.params['name'] !== undefined) return true;
  if (part.disposition.params['filename'] !== undefined) return true;
  if (type.startsWith('multipart/')) return false;
  if (type === 'text/plain' || type === 'text/html') return false;
  return true;
}

function cleanContentId(value: string | undefined): string | null {
  if (value === undefined) return null;
  const cleaned = value.trim().replace(/^<|>$/g, '').toLowerCase();
  return cleaned === '' ? null : cleaned;
}

function filenameOf(part: MimePart): string | null {
  const name = part.disposition.params['filename'] ?? part.contentType.params['name'];
  if (name === undefined || name === '') return null;
  // A filename is data, never a path: keep only the last segment and drop control characters.
  // eslint-disable-next-line no-control-regex -- stripping control characters is the purpose
  const cleaned = (name.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned === '' ? null : cleaned.slice(0, 255);
}

export function normalizeMime(raw: Uint8Array, limits: Partial<MimeLimits> = {}): NormalizeResult {
  const { root } = parseMime(raw, limits);
  const attachmentParts: MimePart[] = [];
  const deliveryStatusParts: string[] = [];

  const walk = (part: MimePart): Bodies => {
    const type = part.contentType.main;
    if (type === 'message/delivery-status') {
      deliveryStatusParts.push(decodeTextPart(part));
      attachmentParts.push(part);
      return { text: [], html: [] };
    }
    if (part.children.length > 0 || type.startsWith('multipart/')) {
      if (type === 'multipart/alternative') {
        const merged: Bodies = { text: [], html: [] };
        for (const child of part.children) {
          const bodies = walk(child);
          if (merged.text.length === 0) merged.text = bodies.text;
          if (merged.html.length === 0) merged.html = bodies.html;
        }
        return merged;
      }
      const merged: Bodies = { text: [], html: [] };
      for (const child of part.children) {
        const bodies = walk(child);
        merged.text.push(...bodies.text);
        merged.html.push(...bodies.html);
      }
      return merged;
    }
    if (isAttachmentPart(part)) {
      attachmentParts.push(part);
      return { text: [], html: [] };
    }
    if (type === 'text/html') return { text: [], html: [decodeTextPart(part)] };
    return { text: [decodeTextPart(part)], html: [] };
  };

  const bodies = walk(root);
  const headers = root.headers;

  let safeHtml: string | null = null;
  let htmlText = '';
  let remoteImagesBlocked = 0;
  let referenced = new Set<string>();
  if (bodies.html.length > 0) {
    const sanitized = sanitizeHtml(bodies.html.join('\n'), { keepRemoteImages: true });
    safeHtml = sanitized.html;
    htmlText = sanitized.text;
    remoteImagesBlocked = sanitized.remoteImagesBlocked;
    referenced = new Set(sanitized.inlineContentIds);
  }

  const plain = bodies.text.join('\n\n').trim();
  const textBody = plain !== '' ? plain : htmlText;
  const textSource = plain !== '' ? 'plain' : htmlText !== '' ? 'html' : 'none';

  const attachmentData = new Map<string, Uint8Array>();
  const attachments: AttachmentRef[] = attachmentParts.map((part) => {
    const contentId = cleanContentId(part.headers.get('content-id'));
    attachmentData.set(part.partId, part.body);
    const inline =
      part.disposition.main === 'inline' || (part.disposition.main === '' && contentId !== null);
    return {
      partId: part.partId,
      filename: filenameOf(part),
      contentType:
        part.contentType.main === '' ? 'application/octet-stream' : part.contentType.main,
      size: part.body.length,
      sha256: sha256Hex(part.body),
      contentId,
      disposition: inline ? 'inline' : 'attachment',
      referencedByHtml: contentId !== null && referenced.has(contentId),
    };
  });

  const ids = parseMessageIds(headers.get('message-id'));
  const inReplyTo = parseMessageIds(headers.get('in-reply-to'))[0] ?? null;
  const sentAtMs = Date.parse((headers.get('date') ?? '').replace(/\([^)]*\)/g, '').trim());

  const email: NormalizedEmail = {
    messageId: ids[0] ?? null,
    inReplyTo,
    references: parseMessageIds(headers.get('references')),
    subject: decodeEncodedWords(headers.get('subject') ?? '').trim(),
    from: parseAddressList(headers.get('from')).map(addressToSchema)[0] ?? null,
    replyTo: parseAddressList(headers.get('reply-to')).map(addressToSchema),
    to: parseAddressList(headers.get('to')).map(addressToSchema),
    cc: parseAddressList(headers.get('cc')).map(addressToSchema),
    sentAt: Number.isNaN(sentAtMs) ? null : new Date(sentAtMs).toISOString(),
    textBody,
    textSource,
    safeHtml,
    remoteImagesBlocked,
    attachments,
  };
  normalizedEmailSchema.parse(email);

  return {
    email,
    attachmentData,
    headers,
    rootContentType: root.contentType.main,
    rootContentTypeParams: root.contentType.params,
    deliveryStatusParts,
  };
}
