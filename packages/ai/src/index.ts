export const packageName = '@watchtower/ai';

export * from './contract.js';
export * from './audited.js';
export * from './audited-embedding.js';
export { hashJson, hmacInputHash, hmacJson, sha256Hex } from './hash.js';
export * from './models.js';
// parsePromptFile and the catalog registry stay internal: only the catalog can make trusted prompts.
export { PromptFileError, renderPrompt, type PromptFile } from './prompts.js';
export * from './prompt-files.js';
export * from './agents/common.js';
export * from './agents/classify.js';
export * from './agents/summarize.js';
export * from './agents/evidence.js';
export * from './agents/investigate.js';
export * from './agents/draft.js';
export * from './agents/kb-author.js';
export * from './toolkit/ports.js';
export * from './toolkit/tools.js';
export * from './toolkit/budget.js';
export * from './tools.js';

export { joinRedacted, type RedactedText } from './redaction/redacted-text.js';
export {
  createRedactor,
  RedactionInputTooLargeError,
  RedactionScopeError,
  type RedactionReport,
  type RedactionSession,
  type RedactionSnapshot,
  type Redactor,
  type RedactorOptions,
  type RestoreAudience,
  type RestoreResult,
  type SessionOptions,
  type TokenEntry,
  type TokenOrigin,
} from './redaction/redactor.js';
export {
  DictionaryTooLargeError,
  MAX_DICTIONARY_CHARS,
  MAX_DICTIONARY_ENTRIES,
  MAX_NAME_CHARS,
  MAX_NAME_MATCHES,
  MAX_NAME_PARTS,
  NameMatchLimitError,
  REDACTION_KINDS,
  type RedactionKind,
} from './redaction/detectors.js';

export { createAnthropicProvider, type AnthropicProviderConfig } from './providers/anthropic.js';
export { DevMockLlmProvider, type DevMockOptions } from './providers/dev-mock.js';
export {
  MockEmbeddingProvider,
  MockLlmProvider,
  MockNoRuleError,
  type MockLlmOptions,
  type MockRule,
} from './providers/mock.js';
export {
  assertAllowedBaseUrl,
  ProviderConfigError,
  ProviderError,
  type FetchLike,
} from './providers/sdk.js';
export {
  createVertexClaudeProvider,
  createVertexEmbeddingProvider,
  createVertexProvider,
  type VertexAuth,
  type VertexClaudeConfig,
  type VertexProviderConfig,
} from './providers/vertex.js';
