import { readFileSync } from 'node:fs';

import { ALERT_PAYLOAD_KEYS, normalizedAlertSchema } from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, describe, expect, it } from 'vitest';

import {
  ALERTMANAGER_MAX_ALERTS,
  alertmanagerSeverity,
  normalizeAlertmanager,
  type AlertmanagerBatch,
} from './alertmanager.js';

const net = disableNetConnect();
afterAll(() => {
  expect(net.blocked()).toEqual([]);
  net.restore();
});

const fixture = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8');

function batchOf(data: unknown): AlertmanagerBatch {
  const batch = normalizeAlertmanager(data);
  if (typeof batch === 'string') throw new Error(`rejected: ${batch}`);
  return batch;
}

function alertsOf(name: string) {
  return batchOf(fixture(name)).results.map((result) => {
    if (!result.ok) throw new Error(`rejected: ${result.reason}`);
    return result.alert;
  });
}

describe('normalizeAlertmanager (R-3.3)', () => {
  it('turns every alert of a request into one normalized alert', () => {
    const alerts = alertsOf('alertmanager-firing.json');
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toMatchObject({
      source: 'alertmanager',
      state: 'firing',
      severity: 'critical',
      title: 'HighErrorRate',
      summary: 'Error rate above 5% on checkout',
      occurredAt: '2026-11-02T03:00:00.000Z',
      renotify: false,
    });
    for (const alert of alerts) expect(normalizedAlertSchema.safeParse(alert).success).toBe(true);
    // Two instances of one alertname are two alerts.
    expect(alerts[0]?.fingerprint).not.toBe(alerts[1]?.fingerprint);
  });

  it('gives a firing alert and its resolution the same fingerprint, at the end time', () => {
    const firing = alertsOf('alertmanager-firing.json')[0];
    const resolved = alertsOf('alertmanager-resolved.json')[0];
    expect(resolved?.state).toBe('resolved');
    expect(resolved?.fingerprint).toBe(firing?.fingerprint);
    expect(resolved?.occurredAt).toBe('2026-11-02T03:12:00.000Z');
    expect(resolved?.providerEventId).not.toBe(firing?.providerEventId);
  });

  it('treats Alertmanager repeating a firing alert as the same delivery, however endsAt moves', () => {
    const body = JSON.parse(fixture('alertmanager-firing.json')) as {
      alerts: { endsAt: string }[];
    };
    const first = batchOf(body).results[0];
    if (body.alerts[0] !== undefined) body.alerts[0].endsAt = '2026-11-02T04:00:00.000Z';
    const repeat = batchOf(body).results[0];
    expect(first?.ok && repeat?.ok && first.alert.providerEventId).toBe(
      repeat?.ok ? repeat.alert.providerEventId : undefined,
    );
  });

  it('a second fire of the same alertname after a restart (new startsAt) is a different delivery', () => {
    const body = JSON.parse(fixture('alertmanager-firing.json')) as {
      alerts: { startsAt: string }[];
    };
    const first = batchOf(body).results[0];
    if (body.alerts[0] !== undefined) body.alerts[0].startsAt = '2026-11-02T05:00:00.000Z';
    const again = batchOf(body).results[0];
    expect(
      first?.ok && again?.ok && first.alert.providerEventId !== again.alert.providerEventId,
    ).toBe(true);
    expect(first?.ok && again?.ok && first.alert.fingerprint === again.alert.fingerprint).toBe(
      true,
    );
  });

  it('keeps only allow-listed keys and labels (N4): the customer label and the runbook annotation go', () => {
    for (const alert of alertsOf('alertmanager-firing.json')) {
      for (const key of Object.keys(alert.payload)) {
        expect(ALERT_PAYLOAD_KEYS as readonly string[], key).toContain(key);
      }
      const everything = JSON.stringify(alert);
      expect(everything).not.toContain('buyer@example.invalid');
      expect(everything).not.toContain('runbooks.example.invalid');
      expect(Object.keys(alert.labels)).not.toContain('customer_email');
      expect(alert.labels).toMatchObject({ service: 'checkout', severity: 'critical' });
    }
    // The payload still says which fingerprint the provider used.
    expect(alertsOf('alertmanager-firing.json')[0]?.payload).toMatchObject({
      providerFingerprint: '8a1b2c3d4e5f6a7b',
      kind: 'alertmanager',
    });
  });

  it('counts a label that is not stored in the fingerprint: alerts that differ only by it stay apart', () => {
    const body = JSON.parse(fixture('alertmanager-firing.json')) as {
      alerts: { labels: Record<string, string> }[];
    };
    const first = batchOf(body).results[0];
    if (body.alerts[0] !== undefined)
      body.alerts[0].labels.customer_email = 'other@example.invalid';
    const second = batchOf(body).results[0];
    expect(first?.ok && second?.ok && first.alert.fingerprint !== second.alert.fingerprint).toBe(
      true,
    );
  });

  it('refuses one bad alert without losing the others, and says why', () => {
    const batch = batchOf({
      version: '4',
      alerts: [
        { status: 'firing', labels: { alertname: 'A' }, startsAt: '2026-11-02T03:00:00Z' },
        { status: 'firing', labels: {} },
        { status: 'odd', labels: { alertname: 'B' } },
        'nonsense',
      ],
    });
    expect(batch.results.map((result) => (result.ok ? 'ok' : result.reason))).toEqual([
      'ok',
      'missing_name',
      'unknown_state',
      'invalid_shape',
    ]);
  });

  it('cuts a request longer than the limit and says how many were cut', () => {
    const alerts = Array.from({ length: ALERTMANAGER_MAX_ALERTS + 5 }, (_, index) => ({
      status: 'firing',
      labels: { alertname: `A${String(index)}` },
      startsAt: '2026-11-02T03:00:00Z',
    }));
    const batch = batchOf({ version: '4', alerts });
    expect(batch.results).toHaveLength(ALERTMANAGER_MAX_ALERTS);
    expect(batch.truncated).toBe(5);
  });

  it.each([
    ['not json', '{nope', 'not_json'],
    ['no alerts array', '{"version":"4"}', 'invalid_shape'],
    ['another payload version', '{"version":"5","alerts":[]}', 'unsupported_version'],
  ])('refuses %s', (_label, data, reason) => {
    expect(normalizeAlertmanager(data)).toBe(reason);
  });

  it('maps severity labels and leaves the unknown ones unknown', () => {
    expect(alertmanagerSeverity('Critical')).toBe('critical');
    expect(alertmanagerSeverity('page')).toBe('unknown');
    expect(alertmanagerSeverity(undefined)).toBe('unknown');
  });

  it('ignores the placeholder end time of a firing alert and a start time that is not a date', () => {
    const batch = batchOf({
      version: '4',
      alerts: [
        {
          status: 'firing',
          labels: { alertname: 'A' },
          startsAt: 'garbage',
          endsAt: '0001-01-01T00:00:00Z',
        },
      ],
    });
    const result = batch.results[0];
    expect(result?.ok && result.alert.occurredAt).toBeNull();
  });
});
