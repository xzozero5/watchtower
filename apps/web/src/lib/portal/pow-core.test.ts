import { createHash } from 'node:crypto';

import { leadingZeroBits, powInput } from '@watchtower/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  hasWork,
  MAX_CLIENT_DIFFICULTY_BITS,
  PowAbortedError,
  PowRefusedError,
  solvePow,
} from './pow-core';

/**
 * Known vector, computed with node:crypto (the api's `hasWork` uses the same hash and the same
 * `<challenge>:<nonce>` text). For each difficulty the nonce is the smallest that works.
 */
const CHALLENGE =
  'Zm9vYmFyYmF6cXV4MTIzNA.1893456000.1893454200.12.c2lnbmF0dXJlLWZvci10ZXN0cy1vbmx5LTEyMzQ1Njc4OTA';
const VECTORS = [
  {
    bits: 8,
    nonce: '168',
    hash: '00d78e490730315839bcbe74a442c8b6f5b9ac95f84c8e7c776d42c69906c661',
  },
  {
    bits: 12,
    nonce: '4984',
    hash: '0002f3f905b4037478dac9cc66a86360515d90fd021269aafd4fd82632421e3c',
  },
  {
    bits: 16,
    nonce: '75501',
    hash: '00003b7eed4083d721de0ad8f35c09a1116e42d35370db4a10e17aefc4724955',
  },
] as const;

describe('WebCrypto SHA-256', () => {
  it('matches the published test vector for "abc"', async () => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('abc'));
    expect(Buffer.from(digest).toString('hex')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('solvePow', () => {
  for (const vector of VECTORS) {
    it(`finds the known smallest nonce at ${String(vector.bits)} bits`, async () => {
      const solution = await solvePow(CHALLENGE, { difficultyBits: vector.bits });
      expect(solution.nonce).toBe(vector.nonce);
      expect(solution.attempts).toBe(Number(vector.nonce) + 1);
    });

    it(`gives a nonce the api's own check accepts at ${String(vector.bits)} bits`, () => {
      // Independent of the solver: node:crypto and the shared leadingZeroBits, as apps/api does.
      const digest = createHash('sha256')
        .update(powInput(CHALLENGE, vector.nonce), 'utf8')
        .digest();
      expect(digest.toString('hex')).toBe(vector.hash);
      expect(leadingZeroBits(digest)).toBeGreaterThanOrEqual(vector.bits);
    });
  }

  it('returns the same nonce whatever the batch size', async () => {
    const vector = VECTORS[0];
    const maxAttempts = Number(vector.nonce) + 1;
    // Batch invariance is a correctness check, not a WebCrypto load benchmark. Bound the known
    // 8-bit vector so an oversized batch does not enqueue 100,000 digests under parallel tests.
    // The separate vector tests above still solve the 12-bit and 16-bit challenges in full.
    for (const batchSize of [1, 7, 512, 100_000]) {
      const solution = await solvePow(CHALLENGE, {
        difficultyBits: vector.bits,
        batchSize,
        maxAttempts,
      });
      expect(solution.nonce, `batch ${String(batchSize)}`).toBe(vector.nonce);
      expect(solution.attempts, `batch ${String(batchSize)}`).toBe(maxAttempts);
    }
  });

  it('hasWork agrees with the vectors and rejects a nonce one step too early', async () => {
    expect(await hasWork(CHALLENGE, '4984', 12)).toBe(true);
    expect(await hasWork(CHALLENGE, '4983', 12)).toBe(false);
  });

  it('reports progress after each batch', async () => {
    const onProgress = vi.fn<(attempts: number) => void>();
    await solvePow(CHALLENGE, { difficultyBits: 12, batchSize: 1000, onProgress });
    expect(onProgress.mock.calls.map(([attempts]) => attempts)).toEqual([1000, 2000, 3000, 4000]);
  });

  it('stops between batches when asked', async () => {
    let calls = 0;
    await expect(
      solvePow(CHALLENGE, {
        difficultyBits: 16,
        batchSize: 100,
        shouldStop: () => ++calls > 2,
      }),
    ).rejects.toBeInstanceOf(PowAbortedError);
  });

  it('refuses a difficulty that is not a whole number of bits or is too high for a phone', async () => {
    await expect(solvePow(CHALLENGE, { difficultyBits: 0 })).rejects.toBeInstanceOf(
      PowRefusedError,
    );
    await expect(solvePow(CHALLENGE, { difficultyBits: 2.5 })).rejects.toBeInstanceOf(
      PowRefusedError,
    );
    await expect(
      solvePow(CHALLENGE, { difficultyBits: MAX_CLIENT_DIFFICULTY_BITS + 1 }),
    ).rejects.toBeInstanceOf(PowRefusedError);
  });

  it('gives up after its attempt limit instead of running forever', async () => {
    await expect(
      solvePow(CHALLENGE, { difficultyBits: 20, maxAttempts: 100, batchSize: 50 }),
    ).rejects.toBeInstanceOf(PowRefusedError);
  });

  it('yields between batches when a pause function is given', async () => {
    const pause = vi.fn(() => Promise.resolve());
    await solvePow(CHALLENGE, { difficultyBits: 8, batchSize: 100, pause });
    expect(pause).toHaveBeenCalledTimes(1);
  });
});
