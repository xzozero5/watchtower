import { createHmac, timingSafeEqual } from 'node:crypto';

import { ALERT_WEBHOOK_TOLERANCE_SECONDS } from '@watchtower/shared';

/**
 * Signature of the generic alert webhook (R-3.3, ADR-015 section 2).
 *
 * `X-Watchtower-Signature: t=<unix seconds>,v1=<hex>` where `v1` is HMAC-SHA256, keyed with the
 * shared secret, of the ASCII text `"<t>."` followed by the exact bytes of the request body. The
 * timestamp is part of what is signed, so a captured request cannot be replayed with a fresh `t`, and
 * a `t` more than `ALERT_WEBHOOK_TOLERANCE_SECONDS` away from the receiver's clock is refused. The
 * body must be the raw bytes as received; compare in constant time. Never log the secret, the header
 * or the body. (The `t=…,v1=…` shape follows the common webhook convention; it is this project's
 * own contract, not a provider's.)
 */

export type RawBody = string | Uint8Array;

/** `t=<unix>,v1=<hex>` for a body. For relays and tests; the receiver only verifies. */
export function signAlertWebhook(input: {
  readonly rawBody: RawBody;
  readonly secret: string;
  readonly timestampSeconds: number;
}): string {
  const mac = createHmac('sha256', input.secret)
    .update(`${String(input.timestampSeconds)}.`)
    .update(input.rawBody)
    .digest('hex');
  return `t=${String(input.timestampSeconds)},v1=${mac}`;
}

export type WebhookVerdict = 'ok' | 'malformed' | 'stale' | 'mismatch';

/**
 * `now` is the receiver's clock in epoch milliseconds, injected so a test needs no wall clock. This is
 * a freshness check on a number the sender wrote, not a decision shared between processes.
 */
export function verifyAlertWebhook(input: {
  readonly rawBody: RawBody;
  readonly header: string | null | undefined;
  readonly secret: string;
  readonly nowMs: number;
  readonly toleranceSeconds?: number;
}): WebhookVerdict {
  const { rawBody, header, secret } = input;
  if (secret === '' || header === null || header === undefined) return 'malformed';
  const match = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header.trim());
  if (match?.[1] === undefined || match[2] === undefined) return 'malformed';
  const timestampSeconds = Number(match[1]);
  const expected = Buffer.from(
    signAlertWebhook({ rawBody, secret, timestampSeconds }).slice(-64),
    'hex',
  );
  const received = Buffer.from(match[2], 'hex');
  // The signature is checked first so a wrong secret and a wrong time look the same to a prober.
  if (received.length !== expected.length || !timingSafeEqual(received, expected))
    return 'mismatch';
  const tolerance = input.toleranceSeconds ?? ALERT_WEBHOOK_TOLERANCE_SECONDS;
  return Math.abs(input.nowMs / 1000 - timestampSeconds) > tolerance ? 'stale' : 'ok';
}
