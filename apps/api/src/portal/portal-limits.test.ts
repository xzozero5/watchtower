import { AUDIT_ACTIONS } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import { AuditScope } from '../audit/audit-scope.js';
import { RateLimitedError } from '../auth/http-errors.js';
import type { RateLimitResult } from '../auth/rate-limiter.js';
import { testConfig } from '../testing/support.js';
import { PortalLimits, portalLimitPolicy, type HitCounter } from './portal-limits.js';

/** A counter with the semantics of RateLimiter (fixed window, hashed subject) and no Redis. */
class FakeCounter implements HitCounter {
  readonly counts = new Map<string, number>();
  readonly calls: { scope: string; subject: string; limit: number; windowSeconds: number }[] = [];
  hit(
    scope: string,
    subject: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitResult> {
    this.calls.push({ scope, subject, limit, windowSeconds });
    const key = `${scope}:${subject}`;
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    return Promise.resolve({ allowed: count <= limit, retryAfterSeconds: windowSeconds, count });
  }
}

const config = testConfig({
  PORTAL_RATE_IP_PER_HOUR: '3',
  PORTAL_RATE_EMAIL_PER_HOUR: '2',
  PORTAL_RATE_ORG_PER_HOUR: '5',
});

describe('portalLimitPolicy', () => {
  it('takes the three submit limits from the configuration and fixes the rest', () => {
    const policy = portalLimitPolicy(config);
    expect(policy['submit-ip']).toEqual({ limit: 3, windowSeconds: 3600 });
    expect(policy['submit-email']).toEqual({ limit: 2, windowSeconds: 3600 });
    expect(policy['submit-org']).toEqual({ limit: 5, windowSeconds: 3600 });
    expect(policy['reply-ticket'].limit).toBeGreaterThan(0);
    expect(policy['resend-email'].limit).toBe(3);
  });

  it('has defaults that are sane when nothing is set', () => {
    const policy = portalLimitPolicy(testConfig());
    expect(policy['submit-ip'].limit).toBe(20);
    expect(policy['submit-email'].limit).toBe(5);
    expect(policy['submit-org'].limit).toBe(60);
  });
});

describe('PortalLimits', () => {
  it('lets hits through up to the limit, then throws 429 with Retry-After seconds', async () => {
    const limits = new PortalLimits(config, new FakeCounter());
    await limits.enforce('submit-email', 'a@example.com');
    await limits.enforce('submit-email', 'a@example.com');
    const refused = await limits.enforce('submit-email', 'a@example.com').catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(RateLimitedError);
    expect((refused as RateLimitedError).getStatus()).toBe(429);
    expect((refused as RateLimitedError).retryAfterSeconds).toBe(3600);
  });

  it('counts each scope and each subject separately', async () => {
    const limits = new PortalLimits(config, new FakeCounter());
    await limits.enforce('submit-email', 'a@example.com');
    await limits.enforce('submit-email', 'a@example.com');
    await limits.enforce('submit-email', 'b@example.com');
    await limits.enforce('submit-ip', 'a@example.com');
    await expect(limits.enforce('submit-email', 'a@example.com')).rejects.toBeInstanceOf(
      RateLimitedError,
    );
  });

  it('writes the refusal to the audit scope, naming the scope but not the subject', async () => {
    const limits = new PortalLimits(config, new FakeCounter());
    const scope = new AuditScope();
    await AuditScope.run(scope, async () => {
      await limits.enforce('submit-org', 'org:1');
      for (let i = 0; i < 4; i += 1) await limits.enforce('submit-org', 'org:1');
      await limits.enforce('submit-org', 'org:1').catch(() => undefined);
    });
    const details = scope.read();
    expect(details.action).toBe(AUDIT_ACTIONS.portalRateLimited);
    expect(details.outcome).toBe('denied');
    expect(details.metadata).toMatchObject({ scope: 'submit-org' });
    expect(JSON.stringify(details)).not.toContain('org:1');
  });

  it('prefixes the scope so portal counters never collide with the auth ones', async () => {
    const counter = new FakeCounter();
    const limits = new PortalLimits(config, counter);
    await limits.enforce('read-ip', '10.0.0.1');
    expect(counter.calls[0]?.scope).toBe('portal-read-ip');
  });
});
