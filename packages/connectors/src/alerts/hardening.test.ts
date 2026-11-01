import { normalizedAlertSchema } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import { alertmanagerSeverity, normalizeAlertmanager } from './alertmanager.js';
import { gcpSeverity, normalizeGcpAlert } from './gcp.js';

// Review of T-200: words that exist on every object must not be read as a severity, links must not carry
// credentials, and free text must not carry personal data (N1, N4).

const WORDS = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'];

function gcp(overrides: Record<string, unknown>) {
  return normalizeGcpAlert(
    {
      version: '1.2',
      incident: {
        incident_id: 'i-1',
        state: 'open',
        policy_name: 'Policy',
        resource: { type: 'gce_instance', labels: { zone: 'a' } },
        ...overrides,
      },
    },
    { messageId: '1' },
  );
}

function am(alert: Record<string, unknown>, body: Record<string, unknown> = {}) {
  const batch = normalizeAlertmanager({
    version: '4',
    ...body,
    alerts: [
      { status: 'firing', labels: { alertname: 'A' }, startsAt: '2026-11-02T03:00:00Z', ...alert },
    ],
  });
  if (typeof batch === 'string') throw new Error(batch);
  const result = batch.results[0];
  if (result === undefined || !result.ok) throw new Error('rejected');
  return result.alert;
}

describe('severity words that exist on every object', () => {
  it.each(WORDS)('%s is unknown, not a crash', (word) => {
    expect(gcpSeverity(word)).toBe('unknown');
    expect(alertmanagerSeverity(word)).toBe('unknown');
  });

  it.each(WORDS)('a GCP notification with severity %s is still a valid alert', (word) => {
    const result = gcp({ severity: word });
    expect(result.ok && result.alert.severity).toBe('unknown');
    expect(result.ok && normalizedAlertSchema.safeParse(result.alert).success).toBe(true);
  });

  it.each(WORDS)('an Alertmanager alert with severity %s is still a valid alert', (word) => {
    const alert = am({ labels: { alertname: 'A', severity: word } });
    expect(alert.severity).toBe('unknown');
    expect(normalizedAlertSchema.safeParse(alert).success).toBe(true);
  });
});

describe('links (N1)', () => {
  it('a GCP link loses its user name, password, fragment and credential parameters', () => {
    const result = gcp({
      url: 'https://user:pa55@console.example.invalid/alert/1?project=p&token=abc#access_token=zzz',
    });
    const url = result.ok ? result.alert.url : null;
    expect(url).toBe('https://console.example.invalid/alert/1?project=p');
    expect(JSON.stringify(result)).not.toMatch(/pa55|abc|zzz|user:/);
  });

  it('an Alertmanager link loses its query too: the expression can name a customer', () => {
    const alert = am(
      {
        generatorURL: 'https://u:p@prom.example.invalid/graph?g0.expr=up{customer="Acme"}&token=t',
      },
      { externalURL: 'https://am-user:am-pass@alertmanager.example.invalid/?api_key=k' },
    );
    expect(alert.url).toBe('https://prom.example.invalid/graph');
    expect(alert.payload.externalUrl).toBe('https://alertmanager.example.invalid/');
    expect(JSON.stringify(alert)).not.toMatch(/Acme|am-pass|u:p@|token|api_key/);
  });
});

describe('free text (N4)', () => {
  it('does not keep the description annotation, only the summary', () => {
    const alert = am({
      annotations: { description: 'Customer jane@example.invalid called 081-234-5678' },
    });
    expect(alert.summary).toBeNull();
    expect(JSON.stringify(alert)).not.toMatch(/jane|081-234|Customer/);
  });

  it('scrubs an email, a phone number and a secret out of the summary', () => {
    const alert = am({
      annotations: {
        summary: 'Errors for jane@example.invalid, call 081-234-5678, password: hunter2',
      },
    });
    expect(alert.summary).toBe('Errors for [email], call [phone], password: [secret]');
    expect(alert.payload.summary).toBe(alert.summary);
  });

  it('scrubs the summary of a GCP notification too', () => {
    const result = gcp({ summary: 'Owner jane@example.invalid, token=abc123 failed' });
    expect(result.ok && result.alert.summary).toBe('Owner [email], token=[secret] failed');
  });
});
