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
 *
 * `reservedSlots` (T-155a C-4): calls for which `isLowPriority` is true (the assistant) may use at most
 * `maxConcurrent - reservedSlots` slots together, so the AI summaries on the screens always find one
 * free and a few people chatting cannot starve them. A queued call whose request is aborted (the
 * person closed the page) leaves the queue at once.
 */
export interface ConcurrencyLimitOptions {
  readonly maxConcurrent: number;
  /** Calls allowed to wait for a slot. */
  readonly maxQueued?: number;
  /** How long a call may wait for a slot, ms. */
  readonly maxWaitMs?: number;
  /** Slots that low-priority calls may not use. Capped so that at least one slot is left for them. */
  readonly reservedSlots?: number;
  /** Which calls are low priority. Default: none. */
  readonly isLowPriority?: (request: LlmRequest) => boolean;
}

/** The assistant's prompts are `assistant_plan` and `assistant_answer`; summaries use other ids. */
export function isAssistantRequest(request: LlmRequest): boolean {
  return request.prompt.id.startsWith('assistant_');
}

interface Waiter {
  readonly low: boolean;
  readonly grant: () => void;
  timer: NodeJS.Timeout | undefined;
}

export function limitConcurrency(
  inner: LlmProvider,
  options: ConcurrencyLimitOptions,
): LlmProvider {
  const max = Math.max(1, Math.floor(options.maxConcurrent));
  const maxQueued = options.maxQueued ?? 8;
  const maxWaitMs = options.maxWaitMs ?? 60_000;
  const reserved = Math.min(Math.max(0, Math.floor(options.reservedSlots ?? 0)), max - 1);
  const lowMax = max - reserved;
  const isLow = options.isLowPriority ?? (() => false);
  let active = 0;
  let activeLow = 0;
  const waiters: Waiter[] = [];

  const canRun = (low: boolean): boolean => active < max && (!low || activeLow < lowMax);
  const take = (low: boolean): void => {
    active += 1;
    if (low) activeLow += 1;
  };

  const acquire = (low: boolean, signal: AbortSignal | undefined): Promise<void> => {
    if (signal?.aborted === true) return Promise.reject(new ProviderUnavailableError('aborted'));
    if (canRun(low)) {
      take(low);
      return Promise.resolve();
    }
    if (waiters.length >= maxQueued) {
      return Promise.reject(new ProviderUnavailableError(`${inner.kind}: the AI is busy`));
    }
    return new Promise<void>((resolve, reject) => {
      const leave = (): void => {
        const at = waiters.indexOf(waiter);
        if (at >= 0) waiters.splice(at, 1);
      };
      const onAbort = (): void => {
        leave();
        clearTimeout(waiter.timer);
        reject(new ProviderUnavailableError('aborted'));
      };
      const waiter: Waiter = {
        low,
        grant: () => {
          clearTimeout(waiter.timer);
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
        timer: setTimeout(() => {
          leave();
          signal?.removeEventListener('abort', onAbort);
          reject(new ProviderUnavailableError(`${inner.kind}: waited too long for a free slot`));
        }, maxWaitMs),
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      waiters.push(waiter);
    });
  };

  const release = (low: boolean): void => {
    active -= 1;
    if (low) activeLow -= 1;
    // Oldest first, but a waiter that is not allowed to run yet (the low-priority cap) is passed over.
    for (let i = 0; i < waiters.length;) {
      const next = waiters[i];
      if (next !== undefined && canRun(next.low)) {
        waiters.splice(i, 1);
        take(next.low);
        next.grant();
      } else {
        i += 1;
      }
    }
  };

  return {
    kind: inner.kind,
    async generate(request: LlmRequest): Promise<LlmResponse> {
      const low = isLow(request);
      await acquire(low, request.abortSignal);
      try {
        return await inner.generate(request);
      } finally {
        release(low);
      }
    },
  };
}
