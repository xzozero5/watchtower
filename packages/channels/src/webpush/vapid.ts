import { createECDH, createPrivateKey, sign } from 'node:crypto';

import { b64urlDecode, b64urlEncode } from './base64url.js';

/** VAPID, RFC 8292: the sender proves who it is with an ES256 JWT and says which public key it signed with. */

export interface VapidKeys {
  /** 65-byte uncompressed P-256 point, base64url: what the browser gets as `applicationServerKey`. */
  readonly publicKey: string;
  /** 32-byte scalar, base64url. Secret. */
  readonly privateKey: string;
}

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey: b64urlEncode(ecdh.getPublicKey()),
    privateKey: b64urlEncode(ecdh.getPrivateKey()),
  };
}

/** True when `privateKey` is a P-256 scalar whose public point is `publicKey`. */
export function vapidKeysMatch(keys: VapidKeys): boolean {
  try {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(b64urlDecode(keys.privateKey));
    return ecdh.getPublicKey().equals(b64urlDecode(keys.publicKey));
  } catch {
    return false;
  }
}

/** RFC 8292 section 2.1: `sub` is a `mailto:` or `https:` contact for the push service operator. */
export function isValidVapidSubject(subject: string): boolean {
  if (subject.startsWith('mailto:')) return /^mailto:[^\s@]+@[^\s@]+$/.test(subject);
  try {
    return new URL(subject).protocol === 'https:';
  } catch {
    return false;
  }
}

/** RFC 8292 section 2: the JWT may live at most 24 hours. */
const LIFETIME_SECONDS = 12 * 3600;

export interface VapidHeaderInput {
  readonly keys: VapidKeys;
  readonly subject: string;
  /** `https://host` of the push service the request goes to. */
  readonly audience: string;
  readonly nowMs: number;
}

/** The value of the `Authorization` header: `vapid t=<jwt>, k=<public key>`. */
export function vapidAuthorization(input: VapidHeaderInput): string {
  const publicKey = b64urlDecode(input.keys.publicKey);
  const d = b64urlDecode(input.keys.privateKey);
  if (publicKey.length !== 65 || publicKey[0] !== 4 || d.length !== 32) {
    throw new Error('VAPID keys are not a P-256 key pair');
  }
  const key = createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: b64urlEncode(d),
      x: b64urlEncode(publicKey.subarray(1, 33)),
      y: b64urlEncode(publicKey.subarray(33, 65)),
    },
    format: 'jwk',
  });
  const header = b64urlEncode(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64urlEncode(
    Buffer.from(
      JSON.stringify({
        aud: input.audience,
        exp: Math.floor(input.nowMs / 1000) + LIFETIME_SECONDS,
        sub: input.subject,
      }),
    ),
  );
  const signingInput = `${header}.${claims}`;
  // ieee-p1363 = the fixed 64-byte r||s that JWS ES256 wants (not DER).
  const signature = sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${signingInput}.${b64urlEncode(signature)}, k=${input.keys.publicKey}`;
}
