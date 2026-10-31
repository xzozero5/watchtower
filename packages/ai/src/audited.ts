import {
  aiRunRecordSchema,
  type AgentName,
  type AiRunRecord,
  type AiRunSink,
  type LlmMessage,
  type LlmProvider,
  type LlmResponse,
  type ModelTier,
  type PromptRef,
  type ProviderKind,
  type SettingsSource,
  type ToolCallRecord,
} from './contract.js';
import { hashLlmInput } from './hash.js';
import { estimateCostUsd, resolveModel } from './models.js';
import type { RedactedText } from './redaction/redacted-text.js';
import type { RedactionReport } from './redaction/redactor.js';

export class ProviderUnavailableError extends Error {
  override readonly name = 'ProviderUnavailableError';
}
/** The model call finished (or failed) but its `ai_run` row could not be written. */
export class AuditWriteError extends Error {
  override readonly name = 'AuditWriteError';
}

export interface AgentCall {
  agent: AgentName;
  prompt: PromptRef;
  system: RedactedText;
  messages: readonly LlmMessage[];
  /** From `RedactionSession.report()`; counts only. */
  redaction: RedactionReport;
  tier?: ModelTier;
  intent?: string | null;
  ticketId?: string | null;
  maxOutputTokens?: number;
  temperature?: number;
  abortSignal?: AbortSignal;
  /** Tool calls made for this run, usually `ScopedTools.calls`. */
  toolCalls?: () => readonly ToolCallRecord[];
  /** Reads a 0..1 confidence from the answer, for agents that produce one. */
  confidence?: (text: string) => number | null;
}

export interface AuditedLlmDeps {
  settings: SettingsSource;
  providers: Partial<Record<ProviderKind, LlmProvider>>;
  sink: AiRunSink;
  /** Milliseconds clock; injectable for tests. */
  now?: () => number;
}

export interface AuditedResult {
  response: LlmResponse;
  run: AiRunRecord;
}

/**
 * The one way an agent calls a model. It picks the model by tier from settings, calls the
 * provider, and writes an `AiRunRecord` for every call, including failures. It fails closed: if
 * the record cannot be written, the answer is not returned (N4: every AI action is audited).
 */
export function createAuditedLlm(deps: AuditedLlmDeps) {
  const now = deps.now ?? Date.now;

  return {
    async generate(call: AgentCall): Promise<AuditedResult> {
      const settings = await deps.settings.load();
      const resolved = resolveModel(settings, call.agent, call.tier);
      const startedAt = now();

      const base = {
        agent: call.agent,
        provider: resolved.provider,
        model: resolved.model,
        tier: resolved.tier,
        prompt: call.prompt,
        inputHash: hashLlmInput(call),
        redaction: { total: call.redaction.total, byKind: { ...call.redaction.byKind } },
        intent: call.intent ?? null,
        ticketId: call.ticketId ?? null,
        startedAt: new Date(startedAt).toISOString(),
      };
      const finish = (outcome: { response?: LlmResponse; error?: unknown }): AiRunRecord => {
        const usage = outcome.response?.usage ?? { inputTokens: 0, outputTokens: 0 };
        return aiRunRecordSchema.parse({
          ...base,
          tools: (call.toolCalls?.() ?? []).map((tool) => tool.name),
          output: outcome.response?.text ?? null,
          confidence:
            outcome.response === undefined
              ? null
              : (call.confidence?.(outcome.response.text) ?? null),
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costUsd:
            outcome.response === undefined
              ? null
              : estimateCostUsd(usage, settings.prices[resolved.model]),
          latencyMs: Math.max(0, now() - startedAt),
          status: outcome.error === undefined ? 'ok' : 'error',
          errorCode:
            outcome.error === undefined
              ? null
              : outcome.error instanceof Error
                ? outcome.error.name
                : 'UnknownError',
        });
      };
      const write = async (run: AiRunRecord, original?: unknown): Promise<void> => {
        try {
          await deps.sink.record(run);
        } catch (error) {
          throw new AuditWriteError('Could not write the ai_run record', {
            cause: original === undefined ? error : new AggregateError([original, error]),
          });
        }
      };

      const provider = deps.providers[resolved.provider];
      let response: LlmResponse;
      try {
        if (provider === undefined) {
          throw new ProviderUnavailableError(`No ${resolved.provider} provider is configured`);
        }
        response = await provider.generate({
          model: resolved.model,
          tier: resolved.tier,
          prompt: call.prompt,
          system: call.system,
          messages: call.messages,
          maxOutputTokens: call.maxOutputTokens,
          temperature: call.temperature,
          abortSignal: call.abortSignal,
        });
      } catch (error) {
        await write(finish({ error }), error);
        throw error;
      }

      const run = finish({ response });
      await write(run);
      return { response, run };
    },
  };
}
