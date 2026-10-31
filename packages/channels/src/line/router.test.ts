import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_QUOTA_WARN_PERCENT,
  FALLBACK_QUOTA_LIMIT,
  canSpend,
  evaluateQuota,
  quotaPeriod,
  reconcileQuota,
  releaseQuota,
  reserveQuota,
  resolveQuotaLimit,
} from './quota.js';
import { DEFAULT_LINE_ROUTER_CONFIG, decideLineRoute, type RouteInput } from './router.js';

const net = disableNetConnect();
afterAll(() => {
  expect(net.blocked()).toEqual([]);
  net.restore();
});

const RECEIVED = new Date('2025-10-14T02:00:00Z');
const at = (secondsAfter: number): Date => new Date(RECEIVED.getTime() + secondsAfter * 1000);

function input(overrides: Partial<RouteInput> = {}): RouteInput {
  return {
    now: at(5),
    replyToken: { receivedAt: RECEIVED, used: false },
    quota: { used: 10, limit: 300 },
    pushFallback: 'allow',
    ...overrides,
  };
}

describe('decideLineRoute: reply token', () => {
  it('prefers the reply token while it is valid and unused, and does not touch quota', () => {
    const decision = decideLineRoute(input());
    expect(decision).toMatchObject({ route: 'reply', reason: 'reply_token_valid' });
    if (decision.route === 'reply') {
      expect(decision.tokenUsableUntil.getTime()).toBe(
        RECEIVED.getTime() +
          DEFAULT_LINE_ROUTER_CONFIG.replyTokenTtlMs -
          DEFAULT_LINE_ROUTER_CONFIG.replyTokenSafetyMarginMs,
      );
    }
  });

  it('replies even when the quota is exhausted (replies are free)', () => {
    expect(decideLineRoute(input({ quota: { used: 300, limit: 300 } })).route).toBe('reply');
  });

  it('defaults to a token lifetime below the documented one minute', () => {
    expect(DEFAULT_LINE_ROUTER_CONFIG.replyTokenTtlMs).toBeLessThan(60_000);
  });

  it('stops using the token before it expires, leaving room for the HTTP call', () => {
    // ttl 50 s, margin 3 s: usable until 47 s after receipt.
    expect(decideLineRoute(input({ now: at(46.9) })).route).toBe('reply');
    expect(decideLineRoute(input({ now: at(47) }))).toMatchObject({
      route: 'push',
      reason: 'reply_token_expired',
    });
    expect(decideLineRoute(input({ now: at(300) }))).toMatchObject({
      route: 'push',
      reason: 'reply_token_expired',
    });
  });

  it('pushes when the token was already used', () => {
    expect(
      decideLineRoute(input({ replyToken: { receivedAt: RECEIVED, used: true } })),
    ).toMatchObject({
      route: 'push',
      reason: 'reply_token_used',
    });
  });

  it('pushes when there is no token at all (agent-initiated message, standby mode)', () => {
    expect(decideLineRoute(input({ replyToken: null }))).toMatchObject({
      route: 'push',
      reason: 'no_reply_token',
    });
  });

  it('respects configured TTL and margin', () => {
    const config = { replyTokenTtlMs: 10_000, replyTokenSafetyMarginMs: 0 };
    expect(decideLineRoute(input({ now: at(9.9), config })).route).toBe('reply');
    expect(decideLineRoute(input({ now: at(10), config })).route).toBe('push');
  });

  it('rejects a TTL above the documented minute', () => {
    expect(() => decideLineRoute(input({ config: { replyTokenTtlMs: 120_000 } }))).toThrow();
  });
});

describe('decideLineRoute: push and quota', () => {
  const pushInput = (overrides: Partial<RouteInput> = {}): RouteInput =>
    input({ replyToken: null, ...overrides });

  it('pushes when quota remains and reports the quota view', () => {
    const decision = decideLineRoute(pushInput());
    expect(decision).toMatchObject({
      route: 'push',
      quotaWarning: false,
      quota: { used: 10, limit: 300, remaining: 290, level: 'ok' },
    });
  });

  it('warns when this push would reach the warning threshold (80%)', () => {
    expect(decideLineRoute(pushInput({ quota: { used: 239, limit: 300 } }))).toMatchObject({
      route: 'push',
      quotaWarning: true,
    });
    expect(decideLineRoute(pushInput({ quota: { used: 238, limit: 300 } }))).toMatchObject({
      quotaWarning: false,
    });
  });

  it('blocks a push when the quota is spent and suggests email (PRD 8.3)', () => {
    expect(decideLineRoute(pushInput({ quota: { used: 300, limit: 300 } }))).toMatchObject({
      route: 'none',
      reason: 'quota_exhausted',
      suggestFallback: 'email',
      tokenProblem: 'no_reply_token',
    });
  });

  it('counts one message per recipient (a group push costs its member count)', () => {
    expect(
      decideLineRoute(pushInput({ quota: { used: 296, limit: 300 }, recipients: 5 })).route,
    ).toBe('none');
    expect(
      decideLineRoute(pushInput({ quota: { used: 295, limit: 300 }, recipients: 5 })).route,
    ).toBe('push');
  });

  it('never blocks on an unknown limit', () => {
    expect(decideLineRoute(pushInput({ quota: { used: 100000, limit: null } }))).toMatchObject({
      route: 'push',
      quota: { level: 'unknown', remaining: null },
    });
  });

  it('does not push for an auto-ack whose token is unusable (late ack is not worth quota)', () => {
    const expired = decideLineRoute(input({ now: at(120), pushFallback: 'deny' }));
    expect(expired).toMatchObject({
      route: 'none',
      reason: 'push_not_allowed',
      tokenProblem: 'reply_token_expired',
      suggestFallback: null,
    });
    expect(decideLineRoute(input({ replyToken: null, pushFallback: 'deny' }))).toMatchObject({
      route: 'none',
      reason: 'push_not_allowed',
    });
  });

  it('still lets an auto-ack use a valid token', () => {
    expect(decideLineRoute(input({ pushFallback: 'deny' })).route).toBe('reply');
  });

  it('is pure: same input, same output, input untouched', () => {
    const frozen = Object.freeze(input());
    expect(decideLineRoute(frozen)).toEqual(decideLineRoute(frozen));
  });
});

describe('quota helpers', () => {
  it('evaluates levels around the warning threshold', () => {
    expect(evaluateQuota({ used: 239, limit: 300 }).level).toBe('ok');
    expect(evaluateQuota({ used: 240, limit: 300 })).toMatchObject({
      level: 'warn',
      percentUsed: 80,
      remaining: 60,
    });
    expect(evaluateQuota({ used: 300, limit: 300 })).toMatchObject({
      level: 'exhausted',
      remaining: 0,
    });
    expect(evaluateQuota({ used: 305, limit: 300 })).toMatchObject({
      level: 'exhausted',
      remaining: 0,
      percentUsed: 100,
    });
    expect(evaluateQuota({ used: 0, limit: 0 }).level).toBe('exhausted');
    expect(evaluateQuota({ used: 5, limit: null }).level).toBe('unknown');
    expect(evaluateQuota({ used: 50, limit: 100 }, 50).level).toBe('warn');
    expect(DEFAULT_QUOTA_WARN_PERCENT).toBe(80);
  });

  it('reserves and releases without going out of range', () => {
    expect(canSpend({ used: 299, limit: 300 })).toBe(true);
    expect(canSpend({ used: 300, limit: 300 })).toBe(false);
    expect(reserveQuota({ used: 299, limit: 300 })).toEqual({ used: 300, limit: 300 });
    expect(reserveQuota({ used: 300, limit: 300 })).toBeNull();
    expect(reserveQuota({ used: 1, limit: null }, 3)).toEqual({ used: 4, limit: null });
    expect(releaseQuota({ used: 1, limit: 300 }, 5)).toEqual({ used: 0, limit: 300 });
  });

  it('resolves the limit from the quota API response, with a conservative fallback', () => {
    expect(resolveQuotaLimit({ type: 'limited', value: 15000 })).toBe(15000);
    expect(resolveQuotaLimit({ type: 'none' })).toBe(FALLBACK_QUOTA_LIMIT);
    expect(resolveQuotaLimit({ type: 'none' }, null)).toBeNull();
    expect(resolveQuotaLimit({ type: 'limited' })).toBe(FALLBACK_QUOTA_LIMIT);
  });

  it('reconciles with LINE, keeping the larger usage', () => {
    expect(reconcileQuota({ used: 12, limit: 300 }, { totalUsage: 40, limit: 1000 })).toEqual({
      used: 40,
      limit: 1000,
    });
    expect(reconcileQuota({ used: 12, limit: 300 }, { totalUsage: 10, limit: 300 })).toEqual({
      used: 12,
      limit: 300,
    });
  });

  it('names the billing period in the business time zone by default', () => {
    // 2025-10-31 18:00 UTC is already November 1st in Bangkok (UTC+7).
    expect(quotaPeriod(new Date('2025-10-31T18:00:00Z'))).toBe('2025-11');
    expect(quotaPeriod(new Date('2025-10-31T18:00:00Z'), 'UTC')).toBe('2025-10');
    expect(quotaPeriod(new Date('2025-12-31T16:59:59Z'))).toBe('2025-12');
  });
});
