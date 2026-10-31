import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { checkChallenge, hasWork, issueChallenge, solveChallenge } from './pow.js';
import {
  SelfHostedHumanVerification,
  type ReplayStore,
  type SelfHostedSettings,
} from './self-hosted-verification.js';

const key = randomBytes(32);
const t0 = new Date('2026-11-01T10:00:00.000Z');
const seconds = (n: number) => new Date(t0.getTime() + n * 1000);

describe('challenge', () => {
  it('is signed, carries its own difficulty and expires', () => {
    const issued = issueChallenge(key, { now: t0, ttlSeconds: 600, difficultyBits: 8 });
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{22}\.\d+\.\d+\.8\.[A-Za-z0-9_-]{43}$/);
    const checked = checkChallenge(key, issued.token, seconds(1));
    expect(checked).toMatchObject({ ok: true, id: issued.id, difficultyBits: 8 });
    expect(checkChallenge(key, issued.token, seconds(601))).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('rejects a changed difficulty, a changed expiry, another key and junk', () => {
    const { token } = issueChallenge(key, { now: t0, ttlSeconds: 600, difficultyBits: 20 });
    const parts = token.split('.');
    const easier = [...parts.slice(0, 3), '1', parts[4]].join('.');
    expect(checkChallenge(key, easier, seconds(1))).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    const longer = [parts[0], String(Number(parts[1]) + 99_999), ...parts.slice(2)].join('.');
    expect(checkChallenge(key, longer, seconds(1))).toEqual({ ok: false, reason: 'bad_signature' });
    expect(checkChallenge(randomBytes(32), token, seconds(1))).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(checkChallenge(key, 'nonsense', seconds(1))).toEqual({ ok: false, reason: 'malformed' });
    expect(checkChallenge(key, '', seconds(1))).toEqual({ ok: false, reason: 'malformed' });
  });

  it('gives every challenge its own id', () => {
    const a = issueChallenge(key, { now: t0, ttlSeconds: 60, difficultyBits: 8 });
    const b = issueChallenge(key, { now: t0, ttlSeconds: 60, difficultyBits: 8 });
    expect(a.id).not.toBe(b.id);
  });
});

describe('work', () => {
  it('accepts the nonce the solver finds and rejects a wrong one at high difficulty', () => {
    const { token } = issueChallenge(key, { now: t0, ttlSeconds: 60, difficultyBits: 12 });
    const nonce = solveChallenge(token, 12);
    expect(hasWork(token, nonce, 12)).toBe(true);
    // A nonce for one challenge is (almost certainly) not work for another.
    const other = issueChallenge(key, { now: t0, ttlSeconds: 60, difficultyBits: 12 });
    const wrong = Array.from({ length: 20 }, (_, i) => String(i)).filter(
      (candidate) => !hasWork(other.token, candidate, 12),
    );
    expect(wrong.length).toBeGreaterThan(15);
  });

  it('counts exact leading zero bits (difficulty 0 always passes)', () => {
    const { token } = issueChallenge(key, { now: t0, ttlSeconds: 60, difficultyBits: 8 });
    expect(hasWork(token, '0', 0)).toBe(true);
  });
});

class MemoryReplay implements ReplayStore {
  readonly used = new Map<string, number>();
  claim(id: string, ttlSeconds: number): Promise<boolean> {
    if (this.used.has(id)) return Promise.resolve(false);
    this.used.set(id, ttlSeconds);
    return Promise.resolve(true);
  }
}

function provider(overrides: Partial<SelfHostedSettings> = {}, now: () => Date = () => t0) {
  const replay = new MemoryReplay();
  const settings: SelfHostedSettings = {
    key,
    difficultyBits: 8,
    ttlSeconds: 600,
    minFillSeconds: 3,
    ...overrides,
  };
  return { replay, verification: new SelfHostedHumanVerification(settings, replay, now) };
}

describe('SelfHostedHumanVerification', () => {
  it('describes a challenge the page can solve', async () => {
    const { verification } = provider();
    const challenge = await verification.challenge();
    expect(challenge).toMatchObject({
      provider: 'pow-sha256',
      difficultyBits: 8,
      minFillSeconds: 3,
      issuedAt: t0.toISOString(),
    });
  });

  it('verifies a solved challenge once after the minimum fill time, and refuses it the second time', async () => {
    let clock = t0;
    const { verification, replay } = provider({}, () => clock);
    const { challenge } = await verification.challenge();
    const nonce = solveChallenge(challenge, 8);
    const proof = { provider: 'pow-sha256' as const, challenge, nonce };

    clock = seconds(4);
    const first = await verification.verify({ proof, honeypot: undefined });
    expect(first.ok).toBe(true);
    expect(replay.used.size).toBe(1);
    expect(await verification.verify({ proof, honeypot: '' })).toEqual({
      ok: false,
      reason: 'replayed',
    });
  });

  it('checks without storing anything, and claims separately so the limits can sit between (C-3)', async () => {
    const { verification, replay } = provider({ minFillSeconds: 0 });
    const { challenge } = await verification.challenge();
    const proof = {
      provider: 'pow-sha256' as const,
      challenge,
      nonce: solveChallenge(challenge, 8),
    };
    const checked = await verification.check({ proof, honeypot: undefined });
    expect(checked.ok).toBe(true);
    // The same proof can be checked as often as wanted: nothing is used up until the claim.
    expect((await verification.check({ proof, honeypot: undefined })).ok).toBe(true);
    expect(replay.used.size).toBe(0);
    if (!checked.ok) throw new Error('expected the proof to pass the check');
    expect(checked.remainingSeconds).toBeGreaterThan(0);
    expect(checked.remainingSeconds).toBeLessThanOrEqual(600);

    expect(await verification.claim(checked)).toEqual({
      ok: true,
      challengeId: checked.challengeId,
    });
    expect(replay.used.size).toBe(1);
    // Still passes the stateless check; only the claim notices the replay.
    expect((await verification.check({ proof, honeypot: undefined })).ok).toBe(true);
    expect(await verification.claim(checked)).toEqual({ ok: false, reason: 'replayed' });
  });

  it('refuses a submit that is too quick without using the challenge up', async () => {
    let clock = t0;
    const { verification, replay } = provider({}, () => clock);
    const { challenge } = await verification.challenge();
    const proof = {
      provider: 'pow-sha256' as const,
      challenge,
      nonce: solveChallenge(challenge, 8),
    };
    clock = seconds(1);
    expect(await verification.verify({ proof, honeypot: undefined })).toEqual({
      ok: false,
      reason: 'too_fast',
    });
    expect(replay.used.size).toBe(0);
    clock = seconds(3);
    expect((await verification.verify({ proof, honeypot: undefined })).ok).toBe(true);
  });

  it('refuses a filled honeypot before looking at anything else', async () => {
    const { verification, replay } = provider({ minFillSeconds: 0 });
    const { challenge } = await verification.challenge();
    const proof = {
      provider: 'pow-sha256' as const,
      challenge,
      nonce: solveChallenge(challenge, 8),
    };
    expect(await verification.verify({ proof, honeypot: 'http://spam.example' })).toEqual({
      ok: false,
      reason: 'honeypot',
    });
    expect(replay.used.size).toBe(0);
  });

  it('refuses insufficient work, an expired or foreign challenge, and never claims them', async () => {
    let clock = t0;
    const { verification, replay } = provider(
      { minFillSeconds: 0, difficultyBits: 20 },
      () => clock,
    );
    const { challenge } = await verification.challenge();
    const proof = { provider: 'pow-sha256' as const, challenge, nonce: '1' };
    expect(await verification.verify({ proof, honeypot: undefined })).toEqual({
      ok: false,
      reason: 'insufficient_work',
    });

    const foreign = issueChallenge(randomBytes(32), { now: t0, ttlSeconds: 60, difficultyBits: 4 });
    expect(
      await verification.verify({
        proof: { provider: 'pow-sha256', challenge: foreign.token, nonce: '0' },
        honeypot: undefined,
      }),
    ).toEqual({ ok: false, reason: 'bad_signature' });

    clock = seconds(601);
    expect(await verification.verify({ proof, honeypot: undefined })).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(replay.used.size).toBe(0);
  });

  it('uses the difficulty the server signed, not one the client names', async () => {
    const { verification } = provider({ minFillSeconds: 0, difficultyBits: 16 });
    const { challenge } = await verification.challenge();
    // Work that would satisfy 8 bits but (almost certainly) not 16.
    const weak = solveChallenge(challenge, 8);
    const proof = { provider: 'pow-sha256' as const, challenge, nonce: weak };
    const result = await verification.verify({ proof, honeypot: undefined });
    if (hasWork(challenge, weak, 16)) expect(result.ok).toBe(true);
    else expect(result).toEqual({ ok: false, reason: 'insufficient_work' });
  });
});
