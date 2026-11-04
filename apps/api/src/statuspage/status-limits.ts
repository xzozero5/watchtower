import { Inject, Injectable, Logger } from '@nestjs/common';
import { STATUSPAGE_AUDIT_ACTIONS } from '@watchtower/shared';

import { AuditScope } from '../audit/audit-scope.js';
import { RateLimitedError } from '../auth/http-errors.js';
import { RateLimiter, type RateLimitResult } from '../auth/rate-limiter.js';
import { rateLimitClientKey } from '../http/client-ip.js';

const HOUR = 3600;
const TEN_MINUTES = 600;
const DAY = 86_400;

/** The part of `RateLimiter` this class needs, so a unit test can count without Redis. */
export interface HitCounter {
  hit(
    scope: string,
    subject: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitResult>;
}

export type StatusLimitScope =
  | 'read-ip'
  | 'challenge-ip'
  | 'subscribe-ip'
  | 'subscribe-email'
  | 'subscribe-domain'
  | 'subscribe-global-hour'
  | 'subscribe-global-day'
  | 'link-ip';

/** Scopes whose subject is the caller's address: counted by IPv4 address or IPv6 /64 (T-207a C-3). */
const IP_SCOPES: ReadonlySet<StatusLimitScope> = new Set([
  'read-ip',
  'challenge-ip',
  'subscribe-ip',
  'link-ip',
]);

/** Scopes that are a ceiling for the whole page: reaching one means an attack or a bug, so it is logged loudly. */
const GLOBAL_SCOPES: ReadonlySet<StatusLimitScope> = new Set([
  'subscribe-global-hour',
  'subscribe-global-day',
]);

/**
 * What each scope allows per window `[ASSUMED]`. Subscribing is the one that costs something outside
 * (an email to an address the caller chose), so it is tight both per caller and per address: nobody can
 * make the page mail a stranger more than a few times an hour, and one address cannot be used to flood.
 */
export const STATUS_LIMIT_POLICY: Readonly<
  Record<StatusLimitScope, { readonly limit: number; readonly windowSeconds: number }>
> = {
  'read-ip': { limit: 300, windowSeconds: TEN_MINUTES },
  'challenge-ip': { limit: 30, windowSeconds: HOUR },
  'subscribe-ip': { limit: 5, windowSeconds: HOUR },
  'subscribe-email': { limit: 3, windowSeconds: HOUR },
  // Confirmation emails to one receiving domain, whoever asks (a flood at one company's mail server). [ASSUMED]
  'subscribe-domain': { limit: 30, windowSeconds: HOUR },
  // Everything the page may mail in an hour and in a day, whatever the caller, address or domain. [ASSUMED]
  'subscribe-global-hour': { limit: 200, windowSeconds: HOUR },
  'subscribe-global-day': { limit: 1000, windowSeconds: DAY },
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
  private readonly logger = new Logger(StatusLimits.name);

  constructor(@Inject(RateLimiter) private readonly counter: HitCounter) {}

  async enforce(scope: StatusLimitScope, subject: string): Promise<void> {
    const { limit, windowSeconds } = STATUS_LIMIT_POLICY[scope];
    const key = IP_SCOPES.has(scope) ? rateLimitClientKey(subject) : subject;
    const result = await this.counter.hit(`status-${scope}`, key, limit, windowSeconds);
    if (!result.allowed) {
      if (GLOBAL_SCOPES.has(scope)) {
        // An operator wants to know: every confirmation email the page may send is spent (T-207a C-3).
        this.logger.error(
          `status page subscribe ceiling reached (${scope}, limit ${String(limit)} per ${String(windowSeconds)} s): possible mail flood`,
        );
      }
      AuditScope.set({
        action: STATUSPAGE_AUDIT_ACTIONS.subscriptionRateLimited,
        outcome: 'denied',
        metadata: { scope, retryAfterSeconds: result.retryAfterSeconds },
      });
      throw new RateLimitedError(result.retryAfterSeconds);
    }
  }
}
