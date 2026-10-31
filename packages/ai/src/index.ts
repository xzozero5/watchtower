export const packageName = '@watchtower/ai';

export * from './contract.js';
export * from './audited.js';
export { hashJson, hmacInputHash, sha256Hex } from './hash.js';
export * from './models.js';
export * from './prompts.js';
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
export {
  MockEmbeddingProvider,
  MockLlmProvider,
  MockNoRuleError,
  type MockLlmOptions,
  type MockRule,
} from './providers/mock.js';
export { ProviderConfigError, ProviderError, type FetchLike } from './providers/sdk.js';
export {
  createVertexClaudeProvider,
  createVertexEmbeddingProvider,
  createVertexProvider,
  type VertexAuth,
  type VertexClaudeConfig,
  type VertexProviderConfig,
} from './providers/vertex.js';
