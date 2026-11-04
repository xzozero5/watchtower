import { createECDH, createPublicKey, verify } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { b64urlDecode, b64urlEncode } from './base64url.js';
import { MAX_PLAINTEXT_BYTES, PayloadTooLargeError, encryptMessage } from './encrypt.js';
import { checkPushEndpoint, isAllowedPushHost } from './endpoint.js';
import { PushRequestError, buildPushRequest, classifyPushResponse } from './request.js';
import {
  generateVapidKeys,
  isValidVapidSubject,
  vapidAuthorization,
  vapidKeysMatch,
} from './vapid.js';

// RFC 8291 section 5 and appendix A.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic:
    'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  cek: 'oIhVW04MRdy2XN9CiKLxTg',
  nonce: '4h_95klXJ5E_qnoN',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

describe('RFC 8291 message encryption', () => {
  it('reproduces the RFC test vector byte for byte', () => {
    const result = encryptMessage({
      plaintext: Buffer.from(RFC.plaintext, 'utf8'),
      uaPublic: b64urlDecode(RFC.uaPublic),
      authSecret: b64urlDecode(RFC.authSecret),
      senderPrivate: b64urlDecode(RFC.asPrivate),
      salt: b64urlDecode(RFC.salt),
    });
    expect(b64urlEncode(result.debug.senderPublic)).toBe(RFC.asPublic);
    expect(b64urlEncode(result.debug.cek)).toBe(RFC.cek);
    expect(b64urlEncode(result.debug.nonce)).toBe(RFC.nonce);
    expect(b64urlEncode(result.body)).toBe(RFC.body);
  });

  it('is decryptable by the browser side (round trip with the subscriber key)', () => {
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const auth = Buffer.alloc(16, 7);
    const message = encryptMessage({
      plaintext: Buffer.from('hello'),
      uaPublic: ua.getPublicKey(),
      authSecret: auth,
    });
    // Same derivation seen from the other side (RFC 8291 section 3.4).
    const senderPublic = message.body.subarray(21, 21 + 65);
    expect(senderPublic.equals(message.debug.senderPublic)).toBe(true);
    const again = encryptMessage({
      plaintext: Buffer.from('hello'),
      uaPublic: ua.getPublicKey(),
      authSecret: auth,
    });
    // A fresh key pair and salt every time.
    expect(again.body.equals(message.body)).toBe(false);
  });

  it('refuses a payload over 3993 bytes and a key that is not a curve point', () => {
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const base = { uaPublic: ua.getPublicKey(), authSecret: Buffer.alloc(16) };
    expect(() =>
      encryptMessage({ ...base, plaintext: Buffer.alloc(MAX_PLAINTEXT_BYTES) }),
    ).not.toThrow();
    expect(() =>
      encryptMessage({ ...base, plaintext: Buffer.alloc(MAX_PLAINTEXT_BYTES + 1) }),
    ).toThrow(PayloadTooLargeError);
    const offCurve = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]);
    expect(() =>
      encryptMessage({ ...base, uaPublic: offCurve, plaintext: Buffer.from('x') }),
    ).toThrow();
  });
});

describe('VAPID', () => {
  it('makes a key pair that matches, and detects one that does not', () => {
    const keys = generateVapidKeys();
    expect(b64urlDecode(keys.publicKey)).toHaveLength(65);
    expect(b64urlDecode(keys.privateKey)).toHaveLength(32);
    expect(vapidKeysMatch(keys)).toBe(true);
    expect(
      vapidKeysMatch({ publicKey: generateVapidKeys().publicKey, privateKey: keys.privateKey }),
    ).toBe(false);
    expect(vapidKeysMatch({ publicKey: 'x', privateKey: 'y' })).toBe(false);
  });

  it('signs an ES256 JWT that verifies with the public key, aud/exp/sub set', () => {
    const keys = generateVapidKeys();
    const now = Date.UTC(2026, 10, 4);
    const header = vapidAuthorization({
      keys,
      subject: 'mailto:ops@example.com',
      audience: 'https://fcm.googleapis.com',
      nowMs: now,
    });
    const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, head, claims, signature, k] = match ?? [];
    expect(k).toBe(keys.publicKey);
    expect(JSON.parse(b64urlDecode(head ?? '').toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    const parsed = JSON.parse(b64urlDecode(claims ?? '').toString()) as Record<string, unknown>;
    expect(parsed).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: now / 1000 + 12 * 3600,
      sub: 'mailto:ops@example.com',
    });
    const pub = b64urlDecode(keys.publicKey);
    const publicKey = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: b64urlEncode(pub.subarray(1, 33)),
        y: b64urlEncode(pub.subarray(33)),
      },
      format: 'jwk',
    });
    expect(b64urlDecode(signature ?? '')).toHaveLength(64);
    expect(
      verify(
        'sha256',
        Buffer.from(`${head ?? ''}.${claims ?? ''}`),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        b64urlDecode(signature ?? ''),
      ),
    ).toBe(true);
  });

  it('accepts a mailto: or https: subject only', () => {
    expect(isValidVapidSubject('mailto:ops@example.com')).toBe(true);
    expect(isValidVapidSubject('https://example.com/contact')).toBe(true);
    expect(isValidVapidSubject('http://example.com')).toBe(false);
    expect(isValidVapidSubject('ops@example.com')).toBe(false);
    expect(isValidVapidSubject('mailto:')).toBe(false);
  });
});

describe('endpoint allow-list', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/QabC',
    'https://api.push.apple.com/3/device/x',
    'https://wns2-par02p.notify.windows.com/w/?token=abc',
    'https://FCM.GOOGLEAPIS.COM./x',
  ])('accepts %s', (endpoint) => {
    expect(checkPushEndpoint(endpoint).ok).toBe(true);
  });

  it.each([
    ['http://fcm.googleapis.com/x', 'scheme'],
    ['https://127.0.0.1/x', 'host'],
    ['https://169.254.169.254/latest/meta-data', 'host'],
    ['https://[::1]/x', 'host'],
    ['https://localhost/x', 'host'],
    ['https://internal.example.com/x', 'host'],
    ['https://fcm.googleapis.com.evil.example/x', 'host'],
    ['https://evilfcm.googleapis.com/x', 'host'],
    ['https://notpush.apple.com.evil.example/x', 'host'],
    ['https://.push.apple.com/x', 'host'],
    ['https://push.apple.com/x', 'host'],
    ['https://fcm.googleapis.com@evil.example/x', 'credentials'],
    ['https://user:pw@fcm.googleapis.com/x', 'credentials'],
    ['https://fcm.googleapis.com:8443/x', 'port'],
    ['not a url', 'bad_url'],
    ['ftp://fcm.googleapis.com/x', 'scheme'],
    [`https://fcm.googleapis.com/${'a'.repeat(2100)}`, 'length'],
  ])('refuses %s (%s)', (endpoint, reason) => {
    const result = checkPushEndpoint(endpoint);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(reason);
  });

  it('isAllowedPushHost ignores case and a trailing dot', () => {
    expect(isAllowedPushHost('Updates.Push.Services.Mozilla.com.')).toBe(true);
  });
});

describe('buildPushRequest and classifyPushResponse', () => {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const subscription = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
    p256dh: b64urlEncode(ua.getPublicKey()),
    auth: b64urlEncode(Buffer.alloc(16, 3)),
  };
  const vapid = { keys: generateVapidKeys(), subject: 'mailto:ops@example.com' };
  const options = { ttlSeconds: 600, urgency: 'high', topic: 'wt-ticket_p1' } as const;

  it('sets the RFC 8030/8292 headers and encrypts the body', () => {
    const request = buildPushRequest({
      subscription,
      payload: Buffer.from('{"k":"ticket.p1"}'),
      options,
      vapid,
      nowMs: 0,
    });
    expect(request.url.host).toBe('fcm.googleapis.com');
    expect(request.headers).toMatchObject({
      'Content-Encoding': 'aes128gcm',
      TTL: '600',
      Urgency: 'high',
      Topic: 'wt-ticket_p1',
      'Content-Length': String(request.body.length),
    });
    expect(request.headers.Authorization).toMatch(/^vapid t=.+, k=.+$/);
    expect(request.body.toString('utf8')).not.toContain('ticket.p1');
  });

  it('refuses a forged endpoint, bad keys and a bad topic before any network', () => {
    const build = (override: object) =>
      buildPushRequest({
        subscription: { ...subscription, ...override },
        payload: Buffer.from('x'),
        options,
        vapid,
        nowMs: 0,
      });
    expect(() => build({ endpoint: 'https://169.254.169.254/x' })).toThrow(PushRequestError);
    expect(() => build({ p256dh: 'AAAA' })).toThrow(PushRequestError);
    expect(() => build({ auth: '***' })).toThrow(PushRequestError);
    expect(() =>
      buildPushRequest({
        subscription,
        payload: Buffer.from('x'),
        options: { ...options, topic: 'has space' },
        vapid,
        nowMs: 0,
      }),
    ).toThrow(PushRequestError);
  });

  it('reads the answer of the push service', () => {
    expect(classifyPushResponse(201, undefined)).toEqual({ kind: 'sent' });
    expect(classifyPushResponse(404, undefined)).toEqual({ kind: 'gone' });
    expect(classifyPushResponse(410, undefined)).toEqual({ kind: 'gone' });
    expect(classifyPushResponse(429, '30')).toEqual({ kind: 'retry', retryAfterSeconds: 30 });
    expect(classifyPushResponse(503, 'Wed, 21 Oct 2026 07:28:00 GMT')).toEqual({
      kind: 'retry',
      retryAfterSeconds: null,
    });
    expect(classifyPushResponse(413, undefined)).toEqual({ kind: 'rejected', status: 413 });
    expect(classifyPushResponse(403, undefined)).toEqual({ kind: 'rejected', status: 403 });
  });
});
