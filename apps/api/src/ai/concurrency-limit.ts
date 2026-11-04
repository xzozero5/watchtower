import {
  ProviderUnavailableError,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from '@watchtower/ai';

/**
 * Caps how many model calls the api has in flight at once, so the assistant cannot take every slot of
 * the claude-bridge (default 4 slots, ADR-023 "Live provider"): the worker's ticket jobs keep theirs.
 * A call over the cap waits in a short queue; a full queue or a wait that is too long answers
 * `ProviderUnavailableError` (the turn ends as "unavailable", nothing is sent to the model).
 */
export interface ConcurrencyLimitOptions {
  readonly maxConcurrent: number;
  /** Calls allowed to wait for a slot. */
  readonly maxQueued?: number;
  /** How long a call may wait for a slot, ms. */
  readonly maxWaitMs?: number;
}

export function limitConcurrency(
  inner: LlmProvider,
  options: ConcurrencyLimitOptions,
): LlmProvider {
  const max = Math.max(1, Math.floor(options.maxConcurrent));
  const maxQueued = options.maxQueued ?? 8;
  const maxWaitMs = options.maxWaitMs ?? 60_000;
  let active = 0;
  const waiters: { grant: () => void; timer: NodeJS.Timeout }[] = [];

  const acquire = (): Promise<void> => {
    if (active < max) {
      active += 1;
      return Promise.resolve();
    }
    if (waiters.length >= maxQueued) {
      return Promise.reject(new ProviderUnavailableError(`${inner.kind}: the AI is busy`));
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        grant: () => {
          clearTimeout(waiter.timer);
          resolve();
        },
        timer: setTimeout(() => {
          const at = waiters.indexOf(waiter);
          if (at >= 0) waiters.splice(at, 1);
          reject(new ProviderUnavailableError(`${inner.kind}: waited too long for a free slot`));
        }, maxWaitMs),
      };
      waiters.push(waiter);
    });
  };
  const release = (): void => {
    const next = waiters.shift();
    // The slot passes straight to the next waiter, so `active` stays the same.
    if (next === undefined) active -= 1;
    else next.grant();
  };

  return {
    kind: inner.kind,
    async generate(request: LlmRequest): Promise<LlmResponse> {
      await acquire();
      try {
        return await inner.generate(request);
      } finally {
        release();
      }
    },
  };
}
