import { describe, expect, it } from 'vitest';

import { matchService, ruleMatches, ruleSpecificity, type AlertFacts } from './match.js';

const alert: AlertFacts = {
  source: 'alertmanager',
  title: 'HighErrorRate',
  labels: { service: 'checkout', severity: 'critical', env: 'prod' },
};

const svc = (id: string, slug: string, matchRules: unknown) => ({ id, slug, matchRules });

describe('ruleMatches', () => {
  it('needs every condition it names to hold', () => {
    expect(ruleMatches({ labels: { service: 'checkout' } }, alert)).toBe(true);
    expect(ruleMatches({ labels: { service: 'checkout', env: 'staging' } }, alert)).toBe(false);
    expect(ruleMatches({ source: 'gcp_monitoring', labels: {} }, alert)).toBe(false);
    expect(ruleMatches({ source: 'alertmanager', labels: {} }, alert)).toBe(true);
  });

  it('compares the policy name without regard to case or padding', () => {
    expect(ruleMatches({ policyName: '  higherrorrate ', labels: {} }, alert)).toBe(true);
    expect(ruleMatches({ policyName: 'HighErrorRates', labels: {} }, alert)).toBe(false);
  });

  it('compares label values exactly, and a missing label never matches', () => {
    expect(ruleMatches({ labels: { service: 'Checkout' } }, alert)).toBe(false);
    expect(ruleMatches({ labels: { team: 'payments' } }, alert)).toBe(false);
  });
});

describe('ruleSpecificity', () => {
  it('counts the conditions', () => {
    expect(ruleSpecificity({ labels: {} })).toBe(0);
    expect(
      ruleSpecificity({ source: 'alertmanager', policyName: 'x', labels: { a: '1', b: '2' } }),
    ).toBe(4);
  });
});

describe('matchService', () => {
  it('finds no service in an empty catalog, or when nothing matches (unmapped)', () => {
    expect(matchService([], alert)).toBeNull();
    expect(
      matchService([svc('1', 'billing', [{ labels: { service: 'billing' } }])], alert),
    ).toBeNull();
  });

  it('prefers the more specific rule between services, whatever the order', () => {
    const broad = svc('broad', 'aaa-all', [{ source: 'alertmanager', labels: {} }]);
    const narrow = svc('narrow', 'zzz-checkout', [
      { source: 'alertmanager', labels: { service: 'checkout' } },
    ]);
    expect(matchService([broad, narrow], alert)).toBe('narrow');
    expect(matchService([narrow, broad], alert)).toBe('narrow');
  });

  it('breaks a tie by slug, so row order never decides', () => {
    const a = svc('a', 'alpha', [{ labels: { service: 'checkout' } }]);
    const b = svc('b', 'beta', [{ labels: { service: 'checkout' } }]);
    expect(matchService([b, a], alert)).toBe('a');
    expect(matchService([a, b], alert)).toBe('a');
  });

  it('skips a stored rule that is no longer valid instead of failing the alert', () => {
    const broken = svc('broken', 'aaa', [{ labels: { customer: 'x' } }, 'junk', null, {}]);
    const good = svc('good', 'bbb', [{ labels: { service: 'checkout' } }]);
    expect(matchService([broken, good], alert)).toBe('good');
    expect(matchService([svc('x', 'x', 'not an array'), svc('y', 'y', null)], alert)).toBeNull();
  });

  it('any rule of a service is enough', () => {
    const multi = svc('multi', 'multi', [
      { labels: { service: 'other' } },
      { labels: { env: 'prod' } },
    ]);
    expect(matchService([multi], alert)).toBe('multi');
  });
});
