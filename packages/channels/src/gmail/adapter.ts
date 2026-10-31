import { z } from 'zod';

import { unsupportedOperation, ChannelError } from '../common/errors.js';
import type { ChannelAdapter, ChannelCapabilities } from '../common/adapter.js';
import { automatedVerdictSchema, classifyAutomated, type AutomatedVerdict } from './classify.js';
import type { MimeLimits } from './mime.js';
import { normalizeMime, normalizedEmailSchema } from './normalize.js';
import { buildReply, type BuiltReply, type ReplyInput } from './reply.js';
import { buildThreadKeys, threadCandidateSchema } from './threads.js';
import type { GmailSendResponse, GmailTransport } from './transport.js';

/**
 * The Gmail `ChannelAdapter` (PRD section 4.2): fetch + normalise + classify an inbound message,
 * and build + send an in-thread reply. Everything it needs from outside comes through the
 * `GmailTransport` it is given, so with `FakeGmailTransport` it runs with no credentials.
 */

export const gmailInboundSchema = z.object({
  providerMessageId: z.string(),
  gmailThreadId: z.string(),
  historyId: z.string().nullable(),
  labelIds: z.array(z.string()),
  /** Gmail's `internalDate` (when Gmail received it) as ISO-8601, else the Date header, else null. */
  receivedAt: z.string().nullable(),
  email: normalizedEmailSchema,
  automated: automatedVerdictSchema,
  threadCandidates: z.array(threadCandidateSchema),
  threadKey: z.string().nullable(),
  /** Normalised Message-ID: the secondary dedupe key of R-2.2. */
  messageIdKey: z.string().nullable(),
  rawSize: z.number().int().nonnegative(),
});

export type GmailInboundSerializable = z.infer<typeof gmailInboundSchema>;

/** The serialisable message plus the attachment bytes to put in object storage. */
export interface GmailInbound extends GmailInboundSerializable {
  readonly attachmentData: ReadonlyMap<string, Uint8Array>;
}

export interface GmailIngestInput {
  /** Gmail message id, from a `history.list` record or a full-sync listing. */
  readonly messageId: string;
}

export interface GmailAdapterOptions {
  readonly transport: GmailTransport;
  /** The instance's ticket key prefix (`TICKET_KEY_PREFIX`) for `[OPS-1234]` subject matching. */
  readonly ticketKeyPrefix?: string;
  readonly mimeLimits?: Partial<MimeLimits>;
}

export type GmailSendInput = ReplyInput;

export interface GmailSendResult {
  readonly providerMessageId: string;
  readonly gmailThreadId: string;
  /** The `Message-ID` the reply was sent with (without angle brackets). */
  readonly messageId: string;
  readonly built: BuiltReply['headers'];
}

export const GMAIL_CAPABILITIES: ChannelCapabilities = {
  channel: 'gmail',
  receive: true,
  send: true,
  threading: 'native',
  markRead: false,
  replyToken: false,
  attachments: true,
  html: true,
  maxTextLength: null,
};

export class GmailAdapter implements ChannelAdapter<
  GmailIngestInput,
  GmailInbound,
  GmailSendInput,
  GmailSendResult,
  never
> {
  readonly #options: GmailAdapterOptions;

  constructor(options: GmailAdapterOptions) {
    this.#options = options;
  }

  capabilities(): ChannelCapabilities {
    return GMAIL_CAPABILITIES;
  }

  async ingest(input: GmailIngestInput): Promise<readonly GmailInbound[]> {
    const message = await this.#options.transport.getMessage({
      id: input.messageId,
      format: 'raw',
    });
    if (message.raw === undefined) {
      throw new ChannelError({
        provider: 'gmail',
        operation: 'users.messages.get',
        kind: 'invalid_response',
      });
    }
    const bytes = Uint8Array.from(
      Buffer.from(message.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
    );
    const normalized = normalizeMime(bytes, this.#options.mimeLimits);

    const automated: AutomatedVerdict = classifyAutomated({
      headers: normalized.headers,
      rootContentType: normalized.rootContentType,
      rootContentTypeParams: normalized.rootContentTypeParams,
      subject: normalized.email.subject,
      deliveryStatusParts: normalized.deliveryStatusParts,
      labelIds: message.labelIds,
    });
    const keys = buildThreadKeys({
      email: normalized.email,
      gmailThreadId: message.threadId,
      ...(this.#options.ticketKeyPrefix === undefined
        ? {}
        : { ticketKeyPrefix: this.#options.ticketKeyPrefix }),
    });

    const internal = message.internalDate === undefined ? Number.NaN : Number(message.internalDate);
    const receivedAt = Number.isFinite(internal)
      ? new Date(internal).toISOString()
      : normalized.email.sentAt;

    const inbound: GmailInbound = {
      providerMessageId: message.id,
      gmailThreadId: message.threadId,
      historyId: message.historyId ?? null,
      labelIds: message.labelIds,
      receivedAt,
      email: normalized.email,
      automated,
      threadCandidates: [...keys.candidates],
      threadKey: keys.threadKey,
      messageIdKey: keys.messageIdKey,
      rawSize: bytes.length,
      attachmentData: normalized.attachmentData,
    };
    gmailInboundSchema.parse(inbound);
    return [inbound];
  }

  async send(input: GmailSendInput): Promise<GmailSendResult> {
    const built = buildReply(input);
    const response: GmailSendResponse = await this.#options.transport.sendMessage({
      raw: built.raw,
      ...(built.threadId === undefined ? {} : { threadId: built.threadId }),
    });
    return {
      providerMessageId: response.id,
      gmailThreadId: response.threadId,
      messageId: built.headers.messageId,
      built: built.headers,
    };
  }

  /** Gmail has no read-receipt concept for customers; `capabilities().markRead` is false. */
  markRead(): Promise<void> {
    return Promise.reject(unsupportedOperation('gmail', 'markRead'));
  }
}
