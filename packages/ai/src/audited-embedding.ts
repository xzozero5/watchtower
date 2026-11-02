import { AuditInputError, AuditWriteError, ProviderUnavailableError } from './audited.js';
import {
  aiRunRecordSchema,
  type AiRunRecord,
  type AiRunSink,
  type EmbeddingProvider,
  type ProviderKind,
  type SettingsSource,
} from './contract.js';
import { askGuard, type AiCallGuard } from './agents/common.js';
import { hmacInputHash, sha256Hex } from './hash.js';
import { estimateCostUsd } from './models.js';
import { joinRedacted } from './redaction/redacted-text.js';
import type { Redactor } from './redaction/redactor.js';
import type { AiInsightReason } from '@watchtower/shared';

/** What the embedding agent calls its run in `ai_run`: a label, not a prompt file. */
const EMBED_PROMPT = { id: 'embedding', version: 1 } as const;
const EMBED_PROMPT_HASH = sha256Hex(`${EMBED_PROMPT.id}:${String(EMBED_PROMPT.version)}`);

/** The provider answered, but not with one vector of the configured size per input. */
export class EmbeddingShapeError extends Error {
  override readonly name = 'EmbeddingShapeError';
}

export interface EmbedCall {
  /**
   * Plain text. It is redacted here (N4), inside one session scoped to `scope`, so a caller cannot
   * forget to and the provider never sees the original. Neither the text nor the vectors are kept
   * by this function.
   */
  readonly texts: readonly string[];
  /** Redaction scope, for example `kb:<articleId>`; the same value gets the same token inside it. */
  readonly scope: string;
  /** Free label of why, for the guard's denial row (for example `kb_index`, `kb_query`). */
  readonly action: string;
  readonly abortSignal?: AbortSignal;
}

export type EmbedOutcome =
  | {
      readonly status: 'ok';
      /** One vector per input text, in order. */
      readonly embeddings: number[][];
      readonly provider: ProviderKind;
      readonly model: string;
      readonly dimensions: number;
      /** `ai_run.id` of the row that metered this call, when the sink reports one. */
      readonly runId: string | null;
    }
  | { readonly status: 'skipped'; readonly reason: AiInsightReason };

export interface AuditedEmbedderDeps {
  readonly settings: SettingsSource;
  readonly providers: Partial<Record<ProviderKind, EmbeddingProvider>>;
  readonly sink: AiRunSink;
  /** Its name dictionary stays empty here: knowledge base text carries no ticket participants. */
  readonly redactor: Redactor;
  /** Kill switch and daily budget, like every other model call (N2, PRD section 6.4). */
  readonly guard: AiCallGuard;
  readonly now?: () => number;
}

const tokens = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;

/**
 * The one way the knowledge base reaches an embedding model. It asks the guard, redacts every
 * text, calls the provider named in settings (`settings.embedding`), checks the vectors have the
 * configured size, and writes an `ai_run` row for the call, failures included (agent `embedder`).
 * It fails closed like `createAuditedLlm`: when the row cannot be written the vectors are not
 * returned. A refusal by the guard returns `skipped` and calls nothing.
 */
export function createAuditedEmbedder(deps: AuditedEmbedderDeps) {
  const now = deps.now ?? Date.now;

  return {
    async embed(call: EmbedCall): Promise<EmbedOutcome> {
      if (call.texts.length === 0) throw new AuditInputError('Nothing to embed');
      const decision = await askGuard(deps.guard, {
        agent: 'embedder',
        ticketId: null,
        action: call.action,
      });
      if (!decision.allowed) return { status: 'skipped', reason: decision.reason };

      const settings = await deps.settings.load();
      const { provider: kind, model, dimensions } = settings.embedding;

      const session = deps.redactor.session({ scope: call.scope });
      const values = call.texts.map((text) => session.redact(text));
      const report = session.report();
      const startedAt = now();

      const base = {
        agent: 'embedder' as const,
        provider: kind,
        model,
        tier: 'light' as const,
        prompt: { ...EMBED_PROMPT, hash: EMBED_PROMPT_HASH },
        tools: [] as string[],
        inputHash: hmacInputHash(settings.inputHashKey, {
          system: joinRedacted([]),
          messages: [{ role: 'user', content: joinRedacted(values) }],
        }),
        output: null,
        confidence: null,
        // `dictionary_incomplete: 1` marks a run whose name dictionary was cut short (QA-30); no value is stored.
        redaction: {
          total: report.total,
          byKind: {
            ...report.byKind,
            ...(report.dictionaryIncomplete === true ? { dictionary_incomplete: 1 } : {}),
          },
        },
        intent: null,
        ticketId: null,
        startedAt: new Date(startedAt).toISOString(),
      };

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
      const row = (extra: {
        inputTokens: number;
        costUsd: number | null;
        status: 'ok' | 'error';
        errorCode: string | null;
      }): AiRunRecord =>
        aiRunRecordSchema.parse({
          ...base,
          outputTokens: 0,
          latencyMs: Math.max(0, now() - startedAt),
          ...extra,
        });

      const provider = deps.providers[kind];
      try {
        if (provider === undefined) {
          throw new ProviderUnavailableError(`No ${kind} embedding provider is configured`);
        }
        const response = await provider.embed({
          model,
          values,
          dimensions,
          abortSignal: call.abortSignal,
        });
        const vectors = response.embeddings as unknown;
        const shaped =
          Array.isArray(vectors) &&
          vectors.length === values.length &&
          vectors.every(
            (vector) =>
              Array.isArray(vector) &&
              vector.length === dimensions &&
              vector.every((item) => typeof item === 'number' && Number.isFinite(item)),
          );
        const inputTokens = tokens((response as { usage?: { tokens?: unknown } }).usage?.tokens);
        if (!shaped) {
          const error = new EmbeddingShapeError('The provider returned unusable vectors');
          await write(
            row({ inputTokens, costUsd: null, status: 'error', errorCode: error.name }),
            error,
          );
          throw error;
        }
        const runId = await write(
          row({
            inputTokens,
            costUsd: estimateCostUsd({ inputTokens, outputTokens: 0 }, settings.prices[model]),
            status: 'ok',
            errorCode: null,
          }),
        );
        return {
          status: 'ok',
          embeddings: response.embeddings,
          provider: kind,
          model,
          dimensions,
          runId,
        };
      } catch (error) {
        if (error instanceof AuditWriteError || error instanceof EmbeddingShapeError) throw error;
        const name =
          error instanceof Error && typeof error.name === 'string'
            ? error.name.slice(0, 100) || 'Error'
            : 'UnknownError';
        await write(
          row({ inputTokens: 0, costUsd: null, status: 'error', errorCode: name }),
          error,
        );
        throw error;
      }
    },
  };
}

export type AuditedEmbedder = ReturnType<typeof createAuditedEmbedder>;
