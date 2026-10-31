import type { HumanChallenge, HumanProof } from '@watchtower/shared';

import { PowAbortedError } from './pow-core';
import type { PortalClient } from './portal-client';
import { startSolve, type SolveHandle } from './solve';

export type CheckState =
  | { phase: 'loading' }
  | { phase: 'solving'; progress: number }
  | { phase: 'ready' }
  | { phase: 'failed'; error: unknown };

export interface HumanCheckDeps {
  api: Pick<PortalClient, 'challenge'>;
  onChange: (state: CheckState) => void;
  solve?: typeof startSolve;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface Solved {
  proof: HumanProof;
  /** Local time before which the api refuses the proof as too quick. */
  readyAt: number;
  /** Local time after which the api no longer accepts the challenge. */
  staleAt: number;
}

interface Attempt {
  result: Promise<Solved>;
  cancel: () => void;
}

/** Extra wait on top of `minFillSeconds`, so a rounding difference never makes us too quick. */
const FILL_MARGIN_MS = 250;
/** A solved challenge this close to its expiry is replaced before it is used. */
const STALE_MARGIN_MS = 20_000;

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * The portal's human check (ADR-007). It asks for a challenge when the form opens, solves it in a
 * Web Worker while the person fills in the form, and hands the proof over at submit time, not
 * before `minFillSeconds` have passed since the challenge was issued. A challenge works once, so
 * after a failed submit call `restart()` for a fresh one.
 *
 * Timing uses this browser's own clock from the moment the challenge arrived: the server issued it
 * earlier than that, so waiting `minFillSeconds` from arrival can only be longer than required.
 */
export class HumanCheck {
  private attempt: Attempt | null = null;
  private solved: Solved | null = null;
  private generation = 0;
  private disposed = false;

  constructor(private readonly deps: HumanCheckDeps) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private emit(generation: number, state: CheckState): void {
    if (!this.disposed && generation === this.generation) this.deps.onChange(state);
  }

  /** Starts a new attempt unless one is running. */
  start(): void {
    this.disposed = false;
    this.ensureAttempt();
  }

  /** Drops the current attempt and starts a fresh one. */
  restart(): void {
    this.cancelCurrent();
    this.ensureAttempt();
  }

  dispose(): void {
    this.disposed = true;
    this.cancelCurrent();
  }

  /** Milliseconds a submit would still have to wait for the minimum fill time (0 when none). */
  fillRemainingMs(): number {
    return this.solved ? Math.max(0, this.solved.readyAt - this.now) : 0;
  }

  /**
   * The proof for a submit: waits for the work to finish and for the minimum fill time. Rejects
   * with the error that stopped the check (a `PortalApiError` from the challenge request, or
   * `PowRefusedError`).
   */
  async getProof(): Promise<HumanProof> {
    for (let round = 0; round < 3; round += 1) {
      const attempt = this.ensureAttempt();
      let solved: Solved;
      try {
        solved = await attempt.result;
      } catch (error) {
        // Forget a failed attempt so the next submit starts a new one.
        if (this.attempt === attempt) this.cancelCurrent();
        throw error;
      }
      if (this.now >= solved.staleAt - STALE_MARGIN_MS) {
        this.restart();
        continue;
      }
      const wait = solved.readyAt - this.now;
      if (wait > 0) await (this.deps.sleep ?? defaultSleep)(wait);
      return solved.proof;
    }
    throw new Error('could not get a fresh challenge');
  }

  private cancelCurrent(): void {
    this.generation += 1;
    this.attempt?.cancel();
    this.attempt = null;
    this.solved = null;
  }

  private ensureAttempt(): Attempt {
    if (this.attempt) return this.attempt;
    const generation = this.generation;
    // An object, not two `let`s: the closures below change it after this function has returned.
    const run: { handle: SolveHandle | null; cancelled: boolean } = {
      handle: null,
      cancelled: false,
    };

    const result = (async (): Promise<Solved> => {
      this.emit(generation, { phase: 'loading' });
      let challenge: HumanChallenge;
      try {
        challenge = await this.deps.api.challenge();
      } catch (error) {
        this.emit(generation, { phase: 'failed', error });
        throw error;
      }
      if (run.cancelled) throw new PowAbortedError();
      const receivedAt = this.now;
      const expected = 2 ** challenge.difficultyBits;
      let lastProgress = 0;
      this.emit(generation, { phase: 'solving', progress: 0 });
      const handle = (this.deps.solve ?? startSolve)(
        challenge.challenge,
        challenge.difficultyBits,
        (attempts) => {
          // Report whole percents only: the work runs in batches many times a second.
          const progress = Math.min(0.95, Math.floor((attempts / expected) * 100) / 100);
          if (progress === lastProgress) return;
          lastProgress = progress;
          this.emit(generation, { phase: 'solving', progress });
        },
      );
      run.handle = handle;
      try {
        const { nonce } = await handle.promise;
        const solved: Solved = {
          proof: { provider: 'pow-sha256', challenge: challenge.challenge, nonce },
          readyAt: receivedAt + challenge.minFillSeconds * 1000 + FILL_MARGIN_MS,
          staleAt: receivedAt + (Date.parse(challenge.expiresAt) - Date.parse(challenge.issuedAt)),
        };
        if (generation === this.generation) this.solved = solved;
        this.emit(generation, { phase: 'ready' });
        return solved;
      } catch (error) {
        if (!(error instanceof PowAbortedError)) {
          this.emit(generation, { phase: 'failed', error });
        }
        throw error;
      }
    })();
    // The caller of getProof() handles a rejection; this keeps an unused attempt from being
    // reported as an unhandled rejection.
    result.catch(() => undefined);

    this.attempt = {
      result,
      cancel: () => {
        run.cancelled = true;
        run.handle?.cancel();
      },
    };
    return this.attempt;
  }
}
