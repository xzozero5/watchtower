import { AsyncLocalStorage } from 'node:async_hooks';

import { ProviderUnavailableError } from '../audited.js';
import type { LlmProvider, LlmRequest, LlmResponse } from '../contract.js';

/**
 * Caps how many model calls one process has in flight at once, so no caller can take every slot of the
 * claude-bridge (default 4 slots, ADR-023 "Live provider"). Shared by the api and the worker (ADR-029 section 4):
 * api `AI_API_MAX_CONCURRENCY` (2) + worker `WORKER_AI_MAX_CONCURRENCY` (2) = the bridge's 4.
 *
 * A call over the cap waits in a short queue; a full queue or a wait that is too long answers
 * `ConcurrencyLimitError` (a `ProviderUnavailableError`: the turn ends as "unavailable", nothing is sent to the model).
 *
 * `reservedSlots` (T-155a C-4): calls for which `isLowPriority` is true (the assistant) may use at most
 * `maxConcurrent - reservedSlots` slots together, so the AI summaries on the screens always find one
 * free and a few people chatting cannot starve them. A queued call whose request is aborted (the
 * person closed the page) leaves the queue at once.
 *
 * SINGLE-PROCESS ASSUMPTION (T-400 C-19): the counters live in this process's memory. The slots are only right
 * with ONE api replica and ONE worker process; a second replica doubles what the bridge sees. The api and the
 * worker log a warning at boot (`warnIfSingleProcessAssumptionBroken`); before running more than one of either,
 * move this limiter (and `assistant_busy`) to Redis.
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

/** Why the limiter refused a call. */
export type LimitRejection = 'queue_full' | 'wait_timeout' | 'aborted';

/** A call the limiter did not let through. Still a `ProviderUnavailableError` for every caller that does not care why. */
export class ConcurrencyLimitError extends ProviderUnavailableError {
  constructor(
    readonly rejection: LimitRejection,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Whoever started the work may ask to be told where its call is in the queue (SSE `queued{position}`) and why it was
 * refused. Carried by `AsyncLocalStorage`, so nothing in the request that goes to the model has to change.
 */
export interface QueueObserver {
  /** `0`: running (or not waiting); `n >= 1`: n-th in the queue. Called whenever it changes. */
  onPosition?(position: number): void;
  onRejected?(rejection: LimitRejection): void;
}

const observers = new AsyncLocalStorage<QueueObserver>();

/** Runs `work`; every call the limiter sees inside it (including after an `await`) reports to `observer`. */
export function observeQueue<T>(observer: QueueObserver, work: () => T): T {
  return observers.run(observer, work);
}

/** The assistant's prompts are `assistant_plan` and `assistant_answer`; summaries use other ids. */
export function isAssistantRequest(request: LlmRequest): boolean {
  return request.prompt.id.startsWith('assistant_');
}

export interface ConcurrencySnapshot {
  readonly max: number;
  readonly active: number;
  readonly queued: number;
  readonly maxQueued: number;
}

export interface ConcurrencyLimiter {
  /** Wraps a provider: every `generate` takes a slot first. */
  limit(inner: LlmProvider): LlmProvider;
  /**
   * A slot for work that must never wait (a background tick, T-418): the release function, or `null` when no slot is
   * free right now or somebody is already queued. Low priority by default: it respects `reservedSlots`.
   */
  tryAcquire(low?: boolean): (() => void) | null;
  /** Waits for a slot like a model call does (queue, wait limit, abort); the release function. */
  acquire(low: boolean, signal?: AbortSignal): Promise<() => void>;
  snapshot(): ConcurrencySnapshot;
  /** Calls waiting now. */
  queued(): number;
  /** True when a low-priority call would be refused for a full queue at this moment. */
  full(low?: boolean): boolean;
}

interface Waiter {
  readonly low: boolean;
  readonly observer: QueueObserver | undefined;
  lastPosition: number;
  readonly grant: () => void;
  timer: NodeJS.Timeout | undefined;
}

export function createConcurrencyLimiter(options: ConcurrencyLimitOptions): ConcurrencyLimiter {
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

  const release = (low: boolean): void => {
    active -= 1;
    if (low) activeLow -= 1;
    // Oldest first, but a waiter that is not allowed to run yet (the low-priority cap) is passed over.
    for (let i = 0; i < waiters.length;) {
      const next = waiters[i];
      if (next !== undefined && canRun(next.low)) {
        waiters.splice(i, 1);
        take(next.low);
        next.observer?.onPosition?.(0);
        next.grant();
      } else {
        i += 1;
      }
    }
    announce();
  };

  /** Tells every waiter whose place changed. */
  function announce(): void {
    waiters.forEach((waiter, index) => {
      if (waiter.lastPosition !== index + 1) {
        waiter.lastPosition = index + 1;
        waiter.observer?.onPosition?.(index + 1);
      }
    });
  }

  const once = (low: boolean): (() => void) => {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      release(low);
    };
  };

  const acquire = (
    low: boolean,
    signal: AbortSignal | undefined,
    kind = 'ai',
  ): Promise<() => void> => {
    const observer = observers.getStore();
    if (signal?.aborted === true) {
      observer?.onRejected?.('aborted');
      return Promise.reject(new ConcurrencyLimitError('aborted', 'aborted'));
    }
    if (canRun(low)) {
      take(low);
      return Promise.resolve(once(low));
    }
    if (waiters.length >= maxQueued) {
      observer?.onRejected?.('queue_full');
      return Promise.reject(new ConcurrencyLimitError('queue_full', `${kind}: the AI is busy`));
    }
    return new Promise<() => void>((resolve, reject) => {
      const leave = (): void => {
        const at = waiters.indexOf(waiter);
        if (at >= 0) waiters.splice(at, 1);
        announce();
      };
      const onAbort = (): void => {
        leave();
        clearTimeout(waiter.timer);
        observer?.onRejected?.('aborted');
        reject(new ConcurrencyLimitError('aborted', 'aborted'));
      };
      const waiter: Waiter = {
        low,
        observer,
        lastPosition: waiters.length + 1,
        grant: () => {
          clearTimeout(waiter.timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(once(low));
        },
        timer: setTimeout(() => {
          leave();
          signal?.removeEventListener('abort', onAbort);
          observer?.onRejected?.('wait_timeout');
          reject(
            new ConcurrencyLimitError('wait_timeout', `${kind}: waited too long for a free slot`),
          );
        }, maxWaitMs),
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      waiters.push(waiter);
      observer?.onPosition?.(waiter.lastPosition);
    });
  };

  return {
    limit(inner: LlmProvider): LlmProvider {
      return {
        kind: inner.kind,
        async generate(request: LlmRequest): Promise<LlmResponse> {
          const low = isLow(request);
          const done = await acquire(low, request.abortSignal, inner.kind);
          try {
            return await inner.generate(request);
          } finally {
            done();
          }
        },
      };
    },
    tryAcquire(low = true) {
      if (waiters.length > 0 || !canRun(low)) return null;
      take(low);
      return once(low);
    },
    acquire: (low, signal) => acquire(low, signal),
    snapshot: () => ({ max, active, queued: waiters.length, maxQueued }),
    queued: () => waiters.length,
    full: () => waiters.length >= maxQueued,
  };
}

/** Wraps `inner` with a limiter of its own: the shape the api and the worker used before the limiter was shared. */
export function limitConcurrency(
  inner: LlmProvider,
  options: ConcurrencyLimitOptions,
): LlmProvider {
  return createConcurrencyLimiter(options).limit(inner);
}

/**
 * T-400 C-19: the slots are counted per process. `replicas` is how many copies of this process run (compose has one);
 * more than one is outside what stage 1 supports, so say it once at boot and keep going.
 */
export function warnIfSingleProcessAssumptionBroken(
  who: 'api' | 'worker',
  replicas: number | undefined,
  warn: (fields: object, message: string) => void,
): boolean {
  if (replicas === undefined || replicas <= 1) return false;
  warn(
    { who, replicas },
    'AI concurrency limit and assistant_busy are per process: with more than one replica the claude-bridge can be overloaded (ADR-029 C-19). Keep one replica, or move the limiter to Redis first.',
  );
  return true;
}
