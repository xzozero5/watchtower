import { z } from 'zod';

/**
 * The seam between Watchtower and Gmail. Two implementations satisfy it: `FakeGmailTransport`
 * (in memory, always used in tests and mock mode) and `LiveGmailTransport` (HTTP, needs
 * credentials, `[ASK-HUMAN]` before it runs against a real mailbox). One contract suite runs
 * against both (`transport.contract.ts`).
 *
 * A transport is bound to one mailbox (`users/me` under that mailbox's credentials), so multiple
 * support mailboxes (po #4) are multiple transports.
 */

export const gmailLabelIdsSchema = z.array(z.string()).default([]);

export const gmailMessageRefSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
});

/** `users.messages` resource. `raw` is base64url and only present for `format: 'raw'`. */
export const gmailMessageSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  labelIds: gmailLabelIdsSchema,
  historyId: z.string().optional(),
  /** Epoch milliseconds as a string. */
  internalDate: z.string().optional(),
  sizeEstimate: z.number().int().nonnegative().optional(),
  raw: z.string().optional(),
});

const historyMessageSchema = gmailMessageRefSchema.extend({ labelIds: gmailLabelIdsSchema });

export const gmailHistoryRecordSchema = z.object({
  id: z.string(),
  messagesAdded: z.array(z.object({ message: historyMessageSchema })).optional(),
  messagesDeleted: z.array(z.object({ message: historyMessageSchema })).optional(),
  labelsAdded: z
    .array(z.object({ message: historyMessageSchema, labelIds: gmailLabelIdsSchema }))
    .optional(),
  labelsRemoved: z
    .array(z.object({ message: historyMessageSchema, labelIds: gmailLabelIdsSchema }))
    .optional(),
});

/** `users.history.list` response. `historyId` is the mailbox's current id: store it for next time. */
export const gmailHistoryPageSchema = z.object({
  history: z.array(gmailHistoryRecordSchema).default([]),
  nextPageToken: z.string().optional(),
  historyId: z.string(),
});

export const gmailMessageListSchema = z.object({
  messages: z.array(gmailMessageRefSchema).default([]),
  nextPageToken: z.string().optional(),
  resultSizeEstimate: z.number().int().nonnegative().optional(),
});

export const gmailWatchResponseSchema = z.object({
  historyId: z.string(),
  /** Epoch milliseconds as a string: when Gmail stops sending notifications. */
  expiration: z.string(),
});

export const gmailSendResponseSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  labelIds: gmailLabelIdsSchema,
});

export type GmailMessage = z.infer<typeof gmailMessageSchema>;
export type GmailMessageRef = z.infer<typeof gmailMessageRefSchema>;
export type GmailHistoryRecord = z.infer<typeof gmailHistoryRecordSchema>;
export type GmailHistoryPage = z.infer<typeof gmailHistoryPageSchema>;
export type GmailMessageList = z.infer<typeof gmailMessageListSchema>;
export type GmailWatchResponse = z.infer<typeof gmailWatchResponseSchema>;
export type GmailSendResponse = z.infer<typeof gmailSendResponseSchema>;

export const HISTORY_TYPES = [
  'messageAdded',
  'messageDeleted',
  'labelAdded',
  'labelRemoved',
] as const;
export type GmailHistoryType = (typeof HISTORY_TYPES)[number];

export interface ListHistoryRequest {
  readonly startHistoryId: string;
  readonly pageToken?: string;
  /** Provider default 100, maximum 500 (users.history.list reference, read 2026-10-31). */
  readonly maxResults?: number;
  readonly labelId?: string;
  readonly historyTypes?: readonly GmailHistoryType[];
}

export interface ListMessagesRequest {
  /** Gmail search syntax, for example `after:1700000000`. */
  readonly query?: string;
  readonly labelIds?: readonly string[];
  readonly pageToken?: string;
  readonly maxResults?: number;
  readonly includeSpamTrash?: boolean;
}

export interface GetMessageRequest {
  readonly id: string;
  /** `raw` returns the full RFC 822 message as base64url in `raw`. */
  readonly format: 'raw' | 'metadata' | 'minimal';
}

export interface SendMessageRequest {
  /** Base64url of the RFC 5322 message (see `buildReply`). */
  readonly raw: string;
  /** Attach to this thread; the headers and subject must also match for Gmail to thread it. */
  readonly threadId?: string;
}

export interface WatchRequest {
  /** `projects/<project>/topics/<topic>`. */
  readonly topicName: string;
  readonly labelIds?: readonly string[];
  readonly labelFilterBehavior?: 'include' | 'exclude';
}

export interface GmailTransport {
  /**
   * Rejects with `ChannelError` of kind `not_found` when `startHistoryId` is too old: the caller
   * must run a full sync (R-2.1). Use `isHistoryExpired`.
   */
  listHistory(request: ListHistoryRequest): Promise<GmailHistoryPage>;
  listMessages(request: ListMessagesRequest): Promise<GmailMessageList>;
  getMessage(request: GetMessageRequest): Promise<GmailMessage>;
  /** Not retried automatically after an unknown outcome: Gmail has no idempotency key (ADR-010). */
  sendMessage(request: SendMessageRequest): Promise<GmailSendResponse>;
  /** Must be renewed at least every 7 days; daily is recommended (R-2.1). */
  watch(request: WatchRequest): Promise<GmailWatchResponse>;
  stopWatch(): Promise<void>;
}

/** The `users.history.list` 404 that means "history too old, run a full sync". */
export function isHistoryExpired(error: unknown): boolean {
  return (
    error instanceof Error &&
    'kind' in error &&
    error.kind === 'not_found' &&
    'operation' in error &&
    error.operation === 'users.history.list'
  );
}

/** Pub/Sub push payload for a Gmail watch: `message.data` decodes to this. */
export const gmailPushDataSchema = z.object({
  emailAddress: z.string(),
  historyId: z.union([z.string(), z.number()]).transform(String),
});

export function decodeGmailPushData(base64Data: string): z.infer<typeof gmailPushDataSchema> {
  const json = Buffer.from(base64Data, 'base64url').toString('utf8');
  return gmailPushDataSchema.parse(JSON.parse(json));
}
