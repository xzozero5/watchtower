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

// Generated per run, so nothing in the repository resembles a real secret.
const secret = randomBytes(16).toString('hex');
const body = JSON.stringify({
  version: '4',
  alerts: [{ status: 'firing', labels: { alertname: 'สวัสดี' } }],
});
const T = 1_793_600_000;
const NOW_MS = T * 1000;

describe('signAlertWebhook / verifyAlertWebhook', () => {
  it('is HMAC-SHA256 over "<t>." + body (RFC 4231 test case 2: key "Jefe", data "what do ya want for nothing?")', () => {
    // The vector's data is split into "<t>." = "what do ya want for nothing?" is not possible with a numeric
    // t, so check the primitive with the same construction instead: t=7, body "x" == HMAC("7.x").
    const header = signAlertWebhook({ rawBody: 'x', secret: 'Jefe', timestampSeconds: 7 });
    expect(header).toBe(`t=7,v1=${createHmac('sha256', 'Jefe').update('7.x').digest('hex')}`);
    expect(createHmac('sha256', 'Jefe').update('what do ya want for nothing?').digest('hex')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });

  it('accepts a fresh, correct signature for the exact bytes', () => {
    const header = signAlertWebhook({ rawBody: body, secret, timestampSeconds: T });
    expect(verifyAlertWebhook({ rawBody: body, header, secret, nowMs: NOW_MS })).toBe('ok');
    expect(
      verifyAlertWebhook({ rawBody: Buffer.from(body, 'utf8'), header, secret, nowMs: NOW_MS }),
    ).toBe('ok');
  });

  it('rejects another body, another secret and a re-signed timestamp', () => {
    const header = signAlertWebhook({ rawBody: body, secret, timestampSeconds: T });
    expect(verifyAlertWebhook({ rawBody: body + ' ', header, secret, nowMs: NOW_MS })).toBe(
      'mismatch',
    );
    expect(verifyAlertWebhook({ rawBody: body, header, secret: secret + 'x', nowMs: NOW_MS })).toBe(
      'mismatch',
    );
    // Same MAC with the timestamp edited: the timestamp is part of what is signed.
    const mac = header.split('v1=')[1] ?? '';
    expect(
      verifyAlertWebhook({
        rawBody: body,
        header: `t=${String(T + 1)},v1=${mac}`,
        secret,
        nowMs: NOW_MS,
      }),
    ).toBe('mismatch');
  });

  it('rejects a captured request replayed outside the tolerance, both directions', () => {
    const old = signAlertWebhook({
      rawBody: body,
      secret,
      timestampSeconds: T - ALERT_WEBHOOK_TOLERANCE_SECONDS - 1,
    });
    const future = signAlertWebhook({
      rawBody: body,
      secret,
      timestampSeconds: T + ALERT_WEBHOOK_TOLERANCE_SECONDS + 1,
    });
    expect(verifyAlertWebhook({ rawBody: body, header: old, secret, nowMs: NOW_MS })).toBe('stale');
    expect(verifyAlertWebhook({ rawBody: body, header: future, secret, nowMs: NOW_MS })).toBe(
      'stale',
    );
    const edge = signAlertWebhook({
      rawBody: body,
      secret,
      timestampSeconds: T - ALERT_WEBHOOK_TOLERANCE_SECONDS,
    });
    expect(verifyAlertWebhook({ rawBody: body, header: edge, secret, nowMs: NOW_MS })).toBe('ok');
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
    expect(verifyAlertWebhook({ rawBody: body, header, secret, nowMs: NOW_MS })).toBe('malformed');
  });

  it('never accepts with an empty secret', () => {
    const header = signAlertWebhook({ rawBody: body, secret: '', timestampSeconds: T });
    expect(verifyAlertWebhook({ rawBody: body, header, secret: '', nowMs: NOW_MS })).toBe(
      'malformed',
    );
  });
});
