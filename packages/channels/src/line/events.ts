import { z } from 'zod';

import type { RawBody } from './signature.js';

/**
 * LINE webhook body -> normalised events (R-2.9, R-2.12).
 *
 * Field names follow the Messaging API reference "Webhook event objects"
 * (https://developers.line.biz/en/reference/messaging-api/#webhook-event-objects, read 2026-10-31).
 * One request carries several events; each becomes one normalised event with its own
 * `providerEventId` (`webhookEventId`, a ULID) so the receiver can write one dedupe row per event
 * (ADR-009 section 1). An event that does not fit the schema is reported in `rejected` by index
 * (never with its content) and does not fail the others: the receiver still answers 200.
 */

export class LineWebhookParseError extends Error {
  constructor() {
    super('LINE webhook body is not a JSON object with an events array');
    this.name = 'LineWebhookParseError';
  }
}

const sourceSchema = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('user'), userId: z.string().min(1) }),
  z.looseObject({
    type: z.literal('group'),
    groupId: z.string().min(1),
    userId: z.string().min(1).optional(),
  }),
  z.looseObject({
    type: z.literal('room'),
    roomId: z.string().min(1),
    userId: z.string().min(1).optional(),
  }),
]);

const commonSchema = z.looseObject({
  type: z.string().min(1),
  webhookEventId: z.string().min(1),
  timestamp: z.number().int().nonnegative(),
  mode: z.string().default('active'),
  deliveryContext: z.looseObject({ isRedelivery: z.boolean() }).optional(),
  source: sourceSchema.optional(),
  replyToken: z.string().min(1).optional(),
});

const contentProviderSchema = z.looseObject({ type: z.enum(['line', 'external']) }).optional();

const messageBase = {
  id: z.string().min(1),
  quoteToken: z.string().optional(),
  markAsReadToken: z.string().optional(),
};

const messageSchema = z.discriminatedUnion('type', [
  z.looseObject({ ...messageBase, type: z.literal('text'), text: z.string() }),
  z.looseObject({
    ...messageBase,
    type: z.literal('image'),
    contentProvider: contentProviderSchema,
    imageSet: z
      .looseObject({
        id: z.string(),
        index: z.number().int().optional(),
        total: z.number().int().optional(),
      })
      .optional(),
  }),
  z.looseObject({
    ...messageBase,
    type: z.literal('video'),
    duration: z.number().optional(),
    contentProvider: contentProviderSchema,
  }),
  z.looseObject({
    ...messageBase,
    type: z.literal('audio'),
    duration: z.number().optional(),
    contentProvider: contentProviderSchema,
  }),
  z.looseObject({
    ...messageBase,
    type: z.literal('file'),
    fileName: z.string(),
    fileSize: z.number().int().nonnegative(),
  }),
  z.looseObject({
    ...messageBase,
    type: z.literal('location'),
    title: z.string().optional(),
    address: z.string().optional(),
    latitude: z.number(),
    longitude: z.number(),
  }),
  z.looseObject({
    ...messageBase,
    type: z.literal('sticker'),
    packageId: z.string(),
    stickerId: z.string(),
    stickerResourceType: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    text: z.string().optional(),
  }),
]);

const messageEventSchema = commonSchema.extend({ message: z.looseObject({ type: z.string() }) });
const followEventSchema = commonSchema.extend({
  follow: z.looseObject({ isUnblocked: z.boolean().optional() }).optional(),
});

// -- normalised output ---------------------------------------------------------------------------

export const lineSourceSchema = z.object({
  kind: z.enum(['user', 'group', 'room']),
  /** The sender. In a group or room it is absent when the user has not consented to share it. */
  userId: z.string().nullable(),
  groupId: z.string().nullable(),
  roomId: z.string().nullable(),
  /** The conversation to reply to or push into: `groupId`, else `roomId`, else `userId`. */
  conversationId: z.string(),
});

export const lineContentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('image'),
    /** `line`: fetch with `getContent`. `external`: the bytes are not on LINE; never fetched here. */
    provider: z.enum(['line', 'external']),
    imageSetId: z.string().nullable(),
  }),
  z.object({
    type: z.literal('video'),
    provider: z.enum(['line', 'external']),
    durationMs: z.number().nullable(),
  }),
  z.object({
    type: z.literal('audio'),
    provider: z.enum(['line', 'external']),
    durationMs: z.number().nullable(),
  }),
  z.object({
    type: z.literal('file'),
    fileName: z.string(),
    fileSize: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('location'),
    title: z.string().nullable(),
    address: z.string().nullable(),
    latitude: z.number(),
    longitude: z.number(),
  }),
  z.object({
    type: z.literal('sticker'),
    packageId: z.string(),
    stickerId: z.string(),
    resourceType: z.string().nullable(),
    keywords: z.array(z.string()),
  }),
  /** A message type this version does not know. Stored by id, content ignored. */
  z.object({ type: z.literal('unsupported'), messageType: z.string() }),
]);

const eventBase = {
  /** `webhookEventId` (ULID): the dedupe key (R-2.9). */
  providerEventId: z.string().min(1),
  /** When the event happened (also for a redelivery), ISO-8601. */
  occurredAt: z.string(),
  isRedelivery: z.boolean(),
  /** `standby`: another module owns the conversation; the bot must not send anything. */
  mode: z.enum(['active', 'standby']),
  source: lineSourceSchema.nullable(),
  /** Single-use; valid for about a minute (`replyTokenTtlMs` in `router.ts`). Null in standby mode. */
  replyToken: z.string().nullable(),
};

export const normalizedLineEventSchema = z.discriminatedUnion('kind', [
  z.object({
    ...eventBase,
    kind: z.literal('message'),
    messageId: z.string(),
    quoteToken: z.string().nullable(),
    /** No expiry; used to mark messages up to this one as read (R-2.13). */
    markAsReadToken: z.string().nullable(),
    content: lineContentSchema,
  }),
  z.object({ ...eventBase, kind: z.literal('follow'), isUnblocked: z.boolean() }),
  z.object({ ...eventBase, kind: z.literal('unfollow') }),
  /** join, leave, postback, memberJoined ... : recorded for dedupe, not acted on in Phase 1. */
  z.object({ ...eventBase, kind: z.literal('unsupported'), eventType: z.string() }),
]);

export type NormalizedLineEvent = z.infer<typeof normalizedLineEventSchema>;
export type LineContent = z.infer<typeof lineContentSchema>;

export interface RejectedLineEvent {
  readonly index: number;
  readonly reason: 'invalid_event' | 'missing_event_id';
}

export interface ParsedLineWebhook {
  /** The bot's own user id (`destination`), when present. */
  readonly destination: string | null;
  readonly events: readonly NormalizedLineEvent[];
  readonly rejected: readonly RejectedLineEvent[];
}

function toSource(source: z.infer<typeof sourceSchema> | undefined): NormalizedLineEvent['source'] {
  if (source === undefined) return null;
  switch (source.type) {
    case 'user':
      return {
        kind: 'user',
        userId: source.userId,
        groupId: null,
        roomId: null,
        conversationId: source.userId,
      };
    case 'group':
      return {
        kind: 'group',
        userId: source.userId ?? null,
        groupId: source.groupId,
        roomId: null,
        conversationId: source.groupId,
      };
    case 'room':
      return {
        kind: 'room',
        userId: source.userId ?? null,
        groupId: null,
        roomId: source.roomId,
        conversationId: source.roomId,
      };
  }
}

function toContent(message: z.infer<typeof messageSchema>): LineContent {
  switch (message.type) {
    case 'text':
      return { type: 'text', text: message.text };
    case 'image':
      return {
        type: 'image',
        provider: message.contentProvider?.type ?? 'line',
        imageSetId: message.imageSet?.id ?? null,
      };
    case 'video':
      return {
        type: 'video',
        provider: message.contentProvider?.type ?? 'line',
        durationMs: message.duration ?? null,
      };
    case 'audio':
      return {
        type: 'audio',
        provider: message.contentProvider?.type ?? 'line',
        durationMs: message.duration ?? null,
      };
    case 'file':
      return { type: 'file', fileName: message.fileName, fileSize: message.fileSize };
    case 'location':
      return {
        type: 'location',
        title: message.title ?? null,
        address: message.address ?? null,
        latitude: message.latitude,
        longitude: message.longitude,
      };
    case 'sticker':
      return {
        type: 'sticker',
        packageId: message.packageId,
        stickerId: message.stickerId,
        resourceType: message.stickerResourceType ?? null,
        keywords: message.keywords ?? [],
      };
  }
}

export function normalizeLineEvent(
  input: unknown,
): NormalizedLineEvent | RejectedLineEvent['reason'] {
  const common = commonSchema.safeParse(input);
  if (!common.success) {
    const hasId =
      typeof input === 'object' &&
      input !== null &&
      'webhookEventId' in input &&
      typeof input.webhookEventId === 'string' &&
      input.webhookEventId !== '';
    return hasId ? 'invalid_event' : 'missing_event_id';
  }
  const event = common.data;
  const mode = event.mode === 'active' ? 'active' : 'standby';
  const base = {
    providerEventId: event.webhookEventId,
    occurredAt: new Date(event.timestamp).toISOString(),
    isRedelivery: event.deliveryContext?.isRedelivery ?? false,
    mode,
    source: toSource(event.source),
    // A standby channel gets no token; never use one that appears anyway.
    replyToken: mode === 'active' ? (event.replyToken ?? null) : null,
  } as const;

  switch (event.type) {
    case 'message': {
      const wrapper = messageEventSchema.safeParse(input);
      if (!wrapper.success) return 'invalid_event';
      const known = messageSchema.safeParse(wrapper.data.message);
      const raw = wrapper.data.message;
      const id = typeof raw['id'] === 'string' ? raw['id'] : '';
      if (id === '') return 'invalid_event';
      const text = (key: string): string | null => (typeof raw[key] === 'string' ? raw[key] : null);
      if (!known.success) {
        // A known type with a bad shape is rejected; a type we have never heard of is kept.
        if (['text', 'image', 'video', 'audio', 'file', 'location', 'sticker'].includes(raw.type)) {
          return 'invalid_event';
        }
        return {
          ...base,
          kind: 'message',
          messageId: id,
          quoteToken: text('quoteToken'),
          markAsReadToken: text('markAsReadToken'),
          content: { type: 'unsupported', messageType: raw.type },
        };
      }
      return {
        ...base,
        kind: 'message',
        messageId: known.data.id,
        quoteToken: known.data.quoteToken ?? null,
        markAsReadToken: known.data.markAsReadToken ?? null,
        content: toContent(known.data),
      };
    }
    case 'follow': {
      const parsed = followEventSchema.safeParse(input);
      if (!parsed.success) return 'invalid_event';
      return { ...base, kind: 'follow', isUnblocked: parsed.data.follow?.isUnblocked ?? false };
    }
    case 'unfollow':
      return { ...base, kind: 'unfollow' };
    default:
      return { ...base, kind: 'unsupported', eventType: event.type };
  }
}

const envelopeSchema = z.looseObject({
  destination: z.string().optional(),
  events: z.array(z.unknown()),
});

/**
 * Parses a verified webhook body. Call `verifyLineSignature` on the same bytes first. An empty
 * `events` array is valid: it is what the LINE console's "Verify" button sends.
 */
export function parseLineWebhook(rawBody: RawBody): ParsedLineWebhook {
  const text = typeof rawBody === 'string' ? rawBody : Buffer.from(rawBody).toString('utf8');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new LineWebhookParseError();
  }
  const envelope = envelopeSchema.safeParse(json);
  if (!envelope.success) throw new LineWebhookParseError();

  const events: NormalizedLineEvent[] = [];
  const rejected: RejectedLineEvent[] = [];
  for (const [index, raw] of envelope.data.events.entries()) {
    const result = normalizeLineEvent(raw);
    if (typeof result === 'string') {
      rejected.push({ index, reason: result });
      continue;
    }
    events.push(normalizedLineEventSchema.parse(result));
  }
  return { destination: envelope.data.destination ?? null, events, rejected };
}
