import { ProviderUnavailableError, type LlmProvider, type LlmRequest } from '@watchtower/ai';
import { describe, expect, it, vi } from 'vitest';

import { limitConcurrency } from './concurrency-limit.js';

const request: LlmRequest = undefined as never;

/** A provider whose calls end when the test says so. */
function gated() {
  let active = 0;
  let peak = 0;
  const open: (() => void)[] = [];
  const provider: LlmProvider = {
    kind: 'claude-cli',
    generate() {
      active += 1;
      peak = Math.max(peak, active);
      return new Promise((resolve) => {
        open.push(() => {
          active -= 1;
          resolve({
            text: 'ok',
            finishReason: 'stop',
            usage: { inputTokens: 1, outputTokens: 1 },
            model: 'm',
          });
        });
      });
    },
  };
  return { provider, release: () => open.shift()?.(), peak: () => peak, active: () => active };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('limitConcurrency', () => {
  it('never runs more calls than the cap and passes the slot on in order', async () => {
    const g = gated();
    const limited = limitConcurrency(g.provider, { maxConcurrent: 2 });
    const all = [1, 2, 3, 4].map(() => limited.generate(request));
    await tick();
    expect(g.active()).toBe(2);
    g.release();
    await tick();
    expect(g.active()).toBe(2);
    g.release();
    await tick();
    g.release();
    await tick();
    g.release();
    await tick();
    g.release();
    await Promise.all(all);
    expect(g.peak()).toBe(2);
  });

  it('frees the slot when a call fails', async () => {
    const failing: LlmProvider = {
      kind: 'claude-cli',
      generate: () => Promise.reject(new Error('boom')),
    };
    const limited = limitConcurrency(failing, { maxConcurrent: 1 });
    await expect(limited.generate(request)).rejects.toThrow('boom');
    await expect(limited.generate(request)).rejects.toThrow('boom');
  });

  it('refuses when the queue is full, as unavailable', async () => {
    const g = gated();
    const limited = limitConcurrency(g.provider, { maxConcurrent: 1, maxQueued: 1 });
    const first = limited.generate(request);
    const second = limited.generate(request);
    await expect(limited.generate(request)).rejects.toBeInstanceOf(ProviderUnavailableError);
    g.release();
    await first;
    g.release();
    await second;
  });

  it('gives up a wait that is too long, as unavailable', async () => {
    vi.useFakeTimers();
    try {
      const g = gated();
      const limited = limitConcurrency(g.provider, { maxConcurrent: 1, maxWaitMs: 1000 });
      void limited.generate(request);
      const waiting = limited.generate(request);
      const assertion = expect(waiting).rejects.toBeInstanceOf(ProviderUnavailableError);
      await vi.advanceTimersByTimeAsync(1001);
      await assertion;
      // The abandoned waiter does not take the slot later.
      g.release();
      await vi.advanceTimersByTimeAsync(0);
      expect(g.active()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
