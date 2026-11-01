import { z } from 'zod';

import type { LineConsumptionResponse, LineQuotaResponse } from './quota.js';

/**
 * The seam between Watchtower and the LINE Messaging API. `FakeLineTransport` (in memory, always
 * used in tests and mock mode) and `LiveLineTransport` (HTTP) both satisfy it, and one contract
 * suite runs against both (`transport.contract.ts`). One transport per channel access token, that
 * is per LINE Official Account (`channel_account`).
 */

export const LINE_MAX_MESSAGES_PER_REQUEST = 5;
export const LINE_MAX_TEXT_LENGTH = 5000;
/** The most media bytes one download may hold in memory and store `[ASSUMED]`. A bigger body is refused while streaming. */
export const LINE_CONTENT_MAX_BYTES = 25 * 1024 * 1024;

export const lineTextMessageSchema = z.object({
  type: z.literal('text'),
  /** At most 5,000 UTF-16 code units (Messaging API reference, text message object). */
  text: z.string().min(1).max(LINE_MAX_TEXT_LENGTH),
});

export const lineOutboundMessagesSchema = z
  .array(lineTextMessageSchema)
  .min(1)
  .max(LINE_MAX_MESSAGES_PER_REQUEST);

export type LineTextMessage = z.infer<typeof lineTextMessageSchema>;

/** `X-Line-Retry-Key`: a hexadecimal UUID the caller generates (retrying-api-request guide). */
export const retryKeySchema = z.uuid();

export interface LineReplyRequest {
  readonly replyToken: string;
  readonly messages: readonly LineTextMessage[];
}

export interface LinePushRequest {
  /** `userId`, `groupId` or `roomId`. */
  readonly to: string;
  readonly messages: readonly LineTextMessage[];
  /**
   * Makes the request safe to repeat for 24 hours after the first attempt: LINE answers a repeat
   * with 409 instead of sending again. Use the outbound delivery id (as a UUID), ADR-010.
   */
  readonly retryKey: string;
}

export interface LineSendResult {
  /** `X-Line-Request-Id`. */
  readonly requestId: string | null;
  readonly sentMessageIds: readonly string[];
  /** The retry key had already been accepted: nothing new was sent (HTTP 409 mapped to success). */
  readonly alreadyAccepted: boolean;
  /** `X-Line-Accepted-Request-Id` of the request that first succeeded, when `alreadyAccepted`. */
  readonly acceptedRequestId: string | null;
}

export type LineContentResult =
  | { readonly status: 'ready'; readonly bytes: Uint8Array; readonly contentType: string | null }
  /** HTTP 202: a large video or audio is still being prepared. Try again shortly. */
  | { readonly status: 'preparing' };

export interface LineTransport {
  /**
   * Free, but the token works once and only for about a minute. Rejects with a `ChannelError`
   * whose `code` is `invalid_reply_token` when it is spent or expired. Never auto-retried after an
   * unknown outcome.
   */
  reply(request: LineReplyRequest): Promise<LineSendResult>;
  /** Counts against the monthly quota. Safe to retry with the same `retryKey`. */
  push(request: LinePushRequest): Promise<LineSendResult>;
  /** `GET /v2/bot/message/quota` */
  getQuota(): Promise<LineQuotaResponse>;
  /** `GET /v2/bot/message/quota/consumption` (approximate, includes Official Account Manager sends). */
  getConsumption(): Promise<LineConsumptionResponse>;
  /** `GET api-data.line.me/v2/bot/message/{id}/content`. Content is deleted after an unspecified time. */
  getContent(messageId: string): Promise<LineContentResult>;
  /** `POST /v2/bot/chat/markAsRead` (R-2.13). */
  markAsRead(request: { readonly markAsReadToken: string }): Promise<void>;
  /** `POST /v2/bot/chat/loading/start`: 5 to 60 seconds in steps of 5, one-to-one chats only. */
  showLoadingAnimation(request: {
    readonly chatId: string;
    readonly loadingSeconds?: number;
  }): Promise<void>;
}

export const LOADING_SECONDS = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60] as const;

export const loadingAnimationSchema = z.object({
  chatId: z.string().min(1),
  loadingSeconds: z
    .number()
    .int()
    .refine((value) => (LOADING_SECONDS as readonly number[]).includes(value))
    .optional(),
});

/** Response of reply and push: `sentMessages[].id`. */
export const lineSendResponseSchema = z.looseObject({
  sentMessages: z.array(z.looseObject({ id: z.string() })).optional(),
});
