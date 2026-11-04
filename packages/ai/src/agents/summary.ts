import { claimSchema, makeClaim, type AiInsightReason, type Claim } from '@watchtower/shared';
import { z } from 'zod';

import type { AuditedResult } from '../audited.js';
import { renderPrompt } from '../prompts.js';
import type { Redactor } from '../redaction/redactor.js';
import { stripLinks, type AssistantFact } from './assistant.js';
import { evidenceFor, factBlock } from './fact-block.js';
import { askGuard, extractJsonObject, failureFor, skippedFor, type AgentDeps } from './common.js';

export const CLAIM_SUMMARY_PROMPT_ID = 'claim_summary';

/** A fact is the same thing here and in the assistant: text for the model, a chip for the person. */
export type ClaimFact = AssistantFact;

const answerSchema = z.object({
  claims: z
    .array(
      z.object({
        text: z.string().trim().min(1).max(600),
        factIds: z.array(z.string().max(200)).max(20).default([]),
      }),
    )
    .max(12),
});

export interface ClaimSummaryInput {
  /** Names the redactor must know besides those of the facts (for example the staff of the instance). */
  readonly names?: readonly string[] | undefined;
  /** Redaction scope, for example `brief:<user id>`. */
  readonly scope: string;
  /** What is being summarized, in a few English words for the prompt: `the daily brief of a shift`. */
  readonly subject: string;
  readonly locale: 'th' | 'en';
  readonly facts: readonly ClaimFact[];
  readonly maxClaims: number;
  /** Keep a claim that cites nothing, labelled `uncited`. The default drops it: a summary does not float. */
  readonly keepUncited?: boolean | undefined;
  readonly abortSignal?: AbortSignal | undefined;
}

export type ClaimSummaryOutcome =
  | {
      readonly status: 'ok';
      readonly claims: Claim[];
      readonly runId: string | null;
      readonly mock: boolean;
    }
  | { readonly status: 'skipped'; readonly reason: AiInsightReason }
  | { readonly status: 'failed'; readonly reason: AiInsightReason };

const MAX_FACTS = 40;

/**
 * Turns facts the host already read (with the viewer's own access) into claims that cite them by id
 * (T-135, ADR-023 section 9). The model sees redacted fact lines and writes sentences; it never writes
 * a link: the chips come from the facts. A claim that cites no known fact is dropped, or, when the
 * caller asks for it, kept and marked `uncited`. No facts: no model call.
 */
export async function summarizeClaims(
  deps: AgentDeps & { redactorFor?(names: readonly string[]): Redactor },
  input: ClaimSummaryInput,
): Promise<ClaimSummaryOutcome> {
  const facts = input.facts.slice(0, MAX_FACTS);
  if (facts.length === 0) return { status: 'ok', claims: [], runId: null, mock: false };

  const decision = await askGuard(deps.guard, {
    agent: 'summarizer',
    ticketId: null,
    action: 'claim_summary',
  });
  if (!decision.allowed) return { status: 'skipped', reason: decision.reason };

  const prompt = deps.prompts.latest(CLAIM_SUMMARY_PROMPT_ID);
  // The people named in the facts, and the staff of the instance, are in the dictionary: a name in a
  // subject is replaced before the model sees it (N4).
  const names = [
    ...new Set([...(input.names ?? []), ...facts.flatMap((fact) => fact.names ?? [])]),
  ];
  const session = (deps.redactorFor?.(names) ?? deps.redactor).session({ scope: input.scope });
  let result: AuditedResult;
  try {
    const system = session.redact(
      renderPrompt(prompt.body, {
        subject: input.subject,
        language: input.locale === 'th' ? 'Thai' : 'English',
        maxClaims: String(input.maxClaims),
      }),
    );
    const user = factBlock(session, facts);
    result = await deps.llm.generate({
      agent: 'summarizer',
      prompt: prompt.ref,
      system,
      messages: [{ role: 'user', content: user }],
      redaction: session,
      ticketId: null,
      maxOutputTokens: 700,
      temperature: 0,
      ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
    });
  } catch (error) {
    const reason = skippedFor(error);
    if (reason !== null) return { status: 'skipped', reason };
    return failureFor(error);
  }

  const parsed = answerSchema.safeParse(extractJsonObject(result.response.text));
  if (!parsed.success) return { status: 'failed', reason: 'model_output_invalid' };

  const claims: Claim[] = [];
  for (const item of parsed.data.claims) {
    const evidence = evidenceFor(facts, item.factIds);
    if (evidence.length === 0 && input.keepUncited !== true) continue;
    const claim = makeClaim(
      stripLinks(session.restore(item.text, 'internal').text).slice(0, 600),
      evidence,
    );
    if (claimSchema.safeParse(claim).success) claims.push(claim);
    if (claims.length >= input.maxClaims) break;
  }
  return {
    status: 'ok',
    claims,
    runId: result.runId,
    mock: result.run.provider === 'mock' || facts.some((fact) => fact.mock === true),
  };
}
