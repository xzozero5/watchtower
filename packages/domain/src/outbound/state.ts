import { createHash } from 'node:crypto';

import {
  DELIVERY_BACKOFF_CAP_SECONDS,
  DELIVERY_MAX_ATTEMPTS,
  DELIVERY_RETRY_AFTER_CAP_SECONDS,
  type DeliveryState,
} from '@watchtower/shared';

/**
 * The delivery state machine and the retry rules of ADR-010, without a database or a clock.
 *
 *   scheduled -> sending            claim (compare-and-set), only when the hold has ended
 *   scheduled -> cancelled          undo, or the policy gate refused at claim time
 *   sending   -> sent               the provider accepted the message
 *   sending   -> scheduled          provably not sent, retry later (backoff)
 *   sending   -> failed             not sent and not worth retrying, or the outcome is unknown
 *   sending   -> cancelled          the policy gate or the content check refused after the claim
 *   failed    -> sent               only for `outcome_unknown`: the provider answered late (see `recordSent`)
 */
const TRANSITIONS: Readonly<Record<DeliveryState, readonly DeliveryState[]>> = {
  scheduled: ['sending', 'cancelled'],
  sending: ['sent', 'failed', 'scheduled', 'cancelled'],
  sent: [],
  failed: ['sent'],
  cancelled: [],
};

export function canTransition(from: DeliveryState, to: DeliveryState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** A state nothing leaves (except the late-answer exception noted above). */
export function isFinal(state: DeliveryState): boolean {
  return state === 'sent' || state === 'cancelled' || state === 'failed';
}

/** sha256 of the exact text, hex: what `ai_draft.content_hash` is in the database. */
export function contentHash(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/** Seconds to wait before attempt `attempts + 1`: 2^attempts, at most 5 minutes (ADR-010 section 6). */
export function backoffSeconds(attempts: number): number {
  return Math.min(DELIVERY_BACKOFF_CAP_SECONDS, 2 ** Math.max(0, attempts));
}

/** What a failed provider call tells us, as plain data (the worker reads it off a `ChannelError`). */
export interface FailureFacts {
  /** `ChannelFailureKind` of `packages/channels`, or `unavailable` when there was nothing to call. */
  readonly kind: string;
  /** Trying again later can succeed (`ChannelError.retryable`). */
  readonly retryable: boolean;
  /** The provider may have acted on the request (`ChannelError.outcomeUnknown`). */
  readonly outcomeUnknown: boolean;
  readonly retryAfterMs?: number | undefined;
}

export type FailureDecision =
  | {
      readonly action: 'retry';
      readonly delaySeconds: number;
      /**
       * Why this attempt did not go through (`channel_<kind>`). Stored on the row: the database lets a
       * delivery that reached the provider go back to `scheduled` only with a refusal on record.
       */
      readonly errorCode?: string;
    }
  | {
      readonly action: 'fail';
      readonly errorCode: string;
      readonly outcomeUnknown: boolean;
    };

/**
 * A provider's `Retry-After` in whole seconds, never more than `DELIVERY_RETRY_AFTER_CAP_SECONDS`. A
 * missing, negative or NaN value counts as none (the header is the provider's, not ours).
 */
export function retryAfterSeconds(retryAfterMs: number | undefined): number {
  if (retryAfterMs === undefined || Number.isNaN(retryAfterMs) || retryAfterMs <= 0) return 0;
  // Infinity (a header too long for a number) lands on the cap too.
  return Math.min(DELIVERY_RETRY_AFTER_CAP_SECONDS, Math.ceil(retryAfterMs / 1000));
}

/** Only a LINE push carries a provider idempotency key, so only it may repeat after an unknown outcome. */
export function hasIdempotencyKey(route: string | null): boolean {
  return route === 'line_push';
}

/**
 * Retry or give up (ADR-010 section 6). Automatic retry is for "certainly not sent" (429 with
 * Retry-After, nothing reached the provider) or for a route with an idempotency key. An unknown
 * outcome on Gmail or on a LINE reply is never repeated by a machine: the customer would get two.
 * `attempts` counts the attempts used so far, this one included.
 */
export function decideFailure(
  facts: FailureFacts,
  context: { readonly route: string | null; readonly attempts: number },
): FailureDecision {
  const code = `channel_${facts.kind}`;
  const exhausted = context.attempts >= DELIVERY_MAX_ATTEMPTS;
  const delay = (): number =>
    Math.max(backoffSeconds(context.attempts), retryAfterSeconds(facts.retryAfterMs));

  if (facts.outcomeUnknown) {
    if (hasIdempotencyKey(context.route) && !exhausted) {
      return { action: 'retry', delaySeconds: delay(), errorCode: code };
    }
    return { action: 'fail', errorCode: code, outcomeUnknown: true };
  }
  if (facts.retryable && !exhausted) {
    return { action: 'retry', delaySeconds: delay(), errorCode: code };
  }
  return { action: 'fail', errorCode: code, outcomeUnknown: false };
}

/**
 * True when the LINE retry key of a delivery may no longer be remembered by LINE. The key is first sent
 * with the first push, which is never before the delivery was created, so the age of the row is a safe
 * (early) upper bound for the age of the key.
 */
export function retryKeyExpired(createdAt: Date, now: Date, maxAgeSeconds: number): boolean {
  return now.getTime() - createdAt.getTime() >= maxAgeSeconds * 1000;
}

/**
 * The BullMQ job id of a trigger: one per delivery and attempt, so a repeated enqueue is one job.
 * BullMQ does not allow `:` in a custom id.
 */
export function dispatchJobId(deliveryId: string, attempt: number): string {
  return `delivery-${deliveryId}-${String(attempt)}`;
}
