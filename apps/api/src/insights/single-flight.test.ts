import { describe, expect, it } from 'vitest';

import { SingleFlightCache } from './single-flight.js';

describe('single-flight cache (C-11)', () => {
  it('runs one computation for callers that ask while it is running, and shares the result', async () => {
    const cache = new SingleFlightCache<number>(30_000);
    let release: (value: number) => void = () => undefined;
    let runs = 0;
    const slow = () =>
      new Promise<number>((resolve) => {
        runs += 1;
        release = resolve;
      });
    const calls = [cache.get('k', slow), cache.get('k', slow), cache.get('k', slow)];
    release(7);
    expect(await Promise.all(calls)).toEqual([7, 7, 7]);
    expect(runs).toBe(1);
    expect(cache.computations).toBe(1);
  });

  it('serves the result for the ttl and computes again after it', async () => {
    let now = 1_000;
    const cache = new SingleFlightCache<number>(30_000, 10, () => now);
    let n = 0;
    const compute = () => Promise.resolve((n += 1));
    expect(await cache.get('k', compute)).toBe(1);
    now += 29_000;
    expect(await cache.get('k', compute)).toBe(1);
    now += 2_000;
    expect(await cache.get('k', compute)).toBe(2);
  });

  it('keeps keys apart, forgets a failure, and stays bounded', async () => {
    const cache = new SingleFlightCache<string>(30_000, 2);
    expect(await cache.get('a', () => Promise.resolve('a'))).toBe('a');
    expect(await cache.get('b', () => Promise.resolve('b'))).toBe('b');
    await expect(cache.get('x', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await cache.get('x', () => Promise.resolve('again'))).toBe('again');
    // Three keys in a cache of two: the oldest was dropped, so asking for it computes again.
    expect(await cache.get('a', () => Promise.resolve('a2'))).toBe('a2');
  });
});
