import {
  claimSchema,
  makeClaim,
  type AiInsightReason,
  type Claim,
  type WeeklyBriefContent,
} from '@watchtower/shared';
import { z } from 'zod';

import type { AuditedResult } from '../audited.js';
import { renderPrompt } from '../prompts.js';
import type { Redactor } from '../redaction/redactor.js';
import { stripLinks } from './assistant.js';
import { askGuard, extractJsonObject, failureFor, skippedFor, type AgentDeps } from './common.js';
import { evidenceFor, factBlock, type CitableFact } from './fact-block.js';

export const WEEKLY_BRIEF_PROMPT_ID = 'weekly_brief';

/** A fact of the week. `names` are the people it names, for the redactor's dictionary (N4). */
export interface WeeklyBriefFact extends CitableFact {
  readonly names?: readonly string[] | undefined;
}

const cited = z.object({
  text: z.string().trim().min(1).max(600),
  factIds: z.array(z.string().max(200)).max(20).default([]),
});

const answerSchema = z.object({
  summary: z.array(cited).max(12).default([]),
  rootCauses: z
    .array(
      cited.extend({
        title: z.string().trim().min(1).max(300),
        ask: z.string().trim().max(600).nullish(),
      }),
    )
    .max(12)
    .default([]),
  decisions: z.array(cited).max(12).default([]),
});

export interface WeeklyBriefInput {
  /** Names the redactor must know besides those of the facts (the staff of the instance). */
  readonly names?: readonly string[] | undefined;
  /** Redaction scope, for example `weekly-brief:2026-11-09`. */
  readonly scope: string;
  readonly locale: 'th' | 'en';
  readonly facts: readonly WeeklyBriefFact[];
  readonly abortSignal?: AbortSignal | undefined;
}

export type WeeklyBriefOutcome =
  | {
      readonly status: 'ok';
      readonly content: WeeklyBriefContent;
      /** Sentences the model wrote that cited no fact. They are not kept: a brief to leaders does not float. */
      readonly droppedUncited: number;
      readonly runId: string | null;
      readonly promptVersion: number;
      readonly mock: boolean;
    }
  | { readonly status: 'skipped'; readonly reason: AiInsightReason }
  | { readonly status: 'failed'; readonly reason: AiInsightReason };

export const WEEKLY_BRIEF_LIMITS = { summary: 6, rootCauses: 5, decisions: 4 } as const;
const MAX_FACTS = 70;

/**
 * Writes the weekly brief (T-305c, PRD 9.2) from facts the code read: the figures of the CEO view and the
 * incidents, intents and investigation findings of the week. The model sees redacted fact lines (N4) and
 * writes sentences that cite them by id; it never writes a link, the chips come from the facts (T-135). A
 * sentence that cites no known fact is dropped and counted, never shown as a finding (N5). Everything goes
 * through the guard and the audited LLM, so the call is on `ai_run` with the prompt version, model and cost.
 * The agent has no tool: it reads only the facts it is given (N2).
 */
export async function writeWeeklyBrief(
  deps: AgentDeps & { redactorFor?(names: readonly string[]): Redactor },
  input: WeeklyBriefInput,
): Promise<WeeklyBriefOutcome> {
  const facts = input.facts.slice(0, MAX_FACTS);
  if (facts.length === 0) {
    return {
      status: 'ok',
      content: { summary: [], rootCauses: [], decisions: [] },
      droppedUncited: 0,
      runId: null,
      promptVersion: 0,
      mock: false,
    };
  }
  const decision = await askGuard(deps.guard, {
    agent: 'summarizer',
    ticketId: null,
    action: 'weekly_brief',
  });
  if (!decision.allowed) return { status: 'skipped', reason: decision.reason };

  const prompt = deps.prompts.latest(WEEKLY_BRIEF_PROMPT_ID);
  const names = [
    ...new Set([...(input.names ?? []), ...facts.flatMap((fact) => fact.names ?? [])]),
  ];
  const session = (deps.redactorFor?.(names) ?? deps.redactor).session({ scope: input.scope });
  let result: AuditedResult;
  try {
    const system = session.redact(
      renderPrompt(prompt.body, {
        language: input.locale === 'th' ? 'Thai' : 'English',
        maxSummary: String(WEEKLY_BRIEF_LIMITS.summary),
        maxRootCauses: String(WEEKLY_BRIEF_LIMITS.rootCauses),
        maxDecisions: String(WEEKLY_BRIEF_LIMITS.decisions),
      }),
    );
    result = await deps.llm.generate({
      agent: 'summarizer',
      prompt: prompt.ref,
      system,
      messages: [{ role: 'user', content: factBlock(session, facts) }],
      redaction: session,
      ticketId: null,
      maxOutputTokens: 1800,
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

  const words = (text: string): string => stripLinks(session.restore(text, 'internal').text);
  let dropped = 0;
  const claimOf = (item: z.infer<typeof cited>): Claim | null => {
    const evidence = evidenceFor(facts, item.factIds);
    if (evidence.length === 0) {
      dropped += 1;
      return null;
    }
    const claim = makeClaim(words(item.text).slice(0, 600), evidence.slice(0, 8));
    return claimSchema.safeParse(claim).success ? claim : null;
  };
  const claimsOf = (items: readonly z.infer<typeof cited>[], max: number): Claim[] =>
    items
      .map(claimOf)
      .filter((claim): claim is Claim => claim !== null)
      .slice(0, max);

  const rootCauses: WeeklyBriefContent['rootCauses'] = [];
  for (const item of parsed.data.rootCauses) {
    const claim = claimOf(item);
    if (claim === null) continue;
    const ask = item.ask === undefined || item.ask === null ? '' : words(item.ask).trim();
    rootCauses.push({
      title: words(item.title).slice(0, 160),
      claims: [claim],
      ask: ask === '' ? null : ask.slice(0, 300),
    });
    if (rootCauses.length >= WEEKLY_BRIEF_LIMITS.rootCauses) break;
  }

  return {
    status: 'ok',
    content: {
      summary: claimsOf(parsed.data.summary, WEEKLY_BRIEF_LIMITS.summary),
      rootCauses,
      decisions: claimsOf(parsed.data.decisions, WEEKLY_BRIEF_LIMITS.decisions),
    },
    droppedUncited: dropped,
    runId: result.runId,
    promptVersion: prompt.ref.version,
    mock: result.run.provider === 'mock' || facts.some((fact) => fact.mock === true),
  };
}
