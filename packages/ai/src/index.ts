export const packageName = '@watchtower/ai';

export * from './contract.js';
export * from './audited.js';
export { hashJson, hashLlmInput, sha256Hex } from './hash.js';
export * from './models.js';
export * from './prompts.js';
export * from './tools.js';

export { joinRedacted, type RedactedText } from './redaction/redacted-text.js';
export {
  createRedactor,
  type RedactionReport,
  type RedactionSession,
  type Redactor,
  type RedactorOptions,
} from './redaction/redactor.js';
export { REDACTION_KINDS, type RedactionKind } from './redaction/detectors.js';

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
