import { readFileSync } from 'node:fs';

import { ALERT_PAYLOAD_KEYS, normalizedAlertSchema } from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, describe, expect, it } from 'vitest';

import { alertFingerprint } from './fingerprint.js';
import { decodePubsubText, gcpSeverity, normalizeGcpAlert } from './gcp.js';

const net = disableNetConnect();
afterAll(() => {
  // The normalizers are pure: nothing here may even try to reach the network.
  expect(net.blocked()).toEqual([]);
  net.restore();
});

const fixture = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8');

function alertOf(name: string, messageId?: string) {
  const result = normalizeGcpAlert(fixture(name), { messageId });
  if (!result.ok) throw new Error(`fixture ${name} was rejected: ${result.reason}`);
  return result.alert;
}

describe('normalizeGcpAlert: metric alert (R-3.1)', () => {
  it('reads the policy, condition, resource, state and the provider time', () => {
    const alert = alertOf('gcp-monitoring-open.json', '9001');
    expect(alert).toMatchObject({
      source: 'gcp_monitoring',
      providerEventId: '9001',
      state: 'firing',
      severity: 'critical',
      title: 'High CPU on API VMs',
      conditionName: 'CPU above 90% for 5 minutes',
      renotify: false,
      occurredAt: '2026-11-02T02:00:00.000Z',
    });
    expect(normalizedAlertSchema.safeParse(alert).success).toBe(true);
    expect(alert.url).toContain('console.cloud.google.com');
    expect(alert.labels).toMatchObject({
      instance_id: '1234567890123456789',
      zone: 'asia-southeast1-a',
      project_id: 'example-project',
      team: 'platform',
    });
  });

  it('reads closed as resolved, at the time the provider closed it', () => {
    const alert = alertOf('gcp-monitoring-closed.json', '9002');
    expect(alert.state).toBe('resolved');
    expect(alert.occurredAt).toBe('2026-11-02T02:10:00.000Z');
  });

  it('gives open and closed of one incident the same fingerprint, a different resource another', () => {
    const open = alertOf('gcp-monitoring-open.json', '1');
    const closed = alertOf('gcp-monitoring-closed.json', '2');
    expect(open.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(closed.fingerprint).toBe(open.fingerprint);

    const other = JSON.parse(fixture('gcp-monitoring-open.json')) as {
      incident: { resource: { labels: Record<string, string> } };
    };
    other.incident.resource.labels.instance_id = '999';
    const result = normalizeGcpAlert(other, { messageId: '3' });
    expect(result.ok && result.alert.fingerprint).not.toBe(open.fingerprint);
  });

  it('uses the Pub/Sub message id as the idempotency key: same id twice, two ids for two fires', () => {
    expect(alertOf('gcp-monitoring-open.json', '9001').providerEventId).toBe(
      alertOf('gcp-monitoring-open.json', '9001').providerEventId,
    );
    expect(alertOf('gcp-monitoring-open.json', '9001').providerEventId).not.toBe(
      alertOf('gcp-monitoring-open.json', '9003').providerEventId,
    );
  });

  it('falls back to the content when there is no message id, and that id tells open from closed', () => {
    const open = normalizeGcpAlert(fixture('gcp-monitoring-open.json'));
    const closed = normalizeGcpAlert(fixture('gcp-monitoring-closed.json'));
    expect(
      open.ok && closed.ok && open.alert.providerEventId !== closed.alert.providerEventId,
    ).toBe(true);
  });

  it('marks a repeat notification', () => {
    const body = JSON.parse(fixture('gcp-monitoring-open.json')) as {
      incident: Record<string, unknown>;
    };
    body.incident.renotify = true;
    const result = normalizeGcpAlert(body, { messageId: '5' });
    expect(result.ok && result.alert.renotify).toBe(true);
  });
});

describe('normalizeGcpAlert: log-based alert (R-3.2) [VERIFY against a real notification]', () => {
  it('is told apart by the matched-log condition and has no metric values', () => {
    const alert = alertOf('gcp-logging-open.json', '7001');
    expect(alert.source).toBe('gcp_logging');
    expect(alert.severity).toBe('error');
    expect(alert.title).toBe('Unhandled exception in payment worker');
    expect(alert.labels).toMatchObject({ service_name: 'payment-worker', team: 'payments' });
    expect(alert.payload).not.toHaveProperty('metricType');
  });
});

describe('normalizeGcpAlert: what it keeps (N4)', () => {
  it.each(['gcp-monitoring-open.json', 'gcp-monitoring-closed.json', 'gcp-logging-open.json'])(
    '%s: payload keys are on the allow-list and nothing personal survives',
    (name) => {
      const alert = alertOf(name, '1');
      for (const key of Object.keys(alert.payload)) {
        expect(ALERT_PAYLOAD_KEYS as readonly string[], key).toContain(key);
      }
      const everything = JSON.stringify(alert);
      // Fake personal data planted in the fixtures: a label, a policy label and the documentation.
      expect(everything).not.toContain('someone@example.invalid');
      expect(everything).not.toContain('Example Customer');
      expect(everything).not.toContain('jane.doe');
      expect(everything).not.toContain('documentation');
      expect(Object.keys(alert.labels)).not.toContain('owner_email');
      expect(Object.keys(alert.labels)).not.toContain('customer');
    },
  );

  it('bounds a very long summary', () => {
    const body = JSON.parse(fixture('gcp-monitoring-open.json')) as {
      incident: Record<string, unknown>;
    };
    body.incident.summary = 'x'.repeat(5000);
    const result = normalizeGcpAlert(body, { messageId: '1' });
    expect(result.ok && result.alert.summary?.length).toBe(500);
    expect(JSON.stringify(result.ok && result.alert.payload).length).toBeLessThan(8192);
  });

  it('drops a url that is not http(s)', () => {
    const body = JSON.parse(fixture('gcp-monitoring-open.json')) as {
      incident: Record<string, unknown>;
    };
    body.incident.url = 'javascript:alert(1)';
    const result = normalizeGcpAlert(body, { messageId: '1' });
    expect(result.ok && result.alert.url).toBeNull();
  });
});

describe('normalizeGcpAlert: refusals', () => {
  it.each([
    ['not json', '{nope', 'not_json'],
    [
      'a different major version',
      JSON.stringify({ version: '2.0', incident: {} }),
      'unsupported_version',
    ],
    ['no incident', JSON.stringify({ version: '1.2' }), 'invalid_shape'],
    [
      'an unknown state',
      JSON.stringify({
        version: '1.2',
        incident: { incident_id: 'i', state: 'weird', policy_name: 'p' },
      }),
      'unknown_state',
    ],
    [
      'no policy name',
      JSON.stringify({ version: '1.2', incident: { incident_id: 'i', state: 'open' } }),
      'missing_name',
    ],
    [
      'no incident id',
      JSON.stringify({ version: '1.2', incident: { state: 'open', policy_name: 'p' } }),
      'invalid_shape',
    ],
  ])('%s', (_label, data, reason) => {
    expect(normalizeGcpAlert(data, { messageId: '1' })).toEqual({ ok: false, reason });
  });

  it('never puts the payload in the refusal', () => {
    const result = normalizeGcpAlert('{"secret":"do-not-leak"', { messageId: '1' });
    expect(JSON.stringify(result)).not.toContain('do-not-leak');
  });
});

describe('helpers', () => {
  it('maps severities and keeps the unknown ones unknown', () => {
    expect(gcpSeverity('CRITICAL')).toBe('critical');
    expect(gcpSeverity('Warning')).toBe('warning');
    expect(gcpSeverity('no severity')).toBe('unknown');
    expect(gcpSeverity(undefined)).toBe('unknown');
  });

  it('decodes Pub/Sub data', () => {
    const text = '{"version":"1.2","note":"สวัสดี"}';
    expect(decodePubsubText(Buffer.from(text).toString('base64'))).toBe(text);
  });

  it('fingerprints are independent of label order and case of the name', () => {
    const a = alertFingerprint({
      source: 'alertmanager',
      name: 'HighErrorRate',
      condition: '',
      resourceType: '',
      labels: { b: '2', a: '1' },
    });
    const b = alertFingerprint({
      source: 'alertmanager',
      name: 'higherrorrate',
      condition: '',
      resourceType: '',
      labels: { a: '1', b: '2' },
    });
    expect(a).toBe(b);
  });
});
