import { z } from 'zod';

// --- human verification (ADR-007) ---
// Its own file, imported by the portal and by the status page (T-207a C-3), so neither depends on the other.

/**
 * What the page must solve before it submits. `provider` leaves room for a hosted provider later
 * (a new variant here and a new class behind `HumanVerificationProvider` in the api).
 */
export const humanChallengeSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('pow-sha256'),
    /** Opaque, signed by the server. Send it back unchanged with the nonce. */
    challenge: z.string(),
    /**
     * Find a `nonce` (decimal string) so that SHA-256 of the UTF-8 text `<challenge>:<nonce>` starts
     * with at least this many zero bits. See `powInput` and `leadingZeroBits`.
     */
    difficultyBits: z.number().int().min(1).max(32),
    issuedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    /** Submitting sooner than this after `issuedAt` is refused: ask for the challenge when the form opens. */
    minFillSeconds: z.number().int().min(0),
  }),
]);
export type HumanChallenge = z.infer<typeof humanChallengeSchema>;

export const humanProofSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('pow-sha256'),
    challenge: z.string().min(1).max(400),
    nonce: z.string().regex(/^[0-9]{1,20}$/, 'expected a decimal number'),
  }),
]);
export type HumanProof = z.infer<typeof humanProofSchema>;
