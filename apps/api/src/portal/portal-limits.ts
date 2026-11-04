import { Inject, Injectable } from '@nestjs/common';
import { AUDIT_ACTIONS } from '@watchtower/shared';

import { AuditScope } from '../audit/audit-scope.js';
import { RateLimitedError } from '../auth/http-errors.js';
import { RateLimiter, type RateLimitResult } from '../auth/rate-limiter.js';
import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { rateLimitClientKey } from '../http/client-ip.js';

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

export type PortalLimitScope =
  | 'challenge-ip'
  | 'submit-ip'
  | 'submit-email'
  | 'submit-org'
  | 'upload-ip'
  | 'read-ip'
  | 'reply-ip'
  | 'reply-ticket'
  | 'reply-confirm'
  | 'resend-ip'
  | 'resend-email'
  // "Email me a link to my requests" (T-152). `mine-ip` and `mine-open-ip` count the /64 of an IPv6
  // address as one client; the email, domain and global limits are answered silently (always 202).
  | 'mine-ip'
  | 'mine-email'
  | 'mine-domain'
  | 'mine-global'
  | 'mine-open-ip';

/** Scopes whose subject is a client address: counted per IPv4 address or IPv6 /64 (T-207a C-3). */
const CLIENT_ADDRESS_SCOPES: ReadonlySet<PortalLimitScope> = new Set(['mine-ip', 'mine-open-ip']);

/** What each scope allows, per window. The three submit limits come from the environment. */
export function portalLimitPolicy(
  config: Pick<
    ApiConfig,
    'PORTAL_RATE_IP_PER_HOUR' | 'PORTAL_RATE_EMAIL_PER_HOUR' | 'PORTAL_RATE_ORG_PER_HOUR'
  >,
): Readonly<Record<PortalLimitScope, { readonly limit: number; readonly windowSeconds: number }>> {
  return {
    'challenge-ip': { limit: 60, windowSeconds: TEN_MINUTES },
    'submit-ip': { limit: config.PORTAL_RATE_IP_PER_HOUR, windowSeconds: HOUR },
    'submit-email': { limit: config.PORTAL_RATE_EMAIL_PER_HOUR, windowSeconds: HOUR },
    'submit-org': { limit: config.PORTAL_RATE_ORG_PER_HOUR, windowSeconds: HOUR },
    // Requests that carry files (T-140), counted before the body is read. `[ASSUMED]`: a person
    // sends a handful of screenshots an hour; more is a script filling storage.
    'upload-ip': { limit: 30, windowSeconds: HOUR },
    'read-ip': { limit: 240, windowSeconds: TEN_MINUTES },
    'reply-ip': { limit: 30, windowSeconds: HOUR },
    'reply-ticket': { limit: 10, windowSeconds: HOUR },
    // One "we got your reply" email per ticket per 10 minutes, so replies cannot become a mail stream.
    'reply-confirm': { limit: 1, windowSeconds: TEN_MINUTES },
    'resend-ip': { limit: 10, windowSeconds: HOUR },
    'resend-email': { limit: 3, windowSeconds: HOUR },
    // `[ASSUMED]` numbers. A person asks once or twice an hour; the domain limit is loose because a
    // free-mail domain is shared by everyone who uses it; the global ceiling is the most "my requests"
    // emails this instance sends per hour whoever asks, so it can never become a mail flood.
    'mine-ip': { limit: 10, windowSeconds: HOUR },
    'mine-email': { limit: 3, windowSeconds: HOUR },
    'mine-domain': { limit: 60, windowSeconds: HOUR },
    'mine-global': { limit: 300, windowSeconds: HOUR },
    'mine-open-ip': { limit: 30, windowSeconds: HOUR },
  };
}

/**
 * The per-IP / per-email / per-organization limits of the public portal (ADR-007). A refusal is
 * written to the audit log (`portal.rate_limited`, outcome `denied`, naming the scope but not the
 * address) and answered 429 with `Retry-After`. Subjects are hashed by `RateLimiter`, so Redis
 * holds no address. If Redis is down the call rejects and the endpoint fails closed.
 */
@Injectable()
export class PortalLimits {
  private readonly policy: ReturnType<typeof portalLimitPolicy>;

  constructor(
    @Inject(APP_CONFIG) config: ApiConfig,
    @Inject(RateLimiter) private readonly counter: HitCounter,
  ) {
    this.policy = portalLimitPolicy(config);
  }

  /** Counts one hit; throws RateLimitedError (429) once the scope's limit is exceeded. */
  async enforce(scope: PortalLimitScope, subject: string): Promise<void> {
    const result = await this.hit(scope, subject);
    if (!result.allowed) {
      AuditScope.set({
        action: AUDIT_ACTIONS.portalRateLimited,
        outcome: 'denied',
        metadata: { scope, retryAfterSeconds: result.retryAfterSeconds },
      });
      throw new RateLimitedError(result.retryAfterSeconds);
    }
  }

  /** Counts one hit and reports instead of throwing (for work that must stay silent). */
  hit(scope: PortalLimitScope, subject: string): Promise<RateLimitResult> {
    const { limit, windowSeconds } = this.policy[scope];
    const key = CLIENT_ADDRESS_SCOPES.has(scope) ? rateLimitClientKey(subject) : subject;
    return this.counter.hit(`portal-${scope}`, key, limit, windowSeconds);
  }
}
