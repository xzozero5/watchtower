import { Inject, Injectable } from '@nestjs/common';
import { AUDIT_ACTIONS } from '@watchtower/shared';

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

export type CsatLimitScope = 'read-ip' | 'answer-ip' | 'answer-survey';

/** What each scope allows per window `[ASSUMED]`: a person answers a survey once, so these are generous for a person and tight for a script. */
export const CSAT_LIMIT_POLICY: Readonly<
  Record<CsatLimitScope, { readonly limit: number; readonly windowSeconds: number }>
> = {
  'read-ip': { limit: 60, windowSeconds: TEN_MINUTES },
  'answer-ip': { limit: 20, windowSeconds: HOUR },
  'answer-survey': { limit: 10, windowSeconds: HOUR },
};

/**
 * Limits of the public survey endpoints. Every attempt counts, valid or not, so guessing links is
 * throttled per address. A refusal is written to the audit log (`csat.rate_limited`, outcome
 * `denied`, naming the scope but neither the address nor the link) and answered 429 with
 * `Retry-After`. Subjects are hashed by `RateLimiter`. If Redis is down the call rejects and the
 * endpoint fails closed.
 */
@Injectable()
export class CsatLimits {
  constructor(@Inject(RateLimiter) private readonly counter: HitCounter) {}

  async enforce(scope: CsatLimitScope, subject: string): Promise<void> {
    const { limit, windowSeconds } = CSAT_LIMIT_POLICY[scope];
    const result = await this.counter.hit(`csat-${scope}`, subject, limit, windowSeconds);
    if (!result.allowed) {
      AuditScope.set({
        action: AUDIT_ACTIONS.csatRateLimited,
        outcome: 'denied',
        metadata: { scope, retryAfterSeconds: result.retryAfterSeconds },
      });
      throw new RateLimitedError(result.retryAfterSeconds);
    }
  }
}
