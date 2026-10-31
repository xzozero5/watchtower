import { describe, expect, it, vi } from 'vitest';

import { PowAbortedError, PowRefusedError } from './pow-core';
import type { WorkerReply } from './pow.worker';
import { startSolve, type WorkerLike } from './solve';

const CHALLENGE =
  'Zm9vYmFyYmF6cXV4MTIzNA.1893456000.1893454200.12.c2lnbmF0dXJlLWZvci10ZXN0cy1vbmx5LTEyMzQ1Njc4OTA';

function fakeWorker() {
  const worker: WorkerLike & { posted: unknown[]; terminated: boolean } = {
    onmessage: null,
    onerror: null,
    posted: [],
    terminated: false,
    postMessage(message) {
      this.posted.push(message);
    },
    terminate() {
      this.terminated = true;
    },
  };
  const reply = (data: WorkerReply) => {
    worker.onmessage?.({ data } as MessageEvent<WorkerReply>);
  };
  return { worker, reply };
}

describe('startSolve with a Web Worker', () => {
  it('sends the challenge to the worker, relays progress and resolves with its answer', async () => {
    const { worker, reply } = fakeWorker();
    const onProgress = vi.fn();
    const handle = startSolve(CHALLENGE, 12, onProgress, { createWorker: () => worker });
    expect(worker.posted).toEqual([{ challenge: CHALLENGE, difficultyBits: 12 }]);
    reply({ type: 'progress', attempts: 512 });
    expect(onProgress).toHaveBeenCalledWith(512);
    reply({ type: 'done', nonce: '4984', attempts: 4985 });
    await expect(handle.promise).resolves.toEqual({ nonce: '4984', attempts: 4985 });
    expect(worker.terminated).toBe(true);
  });

  it('rejects when the worker reports a refusal', async () => {
    const { worker, reply } = fakeWorker();
    const handle = startSolve(CHALLENGE, 12, vi.fn(), { createWorker: () => worker });
    reply({ type: 'error', message: 'difficulty is higher than this browser accepts' });
    await expect(handle.promise).rejects.toBeInstanceOf(PowRefusedError);
  });

  it('terminates the worker and rejects when cancelled', async () => {
    const { worker } = fakeWorker();
    const handle = startSolve(CHALLENGE, 12, vi.fn(), { createWorker: () => worker });
    handle.cancel();
    expect(worker.terminated).toBe(true);
    await expect(handle.promise).rejects.toBeInstanceOf(PowAbortedError);
  });
});

describe('startSolve without a worker', () => {
  it('solves on the main thread when workers are not available', async () => {
    const onProgress = vi.fn();
    const handle = startSolve(CHALLENGE, 12, onProgress, { createWorker: () => null });
    await expect(handle.promise).resolves.toEqual({ nonce: '4984', attempts: 4985 });
    expect(onProgress).toHaveBeenCalled();
  });

  it('falls back to the main thread when the worker cannot be created', async () => {
    const handle = startSolve(CHALLENGE, 8, vi.fn(), {
      createWorker: () => {
        throw new SecurityError();
      },
    });
    await expect(handle.promise).resolves.toMatchObject({ nonce: '168' });
  });

  it('falls back to the main thread when the worker file fails to load', async () => {
    const { worker } = fakeWorker();
    const handle = startSolve(CHALLENGE, 8, vi.fn(), { createWorker: () => worker });
    worker.onerror?.(new ErrorEvent('error'));
    await expect(handle.promise).resolves.toMatchObject({ nonce: '168' });
    expect(worker.terminated).toBe(true);
  });

  it('stops the main-thread work when cancelled', async () => {
    const handle = startSolve(CHALLENGE, 16, vi.fn(), { createWorker: () => null });
    handle.cancel();
    await expect(handle.promise).rejects.toBeInstanceOf(PowAbortedError);
  });
});

class SecurityError extends Error {}
