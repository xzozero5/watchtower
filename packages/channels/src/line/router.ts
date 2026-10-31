import { z } from 'zod';

import {
  DEFAULT_QUOTA_WARN_PERCENT,
  canSpend,
  evaluateQuota,
  type QuotaSnapshot,
  type QuotaView,
} from './quota.js';

/**
 * Reply-vs-push router (R-2.10, ADR-010 section 6). A pure function: the dispatcher reads the
 * stored token state and the quota counter inside its claim transaction, calls this, and acts on
 * the decision. Nothing here reads a clock, a database or the network.
 *
 * A reply token is free but single-use and short-lived. LINE: "Reply tokens must be used within
 * one minute after receiving the webhook. Use beyond one minute isn't guaranteed to work", the
 * limit "is subject to change without notice" and a token in a redelivered webhook is also good for
 * one minute after the redelivery arrived, but not after 20 minutes from the event
 * (https://developers.line.biz/en/reference/messaging-api/#send-reply-message, read 2026-10-31).
 * `[VERIFY]` the exact window with a real account before relying on it, so the TTL is
 * configuration and the default is deliberately below a minute (ADR-010 assumed 50 s).
 */

export const routerConfigSchema = z.object({
  /** How long after receipt a token is still used. Default 50 s. */
  replyTokenTtlMs: z.number().int().min(1_000).max(60_000).default(50_000),
  /** Extra headroom for the HTTP call itself: the token must still be valid at `now + margin`. */
  replyTokenSafetyMarginMs: z.number().int().min(0).max(30_000).default(3_000),
  warnPercent: z.number().min(1).max(100).default(DEFAULT_QUOTA_WARN_PERCENT),
});

export type LineRouterConfig = z.infer<typeof routerConfigSchema>;

export const DEFAULT_LINE_ROUTER_CONFIG: LineRouterConfig = routerConfigSchema.parse({});

export interface StoredReplyToken {
  /** When the webhook carrying the token was received (not when the event happened). */
  readonly receivedAt: Date;
  /** Already spent: a token works once. */
  readonly used: boolean;
}

export interface RouteInput {
  readonly now: Date;
  /** null: the conversation has no token (no inbound event, standby mode, or token already cleared). */
  readonly replyToken: StoredReplyToken | null;
  readonly quota: QuotaSnapshot;
  /** Counted messages a push would cost: 1 for a one-to-one chat, the member count for a group. */
  readonly recipients?: number;
  /**
   * `allow`: a human reply may fall back to push. `deny`: an instant auto-ack must not (ADR-010:
   * an ack that arrives late is not worth quota).
   */
  readonly pushFallback: 'allow' | 'deny';
  readonly config?: Partial<LineRouterConfig>;
}

export type TokenProblem = 'no_reply_token' | 'reply_token_used' | 'reply_token_expired';

export type RouteDecision =
  | {
      readonly route: 'reply';
      readonly reason: 'reply_token_valid';
      /** The router treats the token as unusable from this instant on. */
      readonly tokenUsableUntil: Date;
      readonly quota: QuotaView;
    }
  | {
      readonly route: 'push';
      readonly reason: TokenProblem;
      /** Quota level after this push would be counted is `warn` or worse: show the warning (R-2.10). */
      readonly quotaWarning: boolean;
      readonly quota: QuotaView;
    }
  | {
      readonly route: 'none';
      /** `quota_exhausted`: suggest email (PRD section 8.3). `push_not_allowed`: policy forbids push. */
      readonly reason: 'quota_exhausted' | 'push_not_allowed';
      readonly tokenProblem: TokenProblem;
      readonly suggestFallback: 'email' | null;
      readonly quota: QuotaView;
    };

function tokenProblem(
  token: StoredReplyToken | null,
  now: Date,
  config: LineRouterConfig,
): { readonly problem: TokenProblem } | { readonly usableUntil: Date } {
  if (token === null) return { problem: 'no_reply_token' };
  if (token.used) return { problem: 'reply_token_used' };
  const expiresAt = token.receivedAt.getTime() + config.replyTokenTtlMs;
  if (now.getTime() + config.replyTokenSafetyMarginMs >= expiresAt) {
    return { problem: 'reply_token_expired' };
  }
  return { usableUntil: new Date(expiresAt - config.replyTokenSafetyMarginMs) };
}

export function decideLineRoute(input: RouteInput): RouteDecision {
  const config = routerConfigSchema.parse(input.config ?? {});
  const recipients = input.recipients ?? 1;
  const quota = evaluateQuota(input.quota, config.warnPercent);
  const token = tokenProblem(input.replyToken, input.now, config);

  if ('usableUntil' in token) {
    return {
      route: 'reply',
      reason: 'reply_token_valid',
      tokenUsableUntil: token.usableUntil,
      quota,
    };
  }
  if (input.pushFallback === 'deny') {
    return {
      route: 'none',
      reason: 'push_not_allowed',
      tokenProblem: token.problem,
      suggestFallback: null,
      quota,
    };
  }
  if (!canSpend(input.quota, recipients)) {
    return {
      route: 'none',
      reason: 'quota_exhausted',
      tokenProblem: token.problem,
      suggestFallback: 'email',
      quota,
    };
  }
  const after = evaluateQuota(
    { used: input.quota.used + recipients, limit: input.quota.limit },
    config.warnPercent,
  );
  return {
    route: 'push',
    reason: token.problem,
    quotaWarning: after.level === 'warn' || after.level === 'exhausted',
    quota,
  };
}
