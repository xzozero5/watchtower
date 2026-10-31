import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { leadingZeroBits, powInput } from '@watchtower/shared';

/**
 * Proof-of-work for the public portal (ADR-007), pure functions over `node:crypto`.
 *
 * A challenge is stateless and signed by the server:
 *
 *   `<id>.<expiresAt>.<issuedAt>.<difficultyBits>.<signature>`
 *
 * `id` is 128 random bits (base64url), the times are epoch seconds, and `signature` is
 * HMAC-SHA-256 over `pow1|id|expiresAt|issuedAt|difficultyBits` (base64url). A client solves it by
 * finding a decimal `nonce` such that SHA-256 of the UTF-8 text `<challenge>:<nonce>` starts with at
 * least `difficultyBits` zero bits. Single use is enforced by the caller (Redis), not here.
 */

const VERSION = 'pow1';

export interface IssuedChallenge {
  /** The opaque string the client gets. */
  readonly token: string;
  readonly id: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly difficultyBits: number;
}

export type ChallengeCheck =
  | {
      readonly ok: true;
      readonly id: string;
      readonly issuedAt: Date;
      readonly expiresAt: Date;
      readonly difficultyBits: number;
    }
  | { readonly ok: false; readonly reason: 'malformed' | 'bad_signature' | 'expired' };

function sign(key: Buffer, id: string, expires: number, issued: number, bits: number): string {
  return createHmac('sha256', key)
    .update(`${VERSION}|${id}|${String(expires)}|${String(issued)}|${String(bits)}`)
    .digest('base64url');
}

export function issueChallenge(
  key: Buffer,
  options: { readonly now: Date; readonly ttlSeconds: number; readonly difficultyBits: number },
): IssuedChallenge {
  const id = randomBytes(16).toString('base64url');
  const issued = Math.floor(options.now.getTime() / 1000);
  const expires = issued + options.ttlSeconds;
  const signature = sign(key, id, expires, issued, options.difficultyBits);
  return {
    token: `${id}.${String(expires)}.${String(issued)}.${String(options.difficultyBits)}.${signature}`,
    id,
    issuedAt: new Date(issued * 1000),
    expiresAt: new Date(expires * 1000),
    difficultyBits: options.difficultyBits,
  };
}

const SHAPE = /^([A-Za-z0-9_-]{22})\.(\d{1,12})\.(\d{1,12})\.(\d{1,2})\.([A-Za-z0-9_-]{43})$/;

/** Checks the shape, the signature and the expiry of a challenge. Says nothing about the solution. */
export function checkChallenge(key: Buffer, token: string, now: Date): ChallengeCheck {
  const match = SHAPE.exec(token);
  if (!match) return { ok: false, reason: 'malformed' };
  const [, id = '', expiresText = '', issuedText = '', bitsText = '', signature = ''] = match;
  const expires = Number(expiresText);
  const issued = Number(issuedText);
  const bits = Number(bitsText);
  const expected = Buffer.from(sign(key, id, expires, issued, bits));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: 'bad_signature' };
  }
  if (now.getTime() >= expires * 1000) return { ok: false, reason: 'expired' };
  return {
    ok: true,
    id,
    issuedAt: new Date(issued * 1000),
    expiresAt: new Date(expires * 1000),
    difficultyBits: bits,
  };
}

/** True when `nonce` solves the challenge at `difficultyBits`. */
export function hasWork(token: string, nonce: string, difficultyBits: number): boolean {
  const digest = createHash('sha256').update(powInput(token, nonce), 'utf8').digest();
  return leadingZeroBits(digest) >= difficultyBits;
}

/**
 * Finds a nonce by brute force. The browser does this in a Web Worker; the server only uses it in
 * tests and tools, so it is bounded to keep a bad difficulty from hanging a process.
 */
export function solveChallenge(
  token: string,
  difficultyBits: number,
  maxIterations = 50_000_000,
): string {
  for (let nonce = 0; nonce < maxIterations; nonce += 1) {
    const candidate = String(nonce);
    if (hasWork(token, candidate, difficultyBits)) return candidate;
  }
  throw new Error('no solution found within the iteration limit');
}
