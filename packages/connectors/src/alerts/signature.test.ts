import { createHmac, randomBytes } from 'node:crypto';

import { ALERT_WEBHOOK_TOLERANCE_SECONDS } from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, describe, expect, it } from 'vitest';

import { signAlertWebhook, verifyAlertWebhook } from './signature.js';

const net = disableNetConnect();
afterAll(() => {
  expect(net.blocked()).toEqual([]);
  net.restore();
});

// Generated per run, so nothing in the repository resembles a real key.
const key = randomBytes(16).toString('hex');
const body = JSON.stringify({
  version: '4',
  alerts: [{ status: 'firing', labels: { alertname: 'สวัสดี' } }],
});
const ROUTE = 'alerts-webhook';
const T = 1_793_600_000;
const NOW_MS = T * 1000;

const sign = (overrides: Partial<Parameters<typeof signAlertWebhook>[0]> = {}) =>
  signAlertWebhook({ route: ROUTE, rawBody: body, secret: key, timestampSeconds: T, ...overrides });
const verify = (overrides: Partial<Parameters<typeof verifyAlertWebhook>[0]> = {}) =>
  verifyAlertWebhook({
    route: ROUTE,
    rawBody: body,
    header: sign(),
    secret: key,
    nowMs: NOW_MS,
    ...overrides,
  });

describe('signAlertWebhook / verifyAlertWebhook', () => {
  it('is HMAC-SHA256 over "<t>.<route>." + body (the primitive checked against a known vector)', () => {
    // t=7, route "alerts-webhook", body "x" == HMAC("7.alerts-webhook.x"); and the primitive itself
    // against RFC 4231 test case 2 (key "Jefe", data "what do ya want for nothing?").
    const header = signAlertWebhook({
      route: ROUTE,
      rawBody: 'x',
      secret: 'Jefe',
      timestampSeconds: 7,
    });
    expect(header).toBe(
      `t=7,v1=${createHmac('sha256', 'Jefe').update('7.alerts-webhook.x').digest('hex')}`,
    );
    expect(createHmac('sha256', 'Jefe').update('what do ya want for nothing?').digest('hex')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });

  it('accepts a fresh, correct signature for the exact bytes', () => {
    expect(verify()).toBe('ok');
    expect(verify({ rawBody: Buffer.from(body, 'utf8') })).toBe('ok');
  });

  it('rejects another body, another key and a re-signed timestamp', () => {
    expect(verify({ rawBody: body + ' ' })).toBe('mismatch');
    expect(verify({ secret: key + 'x' })).toBe('mismatch');
    // Same MAC with the timestamp edited: the timestamp is part of what is signed.
    const mac = sign().split('v1=')[1] ?? '';
    expect(verify({ header: `t=${String(T + 1)},v1=${mac}` })).toBe('mismatch');
  });

  it('is bound to its route: a signature made for one route is worthless on another, even with the same key', () => {
    const forDeploys = sign({ route: 'deploys' });
    expect(verify({ header: forDeploys, route: 'deploys' })).toBe('ok');
    expect(verify({ header: forDeploys, route: ROUTE })).toBe('mismatch');
    expect(verify({ header: forDeploys, route: 'heartbeat:nightly' })).toBe('mismatch');
    // A heartbeat signature is for that slug alone.
    const forOne = sign({ route: 'heartbeat:nightly' });
    expect(verify({ header: forOne, route: 'heartbeat:nightly' })).toBe('ok');
    expect(verify({ header: forOne, route: 'heartbeat:other' })).toBe('mismatch');
    // The route cannot be smuggled into the body: "." splits the signed text, so a route has none.
    expect(() => sign({ route: 'deploys.alerts-webhook' })).toThrow();
    expect(() => sign({ route: '' })).toThrow();
    expect(verify({ route: 'deploys.alerts-webhook' })).toBe('malformed');
    expect(verify({ route: '' })).toBe('malformed');
  });

  it('rejects a captured request replayed outside the tolerance, both directions', () => {
    const old = sign({ timestampSeconds: T - ALERT_WEBHOOK_TOLERANCE_SECONDS - 1 });
    const future = sign({ timestampSeconds: T + ALERT_WEBHOOK_TOLERANCE_SECONDS + 1 });
    expect(verify({ header: old })).toBe('stale');
    expect(verify({ header: future })).toBe('stale');
    const edge = sign({ timestampSeconds: T - ALERT_WEBHOOK_TOLERANCE_SECONDS });
    expect(verify({ header: edge })).toBe('ok');
  });

  it.each([
    undefined,
    null,
    '',
    'garbage',
    't=1',
    'v1=abc',
    `t=1,v1=${'g'.repeat(64)}`,
    `t=1,v1=${'a'.repeat(63)}`,
  ])('calls a missing or malformed header malformed (%s)', (header) => {
    expect(verify({ header })).toBe('malformed');
  });

  it('never accepts with an empty key', () => {
    expect(verify({ header: sign({ secret: '' }), secret: '' })).toBe('malformed');
  });
});
