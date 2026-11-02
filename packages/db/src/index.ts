export const packageName = '@watchtower/db';

export {
  AI_READONLY_ROLE_GROUP,
  APP_ROLE_GROUP,
  provisionAiReadOnlyRole,
  provisionAppRole,
  scramVerifier,
  type AppRoleOptions,
} from './app-role.js';
export {
  CLEANUP_TARGETS,
  DEFAULT_AUTH_RETENTION_DAYS,
  DEFAULT_AI_SUMMARY_RETENTION_DAYS,
  DEFAULT_ASSISTANT_PROPOSAL_RETENTION_DAYS,
  DEFAULT_ASSISTANT_RETENTION_DAYS,
  DEFAULT_BREAK_GLASS_RETENTION_DAYS,
  purgeExpired,
  type CleanupOptions,
  type CleanupResult,
  type CleanupTarget,
} from './cleanup.js';
export {
  CREDENTIAL_ERROR_CODES,
  CredentialStoreError,
  createCredentialStore,
  type CredentialErrorCode,
  type CredentialExecutor,
  type CredentialStore,
  type CredentialStoreOptions,
  type ResealResult,
  type ResolveOptions,
  type RotateOptions,
  type ResolvedField,
  type RotateFailure,
  type RotateResult,
} from './credentials.js';
export { createDatabase, type CreateDatabaseOptions, type Database } from './client.js';
export { PG, isPgError, pgCode, pgConstraint } from './errors.js';
export {
  PermanentOutboxError,
  enqueueOutbox,
  outboxBacklog,
  purgeOutbox,
  relayOutbox,
  type OutboxBacklog,
  type OutboxJob,
  type OutboxPublisher,
  type OutboxRow,
  type OutboxWriter,
  type RelayOptions,
  type RelayResult,
} from './outbox.js';
export {
  createProductDbExecutor,
  PRODUCT_RESULT_HARD_BYTES,
  PRODUCT_RESULT_SOFT_BYTES,
  ProductDbError,
  isSandboxDatabase,
  type ProductDbExecutor,
  type ProductDbOptions,
  type ProductQueryInput,
  type ProductQueryResult,
  type ProductValue,
} from './product-db.js';
export { orgScopeCondition } from './scope.js';
export {
  DEFAULT_EXAMPLES_DIR,
  SeedError,
  assertSeedAllowed,
  loadHolidayFiles,
  loadSlaPolicyFiles,
  runSeed,
  type SeedOptions,
  type SeedResult,
} from './seed/index.js';
export {
  DEFAULT_INTENT_EXAMPLES_DIR,
  IntentSeedError,
  loadIntentDefinitions,
  seedIntents,
  upsertIntentDefinitions,
  type IntentSeedResult,
} from './seed/intents.js';
export {
  DEFAULT_MIGRATIONS_DIR,
  MIGRATIONS_TABLE,
  MigrationError,
  loadMigrations,
  migrateDown,
  migrateUp,
  migrationStatus,
  type AppliedMigration,
  type Migration,
  type MigrationStatus,
  type MigratorOptions,
} from './migrator.js';
export * as schema from './schema/index.js';
