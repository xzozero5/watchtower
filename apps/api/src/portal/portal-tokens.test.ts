import { randomBytes, randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { derivePortalKey, PORTAL_KEY_LABELS } from './portal-keys.js';
import { hashToken, mintToken, verifyToken } from './portal-tokens.js';

const key = randomBytes(32);
const now = new Date('2026-11-01T10:00:00.000Z');
const in90Days = new Date(now.getTime() + 90 * 24 * 3600 * 1000);

describe('tracking token', () => {
  it('round-trips the ticket id and the expiry', () => {
    const ticketId = randomUUID();
    const minted = mintToken(key, ticketId, in90Days);
    expect(minted.token).toMatch(
      /^wtp1\.[0-9a-f]{32}\.[0-9a-z]+\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/,
    );
    expect(verifyToken(key, minted.token, now)).toEqual({ ticketId, expiresAt: minted.expiresAt });
    expect(minted.token).not.toContain(ticketId);
  });

  it('is different every time even for the same ticket', () => {
    const ticketId = randomUUID();
    expect(mintToken(key, ticketId, in90Days).token).not.toBe(
      mintToken(key, ticketId, in90Days).token,
    );
  });

  it('expires', () => {
    const { token } = mintToken(key, randomUUID(), in90Days);
    expect(verifyToken(key, token, new Date(in90Days.getTime() - 1000))).not.toBeNull();
    expect(verifyToken(key, token, in90Days)).toBeNull();
    expect(verifyToken(key, token, new Date(in90Days.getTime() + 1))).toBeNull();
  });

  it('rejects a token for another ticket, an extended expiry, another key and junk', () => {
    const { token } = mintToken(key, randomUUID(), in90Days);
    const parts = token.split('.');
    const otherTicket = [parts[0], randomUUID().replaceAll('-', ''), ...parts.slice(2)].join('.');
    expect(verifyToken(key, otherTicket, now)).toBeNull();
    const extended = [
      parts[0],
      parts[1],
      (parseInt(parts[2] ?? '0', 36) + 10_000_000).toString(36),
      ...parts.slice(3),
    ].join('.');
    expect(verifyToken(key, extended, now)).toBeNull();
    expect(verifyToken(randomBytes(32), token, now)).toBeNull();
    for (const junk of [
      '',
      'wtp1',
      'wtp1.a.b.c.d',
      token.slice(0, -1),
      `${token}x`,
      'x'.repeat(5000),
    ]) {
      expect(verifyToken(key, junk, now)).toBeNull();
    }
  });

  it('is stored only as a SHA-256 hex digest', () => {
    const { token } = mintToken(key, randomUUID(), in90Days);
    const hash = hashToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    expect(hashToken(token)).toBe(hash);
  });
});

describe('derivePortalKey', () => {
  const config = { PORTAL_TOKEN_SECRET: undefined, APP_ENCRYPTION_KEY: 'a'.repeat(44) };

  it('derives a separate 256-bit key per purpose from the encryption key', () => {
    const tracking = derivePortalKey(config, PORTAL_KEY_LABELS.trackingToken);
    const pow = derivePortalKey(config, PORTAL_KEY_LABELS.proofOfWork);
    expect(tracking).toHaveLength(32);
    expect(tracking.equals(pow)).toBe(false);
    expect(tracking.equals(derivePortalKey(config, PORTAL_KEY_LABELS.trackingToken))).toBe(true);
  });

  it('prefers PORTAL_TOKEN_SECRET when it is set', () => {
    const own = derivePortalKey(
      { ...config, PORTAL_TOKEN_SECRET: 's'.repeat(40) },
      PORTAL_KEY_LABELS.trackingToken,
    );
    expect(own.equals(derivePortalKey(config, PORTAL_KEY_LABELS.trackingToken))).toBe(false);
  });
});
