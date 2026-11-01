export const packageName = '@watchtower/db';

export {
  APP_ROLE_GROUP,
  provisionAppRole,
  scramVerifier,
  type AppRoleOptions,
} from './app-role.js';
export {
  CREDENTIAL_ERROR_CODES,
  CredentialStoreError,
  createCredentialStore,
  type CredentialErrorCode,
  type CredentialExecutor,
  type CredentialStore,
  type CredentialStoreOptions,
  type ResolveOptions,
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
