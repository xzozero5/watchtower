import type { HumanChallenge, HumanProof } from '@watchtower/shared';

/** DI token for the active provider. Swap the class behind it to change how people are verified. */
export const HUMAN_VERIFICATION = Symbol('HUMAN_VERIFICATION');

export interface VerificationSubmission {
  readonly proof: HumanProof;
  /** The value of the honeypot field; anything but empty or absent is a bot. */
  readonly honeypot: string | undefined;
}

/** Why a submission was refused. Written to the audit log; never shown to the caller. */
export type VerificationFailure =
  | 'honeypot'
  | 'provider_mismatch'
  | 'malformed'
  | 'bad_signature'
  | 'expired'
  | 'too_fast'
  | 'insufficient_work'
  | 'replayed';

export type VerificationResult =
  | { readonly ok: true; readonly challengeId: string }
  | { readonly ok: false; readonly reason: VerificationFailure };

/** A submission that passed every check that needs no storage; the challenge is not used up yet. */
export type CheckedSubmission =
  | {
      readonly ok: true;
      readonly challengeId: string;
      /** Seconds the challenge stays valid; how long a claim must be remembered. */
      readonly remainingSeconds: number;
    }
  | { readonly ok: false; readonly reason: VerificationFailure };

/**
 * How the public portal tells a person from a script (ADR-007). The default is self-hosted
 * proof-of-work with a honeypot and a minimum fill time. A hosted provider (Turnstile, hCaptcha)
 * would be a new class implementing this interface and a new variant of `HumanChallenge`; it is a
 * new network destination, so adding one needs the owner's decision (`[ASK-HUMAN]`).
 *
 * Verification is two steps so the caller can put its rate limits between them (C-3): `check` is
 * stateless (no Redis, no database), so it is cheap to run before the limits and a request that
 * fails it can never spend an email or organization bucket of someone else; `claim` uses the
 * challenge up and runs only once the limits have let the request through.
 */
export interface HumanVerificationProvider {
  readonly name: string;
  /** What the page has to solve before it may submit (`GET /v1/portal/challenge`). */
  challenge(): Promise<HumanChallenge>;
  /** Stateless validation of the proof: format, signature, expiry, fill time, work, honeypot. */
  check(submission: VerificationSubmission): Promise<CheckedSubmission>;
  /** Uses a checked challenge up. It cannot be presented again; a second claim is `replayed`. */
  claim(checked: Extract<CheckedSubmission, { ok: true }>): Promise<VerificationResult>;
}
