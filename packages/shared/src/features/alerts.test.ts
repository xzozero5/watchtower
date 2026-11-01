import { describe, expect, it } from 'vitest';

import {
  ALERT_LABEL_KEYS,
  ALERT_PAYLOAD_KEYS,
  ALERT_PAYLOAD_MAX_BYTES,
  DEFAULT_ESCALATION_STEPS,
  alertListQuerySchema,
  allowedLabels,
  createEscalationPolicySchema,
  createServiceSchema,
  escalationStepsSchema,
  normalizedAlertSchema,
  sanitizeAlertPayload,
  serviceMatchRuleSchema,
  updateServiceSchema,
} from './alerts.js';
import { FEATURES } from './index.js';

describe('sanitizeAlertPayload (N4)', () => {
  it('keeps allow-listed keys and drops everything else, nested or not', () => {
    const payload = sanitizeAlertPayload({
      kind: 'gcp_monitoring',
      policyName: 'High CPU',
      summary: 'ok',
      documentation: { content: 'call jane@example.invalid' },
      customerName: 'Example Customer',
      annotations: { description: 'free text' },
      labels: { zone: 'a', owner_email: 'x@example.invalid', customer: 'Example' },
      userLabels: { team: 'platform', customer: 'Example' },
      renotify: false,
      observedValue: 0.5,
    });
    expect(Object.keys(payload).toSorted()).toEqual(
      [
        'kind',
        'labels',
        'observedValue',
        'policyName',
        'renotify',
        'summary',
        'userLabels',
      ].toSorted(),
    );
    expect(payload.labels).toEqual({ zone: 'a' });
    expect(payload.userLabels).toEqual({ team: 'platform' });
    expect(JSON.stringify(payload)).not.toMatch(/example\.invalid|Example Customer|free text/);
  });

  it('only ever returns keys of the allow-list', () => {
    const everything = Object.fromEntries(ALERT_PAYLOAD_KEYS.map((key) => [key, 'v']));
    const polluted = { ...everything, extra: 'x', __proto__: { polluted: true } };
    expect(Object.keys(sanitizeAlertPayload(polluted)).toSorted()).toEqual(
      Object.keys(everything)
        .filter((key) => key !== 'labels' && key !== 'userLabels')
        .toSorted(),
    );
  });

  it('bounds strings, label counts and the serialized size, and is idempotent', () => {
    const big = sanitizeAlertPayload({
      summary: 'x'.repeat(10_000),
      policyName: 'p'.repeat(10_000),
      labels: Object.fromEntries(ALERT_LABEL_KEYS.map((key) => [key, 'v'.repeat(1000)])),
      userLabels: Object.fromEntries(ALERT_LABEL_KEYS.map((key) => [key, 'v'.repeat(1000)])),
    });
    expect(JSON.stringify(big).length).toBeLessThanOrEqual(ALERT_PAYLOAD_MAX_BYTES);
    expect(typeof big.summary === 'string' ? big.summary.length : 0).toBeLessThanOrEqual(500);
    expect(sanitizeAlertPayload(big)).toEqual(big);
  });

  it('ignores a payload that is not an object', () => {
    for (const bad of [null, undefined, 'x', 3, ['a']])
      expect(sanitizeAlertPayload(bad)).toEqual({});
  });

  it('allowedLabels keeps coordinates and drops a label that names a person or a customer', () => {
    expect(
      allowedLabels({
        service: 'checkout',
        instance: 3,
        email: 'a@example.invalid',
        customer: 'X',
        nested: {},
      }),
    ).toEqual({ instance: '3', service: 'checkout' });
  });
});

describe('normalizedAlertSchema', () => {
  const valid = {
    source: 'alertmanager',
    providerEventId: 'abc',
    fingerprint: 'a'.repeat(64),
    state: 'firing',
    severity: 'critical',
    title: 'HighErrorRate',
    summary: null,
    conditionName: null,
    labels: {},
    url: null,
    occurredAt: '2026-11-02T03:00:00.000Z',
    renotify: false,
    payload: {},
  };

  it('accepts a complete alert and rejects an unknown key, a short fingerprint and a bad url', () => {
    expect(normalizedAlertSchema.safeParse(valid).success).toBe(true);
    expect(normalizedAlertSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
    expect(normalizedAlertSchema.safeParse({ ...valid, fingerprint: 'abc' }).success).toBe(false);
    expect(normalizedAlertSchema.safeParse({ ...valid, url: 'javascript:alert(1)' }).success).toBe(
      false,
    );
    expect(normalizedAlertSchema.safeParse({ ...valid, source: 'sms' }).success).toBe(false);
  });
});

describe('service catalog schemas', () => {
  it('a match rule needs at least one condition and only label keys alerts keep', () => {
    expect(serviceMatchRuleSchema.safeParse({}).success).toBe(false);
    expect(serviceMatchRuleSchema.safeParse({ labels: { customer: 'x' } }).success).toBe(false);
    expect(serviceMatchRuleSchema.safeParse({ source: 'alertmanager' }).success).toBe(true);
    expect(serviceMatchRuleSchema.safeParse({ labels: { service: 'checkout' } }).success).toBe(
      true,
    );
    expect(serviceMatchRuleSchema.safeParse({ policyName: 'High CPU', extra: 1 }).success).toBe(
      false,
    );
  });

  it('create needs a slug and a name; slug is lower-case kebab; urls are http(s)', () => {
    expect(createServiceSchema.safeParse({ slug: 'checkout', name: 'Checkout' }).success).toBe(
      true,
    );
    expect(createServiceSchema.safeParse({ slug: 'Checkout', name: 'x' }).success).toBe(false);
    expect(createServiceSchema.safeParse({ slug: 'a--b', name: 'x' }).success).toBe(false);
    expect(createServiceSchema.safeParse({ name: 'x' }).success).toBe(false);
    expect(
      createServiceSchema.safeParse({ slug: 'ab', name: 'x', runbookUrl: 'javascript:alert(1)' })
        .success,
    ).toBe(false);
    expect(createServiceSchema.safeParse({ slug: 'ab', name: 'x', owner: 'nope' }).success).toBe(
      false,
    );
  });

  it('update needs at least one field', () => {
    expect(updateServiceSchema.safeParse({}).success).toBe(false);
    expect(updateServiceSchema.safeParse({ active: false }).success).toBe(true);
  });
});

describe('escalation policy schemas', () => {
  it('the default steps are valid and start at zero', () => {
    expect(escalationStepsSchema.safeParse(DEFAULT_ESCALATION_STEPS).success).toBe(true);
    expect(DEFAULT_ESCALATION_STEPS[0]).toEqual({ target: 'on_shift', afterSeconds: 0 });
  });

  it.each([
    ['empty', []],
    ['first step not at 0', [{ target: 'lead', afterSeconds: 60 }]],
    [
      'not increasing',
      [
        { target: 'on_shift', afterSeconds: 0 },
        { target: 'lead', afterSeconds: 300 },
        { target: 'head', afterSeconds: 300 },
      ],
    ],
    ['unknown target', [{ target: 'ceo', afterSeconds: 0 }]],
    [
      'too many',
      Array.from({ length: 6 }, (_, index) => ({ target: 'lead', afterSeconds: index * 60 })),
    ],
  ])('refuses steps that are %s', (_label, steps) => {
    expect(escalationStepsSchema.safeParse(steps).success).toBe(false);
  });

  it('create needs a name and steps', () => {
    expect(
      createEscalationPolicySchema.safeParse({ name: 'Night', steps: DEFAULT_ESCALATION_STEPS })
        .success,
    ).toBe(true);
    expect(createEscalationPolicySchema.safeParse({ name: 'Night' }).success).toBe(false);
  });
});

describe('alert list query', () => {
  it('reads strings from a query string and bounds the page', () => {
    expect(alertListQuerySchema.parse({ unmapped: 'true', limit: '20' })).toMatchObject({
      unmapped: true,
      limit: 20,
    });
    expect(alertListQuerySchema.parse({}).limit).toBe(50);
    expect(alertListQuerySchema.safeParse({ limit: '1000' }).success).toBe(false);
    expect(alertListQuerySchema.safeParse({ state: 'weird' }).success).toBe(false);
  });
});

describe('Phase 2 feature files (T-200)', () => {
  it('are registered, so a parallel task only edits its own file', () => {
    const names = FEATURES.map((feature) => feature.name);
    for (const name of ['alerts', 'incidents', 'tools', 'statuspage', 'usage', 'dashboard']) {
      expect(names).toContain(name);
    }
  });
});
