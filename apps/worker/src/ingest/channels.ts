import { gmail, line } from '@watchtower/channels';
import type { NormalisedInboundMessage, ThreadCandidate } from '@watchtower/domain';
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
  readonly transportFor?: (account: IngestAccount) => gmail.GmailTransport | undefined;
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
        const real = options.transportFor?.(account);
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

// -- LINE -----------------------------------------------------------------------------------------

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

/**
 * LINE: the receiver (T-103b) verified the signature on the raw body and wrote one event per row,
 * so the payload is a single event object. Only message events become messages; follow, unfollow,
 * events in `standby` mode and the rest are recorded by their `inbound_event` row and nothing more.
 * Stickers and message types this version does not know are kept as `noise` (R-2.12), and so is a
 * message whose sender LINE did not reveal (a group member who has not consented).
 */
export function createLineIngestor(): ChannelIngestor {
  return {
    ingest(account, source) {
      const event = line.normalizeLineEvent(source.payload);
      if (typeof event === 'string') {
        return Promise.reject(new PermanentIngestError(`line_${event}`));
      }
      if (event.kind !== 'message' || event.mode !== 'active' || event.source === null) {
        return Promise.resolve([]);
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
      const message: NormalisedInboundMessage = {
        channelAccountId: account.id,
        providerMessageId: event.messageId,
        rfc822MessageId: null,
        threadKey: `line:${conversationId}`,
        threadCandidates: [{ kind: 'line_conversation', value: conversationId }],
        from: { address: null, name: null, lineUserId: userId },
        subject: '',
        bodyText: lineBody(event.content),
        bodyHtml: null,
        attachments: [],
        receivedAt: new Date(event.occurredAt),
        rawObjectKey: null,
        automated,
      };
      return Promise.resolve([
        {
          message,
          raw: {
            body: Uint8Array.from(Buffer.from(JSON.stringify(source.payload), 'utf8')),
            contentType: 'application/json',
            extension: 'json',
          },
          attachmentData: new Map<string, Uint8Array>(),
        },
      ]);
    },
  };
}
