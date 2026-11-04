import { b64urlDecode } from './base64url.js';
import { PayloadTooLargeError, encryptMessage } from './encrypt.js';
import { checkPushEndpoint } from './endpoint.js';
import { vapidAuthorization, type VapidKeys } from './vapid.js';

export type PushUrgency = 'very-low' | 'low' | 'normal' | 'high';

export interface PushSubscriptionInput {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

export interface PushOptions {
  /** Seconds the push service keeps the message for an offline browser (RFC 8030 section 5.2). Required by the protocol. */
  readonly ttlSeconds: number;
  readonly urgency: PushUrgency;
  /** A newer message with the same topic replaces one still waiting (RFC 8030 section 5.4): 1 to 32 characters of base64url. */
  readonly topic?: string;
}

export interface PushRequest {
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
}

const TOPIC = /^[A-Za-z0-9_-]{1,32}$/;

/** The subscription or the options cannot make a valid request; retrying the same input cannot help. */
export class PushRequestError extends Error {
  constructor(
    readonly reason: 'endpoint' | 'keys' | 'topic',
    detail: string,
  ) {
    super(`push request refused: ${detail}`);
    this.name = 'PushRequestError';
  }
}

/**
 * Everything of one push request except sending it: the endpoint is checked against the allow-list,
 * the message is encrypted for the subscription, and the headers (VAPID, TTL, Urgency, Topic) are set.
 */
export function buildPushRequest(args: {
  readonly subscription: PushSubscriptionInput;
  readonly payload: Uint8Array;
  readonly options: PushOptions;
  readonly vapid: { readonly keys: VapidKeys; readonly subject: string };
  readonly nowMs: number;
}): PushRequest {
  const checked = checkPushEndpoint(args.subscription.endpoint);
  if (!checked.ok) throw new PushRequestError('endpoint', checked.reason);
  if (args.options.topic !== undefined && !TOPIC.test(args.options.topic)) {
    throw new PushRequestError('topic', 'invalid');
  }
  let body: Buffer;
  try {
    body = encryptMessage({
      plaintext: args.payload,
      uaPublic: b64urlDecode(args.subscription.p256dh),
      authSecret: b64urlDecode(args.subscription.auth),
    }).body;
  } catch (error) {
    if (error instanceof PayloadTooLargeError) throw error;
    throw new PushRequestError('keys', 'unusable p256dh or auth');
  }
  const headers: Record<string, string> = {
    Authorization: vapidAuthorization({
      keys: args.vapid.keys,
      subject: args.vapid.subject,
      audience: checked.url.origin,
      nowMs: args.nowMs,
    }),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(body.length),
    TTL: String(Math.max(0, Math.floor(args.options.ttlSeconds))),
    Urgency: args.options.urgency,
  };
  if (args.options.topic !== undefined) headers.Topic = args.options.topic;
  return { url: checked.url, headers, body };
}

/**
 * What a push service's answer means (RFC 8030 section 5, RFC 8292 section 3):
 *  - 2xx (201): accepted;
 *  - 404, 410: the subscription is gone, delete it;
 *  - 429 and 5xx: try again later (`retryAfterSeconds` from `Retry-After` when it is a number of seconds);
 *  - everything else (400, 401, 403, 413 ...): the request is wrong for this subscription, sending the
 *    same thing again cannot help.
 */
export type PushOutcome =
  | { readonly kind: 'sent' }
  | { readonly kind: 'gone' }
  | { readonly kind: 'retry'; readonly retryAfterSeconds: number | null }
  | { readonly kind: 'rejected'; readonly status: number };

export function classifyPushResponse(status: number, retryAfter: string | undefined): PushOutcome {
  if (status >= 200 && status < 300) return { kind: 'sent' };
  if (status === 404 || status === 410) return { kind: 'gone' };
  if (status === 429 || status >= 500) {
    const seconds =
      retryAfter !== undefined && /^\d{1,7}$/.test(retryAfter) ? Number(retryAfter) : null;
    return { kind: 'retry', retryAfterSeconds: seconds };
  }
  return { kind: 'rejected', status };
}
