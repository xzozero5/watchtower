import type { AiInsightReason } from '@watchtower/shared';

import {
  AuditInputError,
  AuditRecordError,
  AuditWriteError,
  ProviderUnavailableError,
  type AgentCall,
  type AuditedResult,
} from '../audited.js';
import type { AgentName } from '../contract.js';
import type { PromptCatalog } from '../prompt-files.js';
import { NameMatchLimitError } from '../redaction/detectors.js';
import type { Redactor, RedactionSession } from '../redaction/redactor.js';
import { ProviderError } from '../providers/sdk.js';

/** The one way an agent reaches a model: `createAuditedLlm(...)`. */
export interface AuditedGenerator {
  generate(call: AgentCall): Promise<AuditedResult>;
}

export interface GuardRequest {
  readonly agent: AgentName;
  readonly ticketId: string | null;
  /** Free label for the audit row of a denial, for example `classify`. */
  readonly action: string;
}

export type GuardDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: AiInsightReason };

/**
 * Asked before every model call (N2, N3, PRD section 6.4): the kill switch through the policy gate
 * (`checkAiAction`, T-112) and the daily budget. The composition root builds it from the domain; a
 * guard that throws counts as a refusal. There is no default: an agent without a guard does not run.
 */
export interface AiCallGuard {
  check(request: GuardRequest): Promise<GuardDecision>;
}

export interface AgentDeps {
  readonly llm: AuditedGenerator;
  readonly redactor: Redactor;
  readonly prompts: PromptCatalog;
  readonly guard: AiCallGuard;
}

/** What an agent returns. `skipped`: no model was called. `failed`: it was called and gave nothing usable. */
export type AgentOutcome<T> =
  | { readonly status: 'ok'; readonly value: T; readonly runId: string | null }
  | { readonly status: 'skipped'; readonly reason: AiInsightReason }
  | { readonly status: 'failed'; readonly reason: AiInsightReason };

/** Shared by both agents: the session of the ticket, or a new one scoped to it. */
export function sessionFor(
  deps: Pick<AgentDeps, 'redactor'>,
  scope: string,
  given: RedactionSession | undefined,
): RedactionSession {
  return given ?? deps.redactor.session({ scope });
}

export async function askGuard(guard: AiCallGuard, request: GuardRequest): Promise<GuardDecision> {
  try {
    return await guard.check(request);
  } catch {
    // Fail closed: a gate that cannot answer is a refusal.
    return { allowed: false, reason: 'policy_denied' };
  }
}

/** Redaction refused the text (too many name matches): do not send it to a model. */
export function skippedFor(error: unknown): AiInsightReason | null {
  return error instanceof NameMatchLimitError ? 'name_match_limit' : null;
}

/**
 * Turns an error from `llm.generate` into an outcome, or rethrows what must not be swallowed: a
 * failed audit write (the answer is withheld and the job must retry) and a malformed audit input
 * (a bug).
 */
export function failedFor(error: unknown): AgentOutcome<never> {
  if (error instanceof AuditWriteError || error instanceof AuditInputError) throw error;
  if (error instanceof AuditRecordError) return { status: 'failed', reason: 'audit_failed' };
  if (error instanceof ProviderUnavailableError) {
    return { status: 'failed', reason: 'provider_unavailable' };
  }
  if (error instanceof ProviderError) return { status: 'failed', reason: 'provider_error' };
  return { status: 'failed', reason: 'provider_error' };
}

/**
 * The first JSON object in a model answer (models sometimes wrap it in a code fence or add a
 * sentence). `undefined` when there is none; never throws.
 */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/** Keeps the start and the end of a long text: what the customer asked and the latest turn. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.ceil(max * 0.6);
  const tail = max - head - 5;
  return `${text.slice(0, head)} ... ${text.slice(text.length - tail)}`;
}
