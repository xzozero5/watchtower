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
import { hmacInputHash } from './hash.js';
import { estimateCostUsd, resolveModel } from './models.js';
import type { RedactedText } from './redaction/redacted-text.js';
import type { RedactionReport } from './redaction/redactor.js';

export class ProviderUnavailableError extends Error {
  override readonly name = 'ProviderUnavailableError';
}
/** The call's own fields cannot form a valid `ai_run` row, so nothing was sent to the provider. */
export class AuditInputError extends Error {
  override readonly name = 'AuditInputError';
}
/** The model call finished (or failed) but its `ai_run` row could not be written. */
export class AuditWriteError extends Error {
  override readonly name = 'AuditWriteError';
}
/** The provider answered but the full record was invalid; a minimal error row was written. */
export class AuditRecordError extends Error {
  override readonly name = 'AuditRecordError';
}

/** What the audit needs from a redaction session: its running counts (`RedactionSession` has it). */
export interface RedactionReportSource {
  report(): RedactionReport;
}

export interface AgentCall {
  agent: AgentName;
  prompt: PromptRef;
  system: RedactedText;
  messages: readonly LlmMessage[];
  /**
   * The redaction session the prompt text came from. The audit row takes its counts from the
   * session itself, when the call is made (SR106-R9): a caller cannot hand in a smaller number.
   */
  redaction: RedactionReportSource;
  tier?: ModelTier;
  intent?: string | null;
  ticketId?: string | null;
  maxOutputTokens?: number;
  temperature?: number;
  abortSignal?: AbortSignal;
  /** Tool calls made for this run, usually `ScopedTools.calls`. */
  toolCalls?: () => readonly ToolCallRecord[];
  /** Reads a 0..1 confidence from the answer. Out-of-range values are clamped; a throw gives null. */
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
  /** The id the sink gave the row (`ai_run.id`), when it reports one. */
  runId: string | null;
}

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;

function attempt<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function clampConfidence(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : null;
}

/**
 * The one way an agent calls a model. It picks the model by tier from settings, calls the
 * provider, and writes an `AiRunRecord` for every call, including failures.
 *
 * Invariants (tested for every failure path):
 *  - the record's own fields are validated before the provider is called, so a malformed prompt
 *    hash or ticket id fails with `AuditInputError` and costs nothing;
 *  - once the provider has been called, a record is always written: a bad `confidence`, a
 *    throwing `toolCalls` or odd usage numbers are sanitised, and if the record is still invalid
 *    a minimal `status: 'error'` row is written;
 *  - it fails closed: if the row cannot be written the answer is not returned (N4).
 */
export function createAuditedLlm(deps: AuditedLlmDeps) {
  const now = deps.now ?? Date.now;

  return {
    async generate(call: AgentCall): Promise<AuditedResult> {
      const settings = await deps.settings.load();
      const resolved = resolveModel(settings, call.agent, call.tier);
      const startedAt = now();
      let report: RedactionReport;
      try {
        report = call.redaction.report();
      } catch {
        throw new AuditInputError('Invalid audit fields: redaction');
      }

      const base = {
        agent: call.agent,
        provider: resolved.provider,
        model: resolved.model,
        tier: resolved.tier,
        prompt: call.prompt,
        inputHash: hmacInputHash(settings.inputHashKey, call),
        redaction: { total: report.total, byKind: { ...report.byKind } },
        intent: call.intent ?? null,
        ticketId: call.ticketId ?? null,
        startedAt: new Date(startedAt).toISOString(),
      };
      const empty = {
        tools: [] as string[],
        output: null,
        confidence: null,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: null,
        latencyMs: 0,
        status: 'error' as const,
        errorCode: 'NotCalled',
      };

      // Validate everything we can before spending money.
      const probe = aiRunRecordSchema.safeParse({ ...base, ...empty });
      if (!probe.success) {
        const fields = [...new Set(probe.error.issues.map((issue) => issue.path.join('.')))];
        throw new AuditInputError(`Invalid audit fields: ${fields.join(', ')}`);
      }

      const write = async (run: AiRunRecord, original?: unknown): Promise<string | null> => {
        try {
          const receipt = await deps.sink.record(run);
          return typeof receipt === 'object' && typeof receipt.id === 'string' ? receipt.id : null;
        } catch (error) {
          throw new AuditWriteError('Could not write the ai_run record', {
            cause: original === undefined ? error : new AggregateError([original, error]),
          });
        }
      };

      // `finish` must never throw: once the provider has been called, a row is always written.
      // The provider is third-party code behind a port, so nothing it returns is trusted to have
      // the declared shape (SR106-N3): a missing `usage`, a response that is not an object, or an
      // error whose `name` is not a string all end in a row, never in a TypeError.
      const finish = (outcome: {
        response?: LlmResponse;
        error?: unknown;
      }): { run: AiRunRecord; degraded: boolean } => {
        // What the provider actually returned, which may not match its declared type.
        const response = (typeof outcome.response === 'object' ? outcome.response : null) as {
          text?: unknown;
          usage?: { inputTokens?: unknown; outputTokens?: unknown } | null;
        } | null;
        const usageKnown = typeof response?.usage === 'object' && response.usage !== null;
        const usage = {
          inputTokens: attempt(() => count(response?.usage?.inputTokens ?? 0), 0),
          outputTokens: attempt(() => count(response?.usage?.outputTokens ?? 0), 0),
        };
        const latencyMs =
          Math.max(
            0,
            attempt(() => now() - startedAt, 0),
          ) || 0;
        const errorName =
          outcome.error === undefined
            ? null
            : attempt(
                () =>
                  outcome.error instanceof Error && typeof outcome.error.name === 'string'
                    ? outcome.error.name.slice(0, 100) || 'Error'
                    : 'UnknownError',
                'UnknownError',
              );
        const text = typeof response?.text === 'string' ? response.text : undefined;
        const minimal = (): { run: AiRunRecord; degraded: boolean } => ({
          run: aiRunRecordSchema.parse({
            ...base,
            ...empty,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            latencyMs,
            errorCode: errorName ?? 'AuditRecordInvalid',
          }),
          degraded: true,
        });
        // A success with no readable answer is not a success.
        if (outcome.error === undefined && text === undefined) return minimal();
        try {
          const parsed = aiRunRecordSchema.safeParse({
            ...base,
            tools: attempt(() => (call.toolCalls?.() ?? []).map((tool) => tool.name), []),
            output: text ?? null,
            confidence:
              text === undefined
                ? null
                : clampConfidence(attempt(() => call.confidence?.(text), null)),
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            // No usage from the provider means the cost is unknown, not zero.
            costUsd:
              text === undefined || !usageKnown
                ? null
                : attempt(() => estimateCostUsd(usage, settings.prices[resolved.model]), null),
            latencyMs,
            status: errorName === null ? 'ok' : 'error',
            errorCode: errorName,
          });
          if (parsed.success) return { run: parsed.data, degraded: false };
        } catch {
          // fall through to the minimal row
        }
        return minimal();
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
        await write(finish({ error }).run, error);
        throw error;
      }

      const { run, degraded } = finish({ response });
      const runId = await write(run);
      if (degraded)
        throw new AuditRecordError('The ai_run record was invalid; an error row was written');
      return { response, run, runId };
    },
  };
}
