/**
 * The ports and record shapes of the AI layer (ADR-008).
 *
 * This file is the contract. It may move to `packages/shared` once the per-feature files there
 * exist (T-123a); until then it lives here because `packages/shared` is a leaf that `ai` imports
 * but must not be edited in parallel. `packages/ai` knows neither HTTP nor the database: the
 * composition root in `apps/api` or `apps/worker` supplies the implementations of the ports.
 */
import { z } from 'zod';

import type { RedactedText } from './redaction/redacted-text.js';

// ---------------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------------

/**
 * PRD §6.7. `mock` is the default and never touches the network. `claude-cli` is a dev/POC-only
 * kind (ADR-017): it reaches a local Claude Code CLI through a host-side bridge and is refused
 * when `NODE_ENV=production`.
 */
export const PROVIDER_KINDS = ['mock', 'anthropic', 'vertex', 'claude-cli'] as const;
export const providerKindSchema = z.enum(PROVIDER_KINDS);
export type ProviderKind = z.infer<typeof providerKindSchema>;

/** Same vocabulary as `config/models.yaml`. Model ids come from settings, never from code. */
export const MODEL_TIERS = ['deep', 'standard', 'light'] as const;
export const modelTierSchema = z.enum(MODEL_TIERS);
export type ModelTier = z.infer<typeof modelTierSchema>;

/** PRD §6.2. */
export const AGENT_NAMES = [
  'classifier',
  'investigator',
  'drafter',
  'summarizer',
  'grader',
  'kb_author',
  'roster_planner',
  'personal_assistant',
  // Narrates facts of an element into at most three cited claims per language (T-417, ADR-029 section 9).
  'insight_narrator',
  // Drafts the steps of an intent's procedure from the text a lead wrote; a person confirms (T-303b, ADR-026).
  'procedure_compiler',
  // Knowledge base indexing and query embedding (T-107b): no prompt, one embedding call per batch.
  'embedder',
] as const;
export const agentNameSchema = z.enum(AGENT_NAMES);
export type AgentName = z.infer<typeof agentNameSchema>;

/** Default tier per agent `[ASSUMED]`; settings can override per agent. */
export const DEFAULT_AGENT_TIERS: Readonly<Record<AgentName, ModelTier>> = {
  classifier: 'light',
  summarizer: 'light',
  investigator: 'deep',
  drafter: 'deep',
  grader: 'standard',
  kb_author: 'standard',
  roster_planner: 'standard',
  personal_assistant: 'standard',
  insight_narrator: 'light',
  procedure_compiler: 'standard',
  embedder: 'light',
};

// ---------------------------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------------------------

/** A versioned prompt file in `packages/ai/prompts/`. The hash is of the file content. */
export const promptRefSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_.-]*$/),
  version: z.number().int().positive(),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type PromptRef = z.infer<typeof promptRefSchema>;

// ---------------------------------------------------------------------------------------------
// LlmProvider
// ---------------------------------------------------------------------------------------------

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: RedactedText;
}

/**
 * Every text field is `RedactedText` (N4): a plain string does not compile. Implementations must
 * not add text of their own that came from outside the package.
 */
export interface LlmRequest {
  /** Resolved from settings by tier; the adapter passes it through. */
  model: string;
  tier: ModelTier;
  prompt: PromptRef;
  system: RedactedText;
  messages: readonly LlmMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  abortSignal?: AbortSignal;
}

export const LLM_FINISH_REASONS = ['stop', 'length', 'content_filter', 'error', 'other'] as const;
export type LlmFinishReason = (typeof LLM_FINISH_REASONS)[number];

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** `text` may contain placeholder tokens (`[EMAIL_1]`); the caller restores them for humans. */
export interface LlmResponse {
  text: string;
  finishReason: LlmFinishReason;
  usage: TokenUsage;
  /** Model id as the provider reported it, falling back to the requested one. */
  model: string;
}

export interface LlmProvider {
  readonly kind: ProviderKind;
  generate(request: LlmRequest): Promise<LlmResponse>;
}

// ---------------------------------------------------------------------------------------------
// EmbeddingProvider
// ---------------------------------------------------------------------------------------------

export interface EmbeddingRequest {
  model: string;
  values: readonly RedactedText[];
  dimensions?: number;
  abortSignal?: AbortSignal;
}

export interface EmbeddingResponse {
  embeddings: number[][];
  usage: { tokens: number };
  model: string;
}

export interface EmbeddingProvider {
  readonly kind: ProviderKind;
  embed(request: EmbeddingRequest): Promise<EmbeddingResponse>;
}

// ---------------------------------------------------------------------------------------------
// SettingsSource (PRD §6.7: head-only settings stored in the database)
// ---------------------------------------------------------------------------------------------

export const modelRefSchema = z.object({
  provider: providerKindSchema,
  /** Opaque model id from admin settings. Never a literal in code. */
  model: z.string().min(1),
});
export type ModelRef = z.infer<typeof modelRefSchema>;

export const modelPriceSchema = z.object({
  inputUsdPerMTok: z.number().nonnegative(),
  outputUsdPerMTok: z.number().nonnegative(),
});
export type ModelPrice = z.infer<typeof modelPriceSchema>;

export const aiSettingsSchema = z.object({
  tiers: z.object({
    deep: modelRefSchema,
    standard: modelRefSchema,
    light: modelRefSchema,
  }),
  /** Overrides `DEFAULT_AGENT_TIERS`, e.g. a grader on a different vendor. */
  agentTiers: z.partialRecord(agentNameSchema, modelTierSchema).default({}),
  /**
   * A model id (or CLI alias) for one agent, on the provider of that agent's tier. Wins over the
   * tier's model; the agent keeps its tier label in `ai_run`. Never a literal in code (T-301c).
   */
  agentModels: z.partialRecord(agentNameSchema, z.string().min(1)).default({}),
  embedding: z.object({
    provider: providerKindSchema,
    model: z.string().min(1),
    dimensions: z.number().int().positive(),
  }),
  /**
   * Server-side HMAC key for `AiRunRecord.inputHash`. Load it from the environment or the
   * credential store, never log it, and rotate it under the usual key policy.
   */
  inputHashKey: z.string().min(32),
  /** Keyed by model id. A model without a price is metered with `costUsd: null`. */
  prices: z.record(z.string(), modelPriceSchema).default({}),
});
export type AiSettings = z.infer<typeof aiSettingsSchema>;

export interface SettingsSource {
  load(): Promise<AiSettings>;
}

// ---------------------------------------------------------------------------------------------
// AiRunSink and the audit record (PRD §6.1, §8.2; persisted by T-106d as `ai_run`)
// ---------------------------------------------------------------------------------------------

export const AI_RUN_STATUSES = ['ok', 'error'] as const;

export const aiRunRecordSchema = z.object({
  agent: agentNameSchema,
  provider: providerKindSchema,
  model: z.string().min(1),
  /** The model id the provider answered with (`ai_run.response_model`); absent or null when none was reported. */
  responseModel: z.string().min(1).max(200).nullable().optional(),
  tier: modelTierSchema,
  prompt: promptRefSchema,
  /** Names of the tools the run called, in order (`ToolCallRecord` carries the detail). */
  tools: z.array(z.string()),
  /** HMAC-SHA-256, keyed by the server-side hash key from settings, of the redacted input. */
  inputHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** The model's answer, still in redacted (placeholder) form. Null when the run failed. */
  output: z.string().nullable(),
  /** 0..1 when the agent produced one; classifier and grader do. */
  confidence: z.number().min(0).max(1).nullable(),
  /** Counts of what the redactor replaced. No original values. */
  redaction: z.object({
    total: z.number().int().nonnegative(),
    byKind: z.record(z.string(), z.number().int().nonnegative()),
  }),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /** Null when the model has no price in settings (cost unknown, not zero). */
  costUsd: z.number().nonnegative().nullable(),
  latencyMs: z.number().nonnegative(),
  status: z.enum(AI_RUN_STATUSES),
  /** Error class only (for example `ProviderError`), never the message or the payload. */
  errorCode: z.string().nullable(),
  /** Correlation, filled by the caller. */
  intent: z.string().nullable(),
  ticketId: z.string().nullable(),
  /** The procedure version the run followed (T-303c, `ai_run.procedure_version_id`). Absent: none. */
  procedureVersionId: z.uuid().nullable().optional(),
  startedAt: z.iso.datetime(),
});
export type AiRunRecord = z.infer<typeof aiRunRecordSchema>;

/**
 * Receives one record per model call, including failed ones. The implementation in `apps/*`
 * writes `ai_run` (append-only). A sink that throws must not hide the model's answer from the
 * caller, but the failure must be loud; see `createAuditedLlm`.
 */
export interface AiRunSink {
  /** May return the id of the row it wrote, so the caller can link to it (`AuditedResult.runId`). */
  // `void` stays in the union so a sink that returns nothing (`Promise<void>`) still fits.
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
  record(run: AiRunRecord): Promise<void | AiRunReceipt>;
}

/** What a sink says about the row it wrote. */
export interface AiRunReceipt {
  id: string;
}

// ---------------------------------------------------------------------------------------------
// ToolRegistry (N2: read-only, allow-listed per agent / intent / stage)
// ---------------------------------------------------------------------------------------------

export const AUTONOMY_STAGES = [0, 1, 2, 3, 4] as const;
export type AutonomyStage = (typeof AUTONOMY_STAGES)[number];

export interface ToolScope {
  agent: AgentName;
  /** Intent key, or null before classification. A null intent matches only `'*'` rules. */
  intent: string | null;
  stage: AutonomyStage;
}

export interface ToolContext extends ToolScope {
  abortSignal?: AbortSignal;
  /**
   * The ticket the run is about. A tool reads data of this ticket and its organization only: the
   * id comes from the run, never from the model's arguments (N2, SR106-R8).
   */
  ticketId?: string | null;
}

/**
 * `readOnly: true` is a literal type: a tool that writes cannot be declared. Write actions go
 * through the policy gate or a human click, not through this registry.
 */
export interface ToolDefinition<
  Input extends z.ZodType = z.ZodType,
  Output extends z.ZodType = z.ZodType,
> {
  name: string;
  description: string;
  readOnly: true;
  /** The tool answers from a fixture, not from the real system (N5): its output is labelled so. */
  mock?: boolean;
  input: Input;
  output: Output;
  execute(input: z.output<Input>, context: ToolContext): Promise<z.input<Output>>;
}

/**
 * Deny by default. A rule grants `tools` to an agent (or `'*'`) for an intent (or `'*'`) at the
 * listed stages (all stages when omitted).
 */
export interface ToolAllowRule {
  agent: AgentName | '*';
  intent: string;
  stages?: readonly AutonomyStage[];
  tools: readonly string[];
}

export interface ToolSummary {
  name: string;
  description: string;
  mock: boolean;
}

export interface ToolCallRecord {
  name: string;
  inputHash: string;
  ok: boolean;
  latencyMs: number;
  errorCode: string | null;
}

/** A registry view bound to one run: it lists, runs and records only what the scope allows. */
export interface ScopedTools {
  list(): ToolSummary[];
  call(name: string, rawInput: unknown): Promise<unknown>;
  calls(): readonly ToolCallRecord[];
}

export interface ToolRegistry {
  register(tool: ToolDefinition): void;
  scope(
    scope: ToolScope,
    options?: { abortSignal?: AbortSignal; maxCalls?: number; ticketId?: string | null },
  ): ScopedTools;
}
