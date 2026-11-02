import { Inject, Injectable } from '@nestjs/common';
import { STATUSPAGE_AUDIT_ACTIONS } from '@watchtower/shared';

import { AuditScope } from '../audit/audit-scope.js';
import { RateLimitedError } from '../auth/http-errors.js';
import { RateLimiter, type RateLimitResult } from '../auth/rate-limiter.js';

const HOUR = 3600;
const TEN_MINUTES = 600;

/** The part of `RateLimiter` this class needs, so a unit test can count without Redis. */
export interface HitCounter {
  hit(
    scope: string,
    subject: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitResult>;
}

export type StatusLimitScope = 'read-ip' | 'subscribe-ip' | 'subscribe-email' | 'link-ip';

/**
 * What each scope allows per window `[ASSUMED]`. Subscribing is the one that costs something outside
 * (an email to an address the caller chose), so it is tight both per caller and per address: nobody can
 * make the page mail a stranger more than a few times an hour, and one address cannot be used to flood.
 */
export const STATUS_LIMIT_POLICY: Readonly<
  Record<StatusLimitScope, { readonly limit: number; readonly windowSeconds: number }>
> = {
  'read-ip': { limit: 300, windowSeconds: TEN_MINUTES },
  'subscribe-ip': { limit: 5, windowSeconds: HOUR },
  'subscribe-email': { limit: 3, windowSeconds: HOUR },
  'link-ip': { limit: 30, windowSeconds: HOUR },
};

/**
 * Limits of the public status endpoints. Every attempt counts. A refusal is written to the audit log
 * (`status_subscription.rate_limited`, outcome `denied`, naming the scope but neither the address nor the
 * email) and answered 429 with `Retry-After`. Subjects are hashed by `RateLimiter`. If Redis is down the
 * call rejects and the endpoint fails closed.
 */
@Injectable()
export class StatusLimits {
  constructor(@Inject(RateLimiter) private readonly counter: HitCounter) {}

  async enforce(scope: StatusLimitScope, subject: string): Promise<void> {
    const { limit, windowSeconds } = STATUS_LIMIT_POLICY[scope];
    const result = await this.counter.hit(`status-${scope}`, subject, limit, windowSeconds);
    if (!result.allowed) {
      AuditScope.set({
        action: STATUSPAGE_AUDIT_ACTIONS.subscriptionRateLimited,
        outcome: 'denied',
        metadata: { scope, retryAfterSeconds: result.retryAfterSeconds },
      });
      throw new RateLimitedError(result.retryAfterSeconds);
    }
  }
}
