import { PowAbortedError, PowRefusedError, solvePow, type Solution } from './pow-core';
import type { WorkerReply, WorkerRequest } from './pow.worker';

export interface SolveHandle {
  promise: Promise<Solution>;
  /** Stops the work. `promise` then rejects with `PowAbortedError`. */
  cancel: () => void;
}

/** The part of `Worker` this module uses, so tests can pass a fake. */
export interface WorkerLike {
  onmessage: ((event: MessageEvent<WorkerReply>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: WorkerRequest): void;
  terminate(): void;
}

export interface SolveDeps {
  /** Returns null when workers are not available. */
  createWorker?: () => WorkerLike | null;
}

function defaultCreateWorker(): WorkerLike | null {
  if (typeof Worker === 'undefined') return null;
  // The `new URL(...)` form is what the bundler looks for to build the worker file.
  return new Worker(new URL('./pow.worker.ts', import.meta.url), { type: 'module' });
}

const nextTask = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

/**
 * Solves a challenge in a Web Worker. If the browser cannot start one (very old browsers, a strict
 * content security policy), the same code runs on the main thread in small batches that let the
 * page paint between them, so the check still completes and the form stays usable.
 */
export function startSolve(
  challenge: string,
  difficultyBits: number,
  onProgress: (attempts: number) => void,
  deps: SolveDeps = {},
): SolveHandle {
  let cancelled = false;
  let worker: WorkerLike | null = null;
  let abort: () => void = () => undefined;

  const runOnMainThread = (): Promise<Solution> =>
    solvePow(challenge, {
      difficultyBits,
      onProgress,
      shouldStop: () => cancelled,
      pause: nextTask,
    });

  const promise = new Promise<Solution>((resolve, reject) => {
    abort = () => {
      reject(new PowAbortedError());
    };
    try {
      worker = (deps.createWorker ?? defaultCreateWorker)();
    } catch {
      worker = null;
    }
    if (!worker) {
      runOnMainThread().then(resolve, reject);
      return;
    }
    const active = worker;
    active.onmessage = (event) => {
      const reply = event.data;
      if (reply.type === 'progress') {
        onProgress(reply.attempts);
        return;
      }
      active.terminate();
      if (reply.type === 'done') resolve({ nonce: reply.nonce, attempts: reply.attempts });
      else reject(new PowRefusedError(reply.message));
    };
    active.onerror = () => {
      // The worker file could not be loaded or crashed: do the work here instead.
      active.terminate();
      if (cancelled) {
        reject(new PowAbortedError());
        return;
      }
      runOnMainThread().then(resolve, reject);
    };
    active.postMessage({ challenge, difficultyBits });
  });

  return {
    promise,
    cancel: () => {
      cancelled = true;
      const active: WorkerLike | null = worker;
      active?.terminate();
      // A terminated worker never replies, so end the promise here.
      abort();
    },
  };
}
