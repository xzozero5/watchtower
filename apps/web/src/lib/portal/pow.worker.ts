import { solvePow } from './pow-core';

/**
 * Web Worker entry: solves one proof-of-work challenge off the main thread, so the form stays
 * usable while it runs. The page ends a cancelled attempt with `worker.terminate()`.
 */
export interface WorkerRequest {
  challenge: string;
  difficultyBits: number;
}

export type WorkerReply =
  | { type: 'progress'; attempts: number }
  | { type: 'done'; nonce: string; attempts: number }
  | { type: 'error'; message: string };

interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerReply): void;
}

// The dom lib types `self` as a Window; inside a worker it is the dedicated worker scope.
const scope = self as unknown as WorkerScope;

scope.onmessage = (event) => {
  const { challenge, difficultyBits } = event.data;
  solvePow(challenge, {
    difficultyBits,
    onProgress: (attempts) => {
      scope.postMessage({ type: 'progress', attempts });
    },
  }).then(
    (solution) => {
      scope.postMessage({ type: 'done', nonce: solution.nonce, attempts: solution.attempts });
    },
    (error: unknown) => {
      scope.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : 'unknown error',
      });
    },
  );
};
