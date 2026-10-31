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

/**
 * How the public portal tells a person from a script (ADR-007). The default is self-hosted
 * proof-of-work with a honeypot and a minimum fill time. A hosted provider (Turnstile, hCaptcha)
 * would be a new class implementing this interface and a new variant of `HumanChallenge`; it is a
 * new network destination, so adding one needs the owner's decision (`[ASK-HUMAN]`).
 */
export interface HumanVerificationProvider {
  readonly name: string;
  /** What the page has to solve before it may submit (`GET /v1/portal/challenge`). */
  challenge(): Promise<HumanChallenge>;
  /** Checks a submission. A successful check uses the challenge up: it cannot be presented again. */
  verify(submission: VerificationSubmission): Promise<VerificationResult>;
}
