import { disableNetConnect } from '@watchtower/shared/testing';
import {
  SignJWT,
  createLocalJWKSet,
  errors as joseErrors,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JWK,
} from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PushAuthError,
  PushKeysUnavailableError,
  createOidcPushVerifier,
  type PushTokenVerifier,
} from './push-verifier.js';

// The OIDC check of the Gmail push receiver, with a key pair generated here. The verifier is given
// a local key set, so nothing is fetched from Google; disableNetConnect proves it (N1).
const AUDIENCE = 'https://watchtower.example.com/v1/inbound/gmail/push';
const SERVICE_ACCOUNT = 'pubsub-push@project-id.iam.gserviceaccount.example.com';
const NOW = new Date('2026-11-01T03:00:00Z');
const nowSeconds = Math.floor(NOW.getTime() / 1000);

const net = disableNetConnect();
let privateKey: CryptoKey;
let otherPrivateKey: CryptoKey;
let verifier: PushTokenVerifier;

async function sign(
  claims: Record<string, unknown> = {},
  options: { key?: CryptoKey; kid?: string; alg?: string } = {},
): Promise<string> {
  return new SignJWT({
    email: SERVICE_ACCOUNT,
    email_verified: true,
    ...claims,
  })
    .setProtectedHeader({ alg: options.alg ?? 'RS256', kid: options.kid ?? 'test-key-1' })
    .setIssuer('https://accounts.google.com')
    .setAudience(AUDIENCE)
    .setSubject('1234567890')
    .setIssuedAt(nowSeconds - 60)
    .setExpirationTime(nowSeconds + 3540)
    .sign(options.key ?? privateKey);
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  otherPrivateKey = other.privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'test-key-1', alg: 'RS256' };
  verifier = createOidcPushVerifier({
    audience: AUDIENCE,
    serviceAccountEmail: SERVICE_ACCOUNT,
    keys: createLocalJWKSet({ keys: [jwk] }),
    now: () => NOW,
  });
});

afterAll(() => {
  expect(net.blocked()).toEqual([]);
  net.restore();
});

describe('createOidcPushVerifier', () => {
  it('accepts a token for the audience from the configured service account', async () => {
    await expect(verifier.verify(await sign())).resolves.toEqual({ email: SERVICE_ACCOUNT });
  });

  it('accepts the bare issuer spelling and compares the email without regard to case', async () => {
    const token = await new SignJWT({ email: SERVICE_ACCOUNT.toUpperCase(), email_verified: true })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuer('accounts.google.com')
      .setAudience(AUDIENCE)
      .setIssuedAt(nowSeconds - 60)
      .setExpirationTime(nowSeconds + 3000)
      .sign(privateKey);
    await expect(verifier.verify(token)).resolves.toEqual({ email: SERVICE_ACCOUNT });
  });

  it('rejects the wrong audience, the wrong service account and an unverified email', async () => {
    const badAudience = await new SignJWT({ email: SERVICE_ACCOUNT, email_verified: true })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuer('https://accounts.google.com')
      .setAudience('https://elsewhere.example.com')
      .setIssuedAt(nowSeconds - 60)
      .setExpirationTime(nowSeconds + 3000)
      .sign(privateKey);
    await expect(verifier.verify(badAudience)).rejects.toBeInstanceOf(PushAuthError);
    await expect(
      verifier.verify(await sign({ email: 'someone-else@example.com' })),
    ).rejects.toBeInstanceOf(PushAuthError);
    await expect(verifier.verify(await sign({ email_verified: false }))).rejects.toBeInstanceOf(
      PushAuthError,
    );
    await expect(verifier.verify(await sign({ email: undefined }))).rejects.toBeInstanceOf(
      PushAuthError,
    );
  });

  it('rejects another issuer', async () => {
    const token = await new SignJWT({ email: SERVICE_ACCOUNT, email_verified: true })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuer('https://issuer.example.com')
      .setAudience(AUDIENCE)
      .setIssuedAt(nowSeconds - 60)
      .setExpirationTime(nowSeconds + 3000)
      .sign(privateKey);
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(PushAuthError);
  });

  it('rejects an expired token (beyond the 60 s tolerance) and a token with no expiry', async () => {
    const expired = await new SignJWT({ email: SERVICE_ACCOUNT, email_verified: true })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuer('https://accounts.google.com')
      .setAudience(AUDIENCE)
      .setIssuedAt(nowSeconds - 7200)
      .setExpirationTime(nowSeconds - 3600)
      .sign(privateKey);
    await expect(verifier.verify(expired)).rejects.toBeInstanceOf(PushAuthError);
    const noExpiry = await new SignJWT({ email: SERVICE_ACCOUNT, email_verified: true })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuer('https://accounts.google.com')
      .setAudience(AUDIENCE)
      .setIssuedAt(nowSeconds - 60)
      .sign(privateKey);
    await expect(verifier.verify(noExpiry)).rejects.toBeInstanceOf(PushAuthError);
  });

  it('rejects a token signed by another key, an unknown kid, a wrong algorithm and garbage', async () => {
    await expect(verifier.verify(await sign({}, { key: otherPrivateKey }))).rejects.toBeInstanceOf(
      PushAuthError,
    );
    await expect(verifier.verify(await sign({}, { kid: 'unknown' }))).rejects.toBeInstanceOf(
      PushAuthError,
    );
    const unsigned = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(
      JSON.stringify({
        iss: 'https://accounts.google.com',
        aud: AUDIENCE,
        email: SERVICE_ACCOUNT,
        email_verified: true,
        exp: nowSeconds + 3000,
        iat: nowSeconds,
      }),
    ).toString('base64url')}.`;
    await expect(verifier.verify(unsigned)).rejects.toBeInstanceOf(PushAuthError);
    await expect(verifier.verify('not-a-jwt')).rejects.toBeInstanceOf(PushAuthError);
  });
});

describe('token age', () => {
  async function stamped(iat: number, exp: number): Promise<string> {
    return new SignJWT({ email: SERVICE_ACCOUNT, email_verified: true })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuer('https://accounts.google.com')
      .setAudience(AUDIENCE)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(privateKey);
  }

  it('rejects a token minted more than an hour ago even when its exp is still ahead', async () => {
    await expect(
      verifier.verify(await stamped(nowSeconds - 7200, nowSeconds + 3600)),
    ).rejects.toBeInstanceOf(PushAuthError);
    // Just inside the hour is fine.
    await expect(
      verifier.verify(await stamped(nowSeconds - 3500, nowSeconds + 100)),
    ).resolves.toBeDefined();
  });

  it('rejects a token stamped in the future beyond the clock tolerance, accepts a small skew', async () => {
    await expect(
      verifier.verify(await stamped(nowSeconds + 3600, nowSeconds + 7200)),
    ).rejects.toBeInstanceOf(PushAuthError);
    await expect(
      verifier.verify(await stamped(nowSeconds + 300, nowSeconds + 3900)),
    ).rejects.toBeInstanceOf(PushAuthError);
    await expect(
      verifier.verify(await stamped(nowSeconds + 30, nowSeconds + 3630)),
    ).resolves.toBeDefined();
  });
});

describe('key source failures', () => {
  const failing = (error: Error) =>
    createOidcPushVerifier({
      audience: AUDIENCE,
      serviceAccountEmail: SERVICE_ACCOUNT,
      keys: () => Promise.reject(error),
      now: () => NOW,
    });

  it('are PushKeysUnavailableError (retryable 503), not a rejected token', async () => {
    const token = await sign();
    for (const error of [
      new joseErrors.JWKSTimeout(),
      new joseErrors.JWKSInvalid('bad key set'),
      new joseErrors.JOSEError('Expected 200 OK from the JSON Web Key Set HTTP response'),
      new TypeError('fetch failed'),
    ]) {
      await expect(failing(error).verify(token)).rejects.toBeInstanceOf(PushKeysUnavailableError);
    }
  });

  it('stay a rejected token when the key set is fine and the token is not', async () => {
    const token = await sign();
    await expect(failing(new joseErrors.JWKSNoMatchingKey()).verify(token)).rejects.toBeInstanceOf(
      PushAuthError,
    );
  });
});
