import { leadingZeroBits, powInput } from '@watchtower/shared';

/**
 * Proof-of-work solver for the portal's human check (ADR-007). It finds the smallest decimal
 * `nonce` such that SHA-256 of the UTF-8 text `<challenge>:<nonce>` starts with `difficultyBits`
 * zero bits. It uses only WebCrypto (`crypto.subtle`), so it has no dependency, and it takes the
 * `subtle` object as a parameter so the same code runs in a Web Worker, on the main thread as a
 * fallback, and in Node for tests.
 *
 * Hashing one value per `await` is slow, so each round hashes a batch at once and then looks for
 * the first success in nonce order. That keeps the result deterministic (the smallest nonce).
 */

/** A challenge harder than this would keep a phone busy for minutes; refuse it. `[ASSUMED]` */
export const MAX_CLIENT_DIFFICULTY_BITS = 26;

export const DEFAULT_BATCH_SIZE = 512;

export class PowAbortedError extends Error {
  constructor() {
    super('proof-of-work was cancelled');
    this.name = 'PowAbortedError';
  }
}

export class PowRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PowRefusedError';
  }
}

export interface SolveOptions {
  difficultyBits: number;
  subtle?: Pick<SubtleCrypto, 'digest'>;
  batchSize?: number;
  /** Called after every batch with the number of nonces tried so far. */
  onProgress?: (attempts: number) => void;
  /** Checked between batches; return true to stop with `PowAbortedError`. */
  shouldStop?: () => boolean;
  /** Awaited between batches. The main-thread fallback uses it to let the page paint. */
  pause?: () => Promise<void>;
  maxAttempts?: number;
}

export interface Solution {
  nonce: string;
  attempts: number;
}

/** True when `nonce` solves `challenge`. Same rule as the api's `hasWork`. */
export async function hasWork(
  challenge: string,
  nonce: string,
  difficultyBits: number,
  subtle: Pick<SubtleCrypto, 'digest'> = crypto.subtle,
): Promise<boolean> {
  const digest = await subtle.digest(
    'SHA-256',
    new TextEncoder().encode(powInput(challenge, nonce)),
  );
  return leadingZeroBits(new Uint8Array(digest)) >= difficultyBits;
}

export async function solvePow(challenge: string, options: SolveOptions): Promise<Solution> {
  const { difficultyBits } = options;
  if (!Number.isInteger(difficultyBits) || difficultyBits < 1) {
    throw new PowRefusedError('difficulty must be a positive whole number of bits');
  }
  if (difficultyBits > MAX_CLIENT_DIFFICULTY_BITS) {
    throw new PowRefusedError('difficulty is higher than this browser accepts');
  }
  const subtle = options.subtle ?? crypto.subtle;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  // About 64 times the expected work: the chance of missing it is below e^-64.
  const maxAttempts = options.maxAttempts ?? 2 ** (difficultyBits + 6);
  const encoder = new TextEncoder();

  for (let start = 0; start < maxAttempts; start += batchSize) {
    if (options.shouldStop?.()) throw new PowAbortedError();
    const count = Math.min(batchSize, maxAttempts - start);
    const nonces = Array.from({ length: count }, (_, index) => String(start + index));
    const digests = await Promise.all(
      nonces.map((nonce) => subtle.digest('SHA-256', encoder.encode(powInput(challenge, nonce)))),
    );
    for (const [index, digest] of digests.entries()) {
      if (leadingZeroBits(new Uint8Array(digest)) >= difficultyBits) {
        return { nonce: nonces[index] ?? '0', attempts: start + index + 1 };
      }
    }
    options.onProgress?.(start + count);
    if (options.pause) await options.pause();
  }
  throw new PowRefusedError('no solution found within the attempt limit');
}
