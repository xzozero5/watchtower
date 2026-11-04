/**
 * The one shape every AI sentence a person reads has (T-135, ADR-023 section 9, N5): a claim and the
 * pages that support it. The assistant's answer, the daily brief summary, the handoff prefill and
 * the investigation report all use it, so the web has one `ClaimLine` and no AI sentence shows up
 * as a fact without a way to check it.
 *
 * `href` is a page of this app (or, for a repository change, an `https` link) that the person who
 * receives the claim may open. The server builds evidence from data it read with that person's own
 * permissions and only then lets a model refer to it by id; a model never writes a URL.
 */
import { z } from 'zod';

export const CLAIM_EVIDENCE_KINDS = [
  'ticket',
  'kb',
  'incident',
  'alert',
  'deploy',
  'note',
  'handoff',
  'log',
  'data',
  'repo',
  'person',
] as const;
export const claimEvidenceKindSchema = z.enum(CLAIM_EVIDENCE_KINDS);
export type ClaimEvidenceKind = z.infer<typeof claimEvidenceKindSchema>;

/** A path inside the app (`/tickets/OPS-1`), or an `https` URL. Never `//host`, `javascript:` or a relative path. */
export const claimHrefSchema = z
  .string()
  .max(500)
  .regex(/^(\/(?!\/)[^\s]*|https:\/\/[^\s]+)$/, 'href must be an app path or an https URL');

export const claimEvidenceSchema = z.object({
  kind: claimEvidenceKindSchema,
  /** What the chip says: a ticket key, an article title. Already restored for this viewer (masked for `dev`). */
  label: z.string().min(1).max(200),
  /** Absent: the source has no page. The chip then shows the snippet and says there is no link. */
  href: claimHrefSchema.optional(),
  /**
   * The source answered from a fake or a sandbox, or the score behind it came from mock embeddings.
   * The web shows a `Demo` chip and never a number or `1.00` as certainty.
   */
  mock: z.boolean().optional(),
});
export type ClaimEvidence = z.infer<typeof claimEvidenceSchema>;

export const claimSchema = z
  .object({
    text: z.string().min(1).max(600),
    evidence: z.array(claimEvidenceSchema).max(8),
    /** True exactly when there is no evidence. The web shows `Uncited`, never the sentence as fact. */
    uncited: z.boolean(),
  })
  .refine((claim) => claim.uncited === (claim.evidence.length === 0), {
    message: 'uncited must be true exactly when the claim has no evidence',
    path: ['uncited'],
  });
export type Claim = z.infer<typeof claimSchema>;

/** Builds a claim whose `uncited` flag cannot disagree with its evidence. */
export function makeClaim(text: string, evidence: readonly ClaimEvidence[] = []): Claim {
  return { text, evidence: [...evidence], uncited: evidence.length === 0 };
}

/**
 * An AI summary of a screen (the daily brief, the handoff): claims with their evidence, and when and
 * from what data they were made. `dataAsOf` is the time of the facts, which is older than
 * `generatedAt` when the summary was cached; the web shows both so nobody reads old news as new.
 */
export const aiClaimsBlockSchema = z.object({
  claims: z.array(claimSchema).max(8),
  generatedAt: z.iso.datetime(),
  dataAsOf: z.iso.datetime(),
  /** The `ai_run` row of the model call that wrote it. */
  aiRunId: z.string(),
  /** Written by the mock provider: the web labels it `Demo`. */
  mock: z.boolean(),
});
export type AiClaimsBlock = z.infer<typeof aiClaimsBlockSchema>;
