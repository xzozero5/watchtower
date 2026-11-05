import { describe, expect, it, vi } from 'vitest';

import { ProviderUnavailableError } from '../audited.js';
import type { LlmProvider, LlmRequest } from '../contract.js';
import {
  ConcurrencyLimitError,
  createConcurrencyLimiter,
  isAssistantRequest,
  limitConcurrency,
  observeQueue,
  warnIfSingleProcessAssumptionBroken,
} from './concurrency-limit.js';

const asRequest = (promptId: string, abortSignal?: AbortSignal): LlmRequest =>
  // eslint-disable-next-line watchtower/no-redacted-text-cast -- fixture carries only prompt metadata and a signal, no text reaches a model
  ({
    prompt: { id: promptId, version: 1, hash: '0'.repeat(64) },
    abortSignal,
  }) as unknown as LlmRequest;
const request = asRequest('claim_summary');
const assistant = (signal?: AbortSignal) => asRequest('assistant_plan', signal);

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
  return {
    provider,
    release: () => open.shift()?.(),
    releaseAt: (index: number) => open.splice(index, 1)[0]?.(),
    peak: () => peak,
    active: () => active,
  };
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

describe('limitConcurrency: slots kept for summaries (T-155a C-4)', () => {
  const options = { maxConcurrent: 2, reservedSlots: 1, isLowPriority: isAssistantRequest };

  it('knows the assistant by its prompt ids', () => {
    expect(isAssistantRequest(assistant())).toBe(true);
    expect(isAssistantRequest(asRequest('assistant_answer'))).toBe(true);
    expect(isAssistantRequest(request)).toBe(false);
  });

  it('lets the assistant use all but the reserved slots, and a summary take the one that is left', async () => {
    const g = gated();
    const limited = limitConcurrency(g.provider, options);
    const chats = [limited.generate(assistant()), limited.generate(assistant())];
    await tick();
    // Two assistant calls but only one slot for them: the second waits.
    expect(g.active()).toBe(1);
    const summary = limited.generate(request);
    await tick();
    expect(g.active()).toBe(2);
    g.release();
    g.release();
    await tick();
    g.release();
    await Promise.all([...chats, summary]);
    expect(g.peak()).toBe(2);
  });

  it('passes over a waiting assistant call when only a summary may take the freed slot', async () => {
    const g = gated();
    const limited = limitConcurrency(g.provider, options);
    const order: string[] = [];
    const run = (name: string, req: LlmRequest) =>
      limited.generate(req).then(() => {
        order.push(name);
      });
    const chat1 = run('chat-1', assistant());
    const summary1 = run('summary-1', request);
    const chat2 = run('chat-2', assistant());
    const summary2 = run('summary-2', request);
    await tick();
    // chat-1 and summary-1 run; chat-2 and summary-2 wait.
    expect(g.active()).toBe(2);
    g.releaseAt(1); // summary-1 ends: one assistant call is already running, so chat-2 may not take the slot
    await tick();
    expect(g.active()).toBe(2);
    g.releaseAt(1); // the call that took it is summary-2, which was queued behind chat-2
    await tick();
    expect(order).toEqual(['summary-1', 'summary-2']);
    g.release(); // chat-1 ends: now chat-2 runs
    await tick();
    expect(g.active()).toBe(1);
    g.release();
    await Promise.all([chat1, chat2, summary1, summary2]);
    expect(order).toEqual(['summary-1', 'summary-2', 'chat-1', 'chat-2']);
    expect(g.peak()).toBe(2);
  });

  it('never reserves the only slot', async () => {
    const g = gated();
    const limited = limitConcurrency(g.provider, {
      maxConcurrent: 1,
      reservedSlots: 5,
      isLowPriority: isAssistantRequest,
    });
    const call = limited.generate(assistant());
    await tick();
    expect(g.active()).toBe(1);
    g.release();
    await call;
  });
});

describe('limitConcurrency: a request that is aborted (T-155a C-4)', () => {
  it('leaves the queue at once and never takes the slot', async () => {
    const g = gated();
    const limited = limitConcurrency(g.provider, { maxConcurrent: 1 });
    const first = limited.generate(request);
    const controller = new AbortController();
    const waiting = limited.generate(asRequest('claim_summary', controller.signal));
    await tick();
    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(ProviderUnavailableError);
    g.release();
    await first;
    // Nothing is left in the queue: the next call runs at once.
    const next = limited.generate(request);
    await tick();
    expect(g.active()).toBe(1);
    g.release();
    await next;
  });

  it('does not start a call whose request is already aborted', async () => {
    const g = gated();
    const limited = limitConcurrency(g.provider, { maxConcurrent: 1 });
    await expect(
      limited.generate(asRequest('claim_summary', AbortSignal.abort())),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(g.active()).toBe(0);
  });
});

describe('createConcurrencyLimiter: queue position and refusal reasons (T-408)', () => {
  it('tells the observer where its call is in the queue, then that it runs', async () => {
    const g = gated();
    const limiter = createConcurrencyLimiter({ maxConcurrent: 1 });
    const limited = limiter.limit(g.provider);
    const first = limited.generate(request);
    const positions: number[] = [];
    const second = observeQueue({ onPosition: (p) => positions.push(p) }, () =>
      limited.generate(request),
    );
    const third = limited.generate(request);
    await tick();
    expect(positions).toEqual([1]);
    expect(limiter.snapshot()).toMatchObject({ active: 1, queued: 2 });
    g.release();
    await first;
    await tick();
    // Granted: 0 (it runs now).
    expect(positions).toEqual([1, 0]);
    g.release();
    await second;
    g.release();
    await third;
  });

  it('moves a waiter up when the one in front of it leaves', async () => {
    const g = gated();
    const limiter = createConcurrencyLimiter({ maxConcurrent: 1 });
    const limited = limiter.limit(g.provider);
    const first = limited.generate(request);
    const abort = new AbortController();
    const ahead = limited.generate(asRequest('claim_summary', abort.signal));
    const positions: number[] = [];
    const behind = observeQueue({ onPosition: (p) => positions.push(p) }, () =>
      limited.generate(request),
    );
    await tick();
    expect(positions).toEqual([2]);
    abort.abort();
    await expect(ahead).rejects.toBeInstanceOf(ConcurrencyLimitError);
    expect(positions).toEqual([2, 1]);
    g.release();
    await first;
    g.release();
    await behind;
  });

  it('says why it refused: queue_full, wait_timeout, aborted', async () => {
    vi.useFakeTimers();
    try {
      const g = gated();
      const limiter = createConcurrencyLimiter({ maxConcurrent: 1, maxQueued: 1, maxWaitMs: 500 });
      const limited = limiter.limit(g.provider);
      void limited.generate(request);
      const waiting = limited.generate(request);
      const seen: string[] = [];
      const observer = { onRejected: (why: string) => seen.push(why) };
      const full = observeQueue(observer, () => limited.generate(request));
      await expect(full).rejects.toMatchObject({ rejection: 'queue_full' });
      expect(limiter.full()).toBe(true);
      const timedOut = expect(waiting).rejects.toMatchObject({ rejection: 'wait_timeout' });
      await vi.advanceTimersByTimeAsync(501);
      await timedOut;
      const gone = new AbortController();
      gone.abort();
      await expect(
        observeQueue(observer, () => limited.generate(asRequest('x', gone.signal))),
      ).rejects.toBeInstanceOf(ProviderUnavailableError);
      expect(seen).toEqual(['queue_full', 'aborted']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('frees the slot when the call that holds it is aborted by the provider', async () => {
    const abort = new AbortController();
    const slow: LlmProvider = {
      kind: 'claude-cli',
      generate: (r) =>
        new Promise((_, reject) => {
          r.abortSignal?.addEventListener('abort', () => {
            reject(new Error('stopped'));
          });
        }),
    };
    const limiter = createConcurrencyLimiter({ maxConcurrent: 1 });
    const running = limiter.limit(slow).generate(asRequest('x', abort.signal));
    await tick();
    expect(limiter.snapshot().active).toBe(1);
    abort.abort();
    await expect(running).rejects.toThrow('stopped');
    expect(limiter.snapshot().active).toBe(0);
  });

  it('tryAcquire never waits: a slot or null, and it respects the reserved slots and the queue', async () => {
    const g = gated();
    const limiter = createConcurrencyLimiter({ maxConcurrent: 2, reservedSlots: 1 });
    const a = limiter.tryAcquire();
    expect(a).not.toBeNull();
    // The low-priority share (one slot) is used.
    expect(limiter.tryAcquire()).toBeNull();
    // A call that is not low priority may use the reserved one.
    const b = limiter.tryAcquire(false);
    expect(b).not.toBeNull();
    expect(limiter.tryAcquire(false)).toBeNull();
    a?.();
    a?.(); // releasing twice frees one slot only
    expect(limiter.snapshot().active).toBe(1);
    b?.();
    expect(limiter.snapshot().active).toBe(0);

    // Somebody queued: a background caller does not jump the queue.
    const full = createConcurrencyLimiter({ maxConcurrent: 1 });
    const limited = full.limit(g.provider);
    const running = limited.generate(request);
    const queued = limited.generate(request);
    await tick();
    expect(full.tryAcquire()).toBeNull();
    g.release();
    await running;
    g.release();
    await queued;
    expect(full.tryAcquire()).not.toBeNull();
  });
});

describe('warnIfSingleProcessAssumptionBroken (T-400 C-19)', () => {
  it('stays quiet for one process and warns once for more', () => {
    const warn = vi.fn();
    expect(warnIfSingleProcessAssumptionBroken('api', undefined, warn)).toBe(false);
    expect(warnIfSingleProcessAssumptionBroken('worker', 1, warn)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(warnIfSingleProcessAssumptionBroken('api', 2, warn)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toEqual({ who: 'api', replicas: 2 });
  });
});
