import { createHash } from 'node:crypto';

import { ChannelError, gmail, line } from '@watchtower/channels';
import {
  parseLinkCode,
  type InboundAttachment,
  type NormalisedInboundMessage,
  type ThreadCandidate,
} from '@watchtower/domain';
import { z } from 'zod';

/**
 * The seam between a channel adapter (`packages/channels`) and ingestion: turns the payload of one
 * `inbound_event` into zero or more normalised messages plus the raw bytes to keep. The adapters
 * themselves know nothing about the database; this file knows nothing about the provider's wire
 * format beyond what the adapters expose.
 */

export interface IngestAccount {
  readonly id: string;
  readonly type: string;
}

export interface IngestSource {
  readonly providerEventId: string;
  readonly payload: Record<string, unknown>;
  readonly receivedAt: Date;
}

export interface IngestedItem {
  /** `rawObjectKey` and the attachment `objectKey`s are filled in by the processor after storing. */
  readonly message: NormalisedInboundMessage;
  readonly raw: {
    readonly body: Uint8Array;
    readonly contentType: string;
    readonly extension: string;
  };
  /** Bytes per attachment `partId`. */
  readonly attachmentData: ReadonlyMap<string, Uint8Array>;
  /**
   * LINE: the text of the message was a one-time link code (T-103d). The message body is already
   * replaced by `[link code]`, so the code is stored nowhere (not in a ticket, not for a model);
   * the processor redeems it from here and drops it.
   */
  readonly linkCode?: string | undefined;
}

export interface ChannelIngestor {
  ingest(account: IngestAccount, source: IngestSource): Promise<readonly IngestedItem[]>;
}

/** The event can never succeed (a payload that does not parse, a channel nobody handles): do not retry. */
export class PermanentIngestError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`inbound event cannot be processed: ${code}`);
    this.name = 'PermanentIngestError';
    this.code = code;
  }
}

// -- Gmail ----------------------------------------------------------------------------------------

/** `{ messageId }`: the sync step found a message id; fetch it through the account's transport. */
const gmailFetchPayload = z.object({ messageId: z.string().min(1) });
/**
 * `{ raw, threadId, ... }`: the message itself rides in the event (the fake channel of the e2e
 * harness, and tests). Only accepted outside production (`allowEmbedded`).
 */
const gmailEmbeddedPayload = z.object({
  raw: z.string().min(1),
  threadId: z.string().min(1),
  id: z.string().min(1).optional(),
  labelIds: z.array(z.string()).optional(),
  internalDate: z.string().optional(),
});

export interface GmailIngestorOptions {
  /** The instance's ticket key prefix (`TICKET_KEY_PREFIX`) for `[OPS-n]` subject tokens. */
  readonly ticketKeyPrefix: string;
  /** The transport of one mailbox; undefined = this process has no way to reach it (no credentials). */
  readonly transportFor?: (
    account: IngestAccount,
  ) => gmail.GmailTransport | undefined | Promise<gmail.GmailTransport | undefined>;
  readonly allowEmbedded: boolean;
}

/** Wraps a transport so the raw bytes of the message the adapter fetched can be kept (R-2.5). */
function capturing(
  transport: gmail.GmailTransport,
  sink: Map<string, string>,
): gmail.GmailTransport {
  return {
    listHistory: (request) => transport.listHistory(request),
    listMessages: (request) => transport.listMessages(request),
    getMessage: async (request) => {
      const message = await transport.getMessage(request);
      if (message.raw !== undefined) sink.set(message.id, message.raw);
      return message;
    },
    sendMessage: (request) => transport.sendMessage(request),
    watch: (request) => transport.watch(request),
    stopWatch: () => transport.stopWatch(),
  };
}

function base64UrlToBytes(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
}

function candidatesOf(inbound: gmail.GmailInbound): ThreadCandidate[] {
  return inbound.threadCandidates.map((candidate) => ({
    kind: candidate.kind,
    value: candidate.value,
  }));
}

export function createGmailIngestor(options: GmailIngestorOptions): ChannelIngestor {
  return {
    async ingest(account, source) {
      const embedded = gmailEmbeddedPayload.safeParse(source.payload);
      const fetched = gmailFetchPayload.safeParse(source.payload);
      let transport: gmail.GmailTransport;
      let messageId: string;
      let providerMessageId: string | null = null;
      if (embedded.success) {
        if (!options.allowEmbedded) throw new PermanentIngestError('embedded_payload_not_allowed');
        const fake = new gmail.FakeGmailTransport();
        const stored = fake.deliver(base64UrlToBytes(embedded.data.raw), {
          threadId: embedded.data.threadId,
          ...(embedded.data.labelIds === undefined ? {} : { labelIds: embedded.data.labelIds }),
          // The time Gmail would have received it: from the event, else when the event arrived.
          internalDate: new Date(
            embedded.data.internalDate === undefined
              ? source.receivedAt.getTime()
              : Number(embedded.data.internalDate),
          ),
        });
        transport = fake;
        messageId = stored.id;
        // The fake numbers its messages from 1 in every process: the id must come from the event.
        providerMessageId = embedded.data.id ?? source.providerEventId;
      } else if (fetched.success) {
        const real = await options.transportFor?.(account);
        if (real === undefined) throw new PermanentIngestError('gmail_transport_unavailable');
        transport = real;
        messageId = fetched.data.messageId;
      } else {
        throw new PermanentIngestError('gmail_payload_invalid');
      }

      const raws = new Map<string, string>();
      const adapter = new gmail.GmailAdapter({
        transport: capturing(transport, raws),
        ticketKeyPrefix: options.ticketKeyPrefix,
      });
      const found = await adapter.ingest({ messageId });
      const items: IngestedItem[] = [];
      for (const inbound of found) {
        // Mail we sent ourselves is not a customer message (it is in the mailbox as SENT).
        if (inbound.labelIds.includes('SENT') || inbound.labelIds.includes('DRAFT')) continue;
        const rawBase64 = raws.get(inbound.providerMessageId);
        if (rawBase64 === undefined) throw new PermanentIngestError('gmail_raw_missing');
        const { email } = inbound;
        const message: NormalisedInboundMessage = {
          channelAccountId: account.id,
          providerMessageId: providerMessageId ?? inbound.providerMessageId,
          rfc822MessageId: inbound.messageIdKey,
          threadKey: inbound.threadKey,
          threadCandidates: candidatesOf(inbound),
          from: {
            address: email.from?.address ?? null,
            name: email.from?.name ?? null,
            lineUserId: null,
          },
          subject: email.subject,
          bodyText: email.textBody,
          bodyHtml: email.safeHtml,
          emailMeta: {
            from: email.from,
            to: email.to,
            cc: email.cc,
            subject: email.subject,
          },
          attachments: email.attachments.map((attachment) => ({
            partId: attachment.partId,
            filename: attachment.filename,
            contentType: attachment.contentType,
            size: attachment.size,
            sha256: attachment.sha256,
            objectKey: null,
            disposition: attachment.disposition,
            contentId: attachment.contentId,
            referencedByHtml: attachment.referencedByHtml,
          })),
          receivedAt: new Date(inbound.receivedAt ?? source.receivedAt),
          rawObjectKey: null,
          automated: {
            disposition: inbound.automated.disposition,
            subtype: inbound.automated.subtype,
            signals: inbound.automated.signals,
          },
        };
        items.push({
          message,
          raw: {
            body: base64UrlToBytes(rawBase64),
            contentType: 'message/rfc822',
            extension: 'eml',
          },
          attachmentData: inbound.attachmentData,
        });
      }
      return items;
    },
  };
}

/**
 * A LINE event without its credentials: no reply token, and the text of a link code message blanked
 * (the code is a credential for one link; `parseLinkCode` decides what counts). Used for the raw copy
 * in object storage and for the payload that stays on an event that failed for good.
 */
export function scrubLineEvent(payload: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...payload };
  delete rest.replyToken;
  const message = rest.message;
  if (
    typeof message === 'object' &&
    message !== null &&
    'text' in message &&
    typeof message.text === 'string' &&
    parseLinkCode(message.text) !== null
  ) {
    rest.message = { ...message, text: '[link code]' };
  }
  return rest;
}

// -- LINE -----------------------------------------------------------------------------------------

/** Images and files bigger than this are described, not downloaded `[ASSUMED]` (storage and memory). */
export const LINE_MEDIA_MAX_BYTES = line.LINE_CONTENT_MAX_BYTES;

const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

function lineBody(
  content: Extract<line.NormalizedLineEvent, { kind: 'message' }>['content'],
): string {
  switch (content.type) {
    case 'text':
      return content.text;
    case 'image':
      return '[image]';
    case 'video':
      return '[video]';
    case 'audio':
      return '[audio]';
    case 'file':
      return `[file] ${content.fileName}`;
    case 'location': {
      const where = [content.title, content.address].filter((part) => part !== null && part !== '');
      return `[location] ${where.join(', ')} (${String(content.latitude)}, ${String(content.longitude)})`.replace(
        /\s+/g,
        ' ',
      );
    }
    case 'sticker':
      return '[sticker]';
    case 'unsupported':
      return `[unsupported message: ${content.messageType}]`;
  }
}

/** A file name from LINE or a customer, safe as a display name: no path, no control characters. */
function displayFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = Array.from(base)
    .filter((character) => character.charCodeAt(0) >= 0x20 && character.charCodeAt(0) !== 0x7f)
    .join('')
    .trim()
    .slice(0, 200);
  return cleaned === '' ? 'file' : cleaned;
}

export interface LineIngestorOptions {
  /**
   * The Messaging API client of one Official Account, for downloading images and files (R-2.12).
   * Undefined for an account this process has no credentials for: the message is kept and the media
   * is only described. Tests give it a `FakeLineTransport`.
   */
  readonly transportFor?: (account: IngestAccount) => line.LineTransport | undefined;
}

interface Downloaded {
  readonly attachment: InboundAttachment;
  readonly bytes: Uint8Array;
}

/**
 * Fetches the bytes of an image or file message right away: LINE deletes content after an
 * unspecified time (R-2.12). Returns null when there is nothing to store (an external image URL,
 * content that is gone or too big, or no way to reach LINE): the message itself is still kept. A
 * failure that may pass (timeout, 5xx, rate limit) is thrown so the job is retried.
 */
async function downloadLineMedia(
  transport: line.LineTransport,
  messageId: string,
  content: Extract<line.LineContent, { type: 'image' | 'file' }>,
): Promise<Downloaded | null> {
  if (content.type === 'image' && content.provider !== 'line') return null;
  if (content.type === 'file' && content.fileSize > LINE_MEDIA_MAX_BYTES) return null;
  let result: line.LineContentResult;
  try {
    result = await transport.getContent(messageId);
  } catch (error) {
    // Gone or never available: no reason to ask again.
    if (error instanceof ChannelError && !error.retryable && error.kind !== 'auth') return null;
    throw error;
  }
  // 202: a large item is still being prepared. Images and files should not be, but retry rather than lose it.
  if (result.status === 'preparing') throw new Error('line_content_preparing');
  if (result.bytes.length > LINE_MEDIA_MAX_BYTES) return null;
  const contentType =
    (result.contentType ?? 'application/octet-stream').split(';')[0]?.trim() ?? '';
  const name =
    content.type === 'file'
      ? displayFileName(content.fileName)
      : `line-image-${messageId}.${IMAGE_EXTENSIONS[contentType] ?? 'bin'}`;
  return {
    bytes: result.bytes,
    attachment: {
      partId: messageId,
      filename: name,
      contentType: contentType === '' ? 'application/octet-stream' : contentType,
      size: result.bytes.length,
      sha256: createHash('sha256').update(result.bytes).digest('hex'),
      objectKey: null,
      disposition: 'attachment',
      contentId: null,
      referencedByHtml: false,
    },
  };
}

/**
 * LINE: the receiver (T-103b) verified the signature on the raw body and wrote one event per row,
 * so the payload is a single event object. Only message events become messages; follow, unfollow,
 * events in `standby` mode and the rest are recorded by their `inbound_event` row and nothing more.
 * Stickers and message types this version does not know are kept as `noise` (R-2.12), and so is a
 * message whose sender LINE did not reveal (a group member who has not consented). Images and
 * files are downloaded now and stored with the message (T-103c).
 */
export function createLineIngestor(options: LineIngestorOptions = {}): ChannelIngestor {
  return {
    async ingest(account, source) {
      const event = line.normalizeLineEvent(source.payload);
      if (typeof event === 'string') {
        throw new PermanentIngestError(`line_${event}`);
      }
      if (event.kind !== 'message' || event.mode !== 'active' || event.source === null) {
        return [];
      }
      const userId = event.source.userId;
      const sticker = event.content.type === 'sticker';
      const unsupported = event.content.type === 'unsupported';
      const automated =
        userId === null
          ? { disposition: 'noise' as const, subtype: 'line_sender_hidden', signals: [] }
          : sticker
            ? { disposition: 'noise' as const, subtype: 'sticker', signals: [] }
            : unsupported
              ? { disposition: 'noise' as const, subtype: 'unsupported_content', signals: [] }
              : { disposition: 'human' as const, subtype: 'none', signals: [] };
      const conversationId = event.source.conversationId;

      const attachments: InboundAttachment[] = [];
      const attachmentData = new Map<string, Uint8Array>();
      const transport = options.transportFor?.(account);
      if (
        transport !== undefined &&
        automated.disposition === 'human' &&
        (event.content.type === 'image' || event.content.type === 'file')
      ) {
        const downloaded = await downloadLineMedia(transport, event.messageId, event.content);
        if (downloaded !== null) {
          attachments.push(downloaded.attachment);
          attachmentData.set(downloaded.attachment.partId, downloaded.bytes);
        }
      }

      const linkCode =
        userId !== null && event.content.type === 'text' ? parseLinkCode(event.content.text) : null;
      const message: NormalisedInboundMessage = {
        channelAccountId: account.id,
        providerMessageId: event.messageId,
        rfc822MessageId: null,
        threadKey: `line:${conversationId}`,
        threadCandidates: [{ kind: 'line_conversation', value: conversationId }],
        from: { address: null, name: null, lineUserId: userId },
        subject: '',
        // Whether or not the code works, it is never kept as the text of a message (C-3).
        bodyText: linkCode === null ? lineBody(event.content) : '[link code]',
        bodyHtml: null,
        attachments,
        receivedAt: new Date(event.occurredAt),
        rawObjectKey: null,
        automated,
        // Single-use and short-lived; the domain seals it for the dispatcher (ADR-010 section 6).
        replyToken: event.replyToken,
      };
      return [
        {
          message,
          raw: {
            // The reply token is a credential for one free reply (ADR-010): it lives sealed in the database
            // and never in the object store, which keeps raw events for a long time (review O-5).
            body: Uint8Array.from(
              Buffer.from(JSON.stringify(scrubLineEvent(source.payload)), 'utf8'),
            ),
            contentType: 'application/json',
            extension: 'json',
          },
          attachmentData,
          ...(linkCode === null ? {} : { linkCode }),
        },
      ];
    },
  };
}
