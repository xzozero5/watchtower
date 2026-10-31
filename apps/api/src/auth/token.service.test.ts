import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../config/config.js';
import { testEnv } from '../testing/support.js';
import { TokenService, generateOpaqueToken, hashOpaqueToken, safeEqual } from './token.service.js';

const config = (overrides: Record<string, string | undefined> = {}) =>
  loadConfig(testEnv({ JWT_SECRET: 'unit-test-secret-value', ...overrides }));
const claims = {
  userId: '6d8f0a1e-0000-4000-8000-000000000001',
  sessionId: '6d8f0a1e-0000-4000-8000-000000000002',
};

describe('opaque tokens', () => {
  it('are 256 random bits, url-safe, and different every time', () => {
    const a = generateOpaqueToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateOpaqueToken()).not.toBe(a);
  });

  it('are stored as a SHA-256 hex hash that does not contain the token', () => {
    const token = generateOpaqueToken();
    const hash = hashOpaqueToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    expect(hashOpaqueToken(token)).toBe(hash);
  });

  it('compare in constant time without throwing on different lengths', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('access tokens', () => {
  it('round-trip the user and the session, and expire when the config says', async () => {
    const service = new TokenService(config({ ACCESS_TOKEN_TTL_SECONDS: '120' }));
    const { token, expiresAt } = await service.signAccessToken(claims);
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(110_000);
    expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(120_000);
    await expect(service.verifyAccessToken(token)).resolves.toMatchObject(claims);
  });

  it('are rejected when tampered with, signed with another secret, or malformed', async () => {
    const service = new TokenService(config());
    const other = new TokenService(config({ JWT_SECRET: 'a-different-secret-entirely' }));
    const { token } = await service.signAccessToken(claims);
    const [header, payload, signature] = token.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ ...claims, sub: 'someone-else', sid: claims.sessionId }),
    ).toString('base64url');

    await expect(other.verifyAccessToken(token)).resolves.toBeNull();
    await expect(
      service.verifyAccessToken(`${header ?? ''}.${forgedPayload}.${signature ?? ''}`),
    ).resolves.toBeNull();
    await expect(
      service.verifyAccessToken(`${header ?? ''}.${payload ?? ''}.`),
    ).resolves.toBeNull();
    await expect(service.verifyAccessToken('not-a-jwt')).resolves.toBeNull();
    await expect(service.verifyAccessToken('')).resolves.toBeNull();
  });

  it('are rejected when expired, or for another audience, issuer or algorithm', async () => {
    const service = new TokenService(config());
    const key = new TextEncoder().encode('unit-test-secret-value');
    const base = () =>
      new SignJWT({ sid: claims.sessionId })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(claims.userId)
        .setIssuedAt()
        .setIssuer('watchtower')
        .setAudience('watchtower:api')
        .setExpirationTime('5m');

    await expect(service.verifyAccessToken(await base().sign(key))).resolves.not.toBeNull();
    const expired = await base()
      .setIssuedAt(Math.floor(Date.now() / 1000) - 600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 300)
      .sign(key);
    await expect(service.verifyAccessToken(expired)).resolves.toBeNull();
    await expect(
      service.verifyAccessToken(await base().setAudience('someone-else').sign(key)),
    ).resolves.toBeNull();
    await expect(
      service.verifyAccessToken(await base().setIssuer('not-us').sign(key)),
    ).resolves.toBeNull();
    // alg=none and a different HMAC algorithm are both refused.
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: claims.userId, sid: claims.sessionId, iss: 'watchtower', aud: 'watchtower:api', exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url')}.`;
    await expect(service.verifyAccessToken(none)).resolves.toBeNull();
    const hs512 = await new SignJWT({ sid: claims.sessionId })
      .setProtectedHeader({ alg: 'HS512' })
      .setSubject(claims.userId)
      .setIssuer('watchtower')
      .setAudience('watchtower:api')
      .setExpirationTime('5m')
      .sign(key);
    await expect(service.verifyAccessToken(hs512)).resolves.toBeNull();
  });

  it('refuses a token without a session id', async () => {
    const service = new TokenService(config());
    const key = new TextEncoder().encode('unit-test-secret-value');
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.userId)
      .setIssuer('watchtower')
      .setAudience('watchtower:api')
      .setExpirationTime('5m')
      .sign(key);
    await expect(service.verifyAccessToken(token)).resolves.toBeNull();
  });
});

describe('CSRF tokens', () => {
  it('belong to one session and are stable for it', () => {
    const service = new TokenService(config());
    const a = service.csrfTokenFor('session-a');
    expect(service.csrfTokenFor('session-a')).toBe(a);
    expect(service.csrfTokenFor('session-b')).not.toBe(a);
    expect(service.isValidCsrfToken('session-a', a)).toBe(true);
    expect(service.isValidCsrfToken('session-b', a)).toBe(false);
    expect(service.isValidCsrfToken('session-a', undefined)).toBe(false);
    expect(service.isValidCsrfToken('session-a', '')).toBe(false);
    expect(service.isValidCsrfToken('session-a', `${a}x`)).toBe(false);
  });

  it('depend on the server secret, and are not the access token or the session id', async () => {
    const one = new TokenService(config());
    const two = new TokenService(config({ JWT_SECRET: 'another-secret-value-here' }));
    const csrf = one.csrfTokenFor('session-a');
    expect(two.csrfTokenFor('session-a')).not.toBe(csrf);
    expect(csrf).not.toContain('session-a');
    const { token } = await one.signAccessToken(claims);
    expect(one.isValidCsrfToken(claims.sessionId, token)).toBe(false);
  });
});

describe('signed cookie values', () => {
  it('verify only for the purpose they were signed for', async () => {
    const service = new TokenService(config());
    const value = await service.signCookieValue('oidc-state', { state: 's1' }, 60);
    await expect(service.verifyCookieValue('oidc-state', value)).resolves.toMatchObject({
      state: 's1',
    });
    await expect(service.verifyCookieValue('something-else', value)).resolves.toBeNull();
    const { token } = await service.signAccessToken(claims);
    await expect(service.verifyCookieValue('oidc-state', token)).resolves.toBeNull();
    await expect(service.verifyAccessToken(value)).resolves.toBeNull();
  });
});
