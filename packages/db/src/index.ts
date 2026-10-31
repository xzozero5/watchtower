export const packageName = '@watchtower/db';

export {
  APP_ROLE_GROUP,
  provisionAppRole,
  scramVerifier,
  type AppRoleOptions,
} from './app-role.js';
export { createDatabase, type CreateDatabaseOptions, type Database } from './client.js';
export { orgScopeCondition } from './scope.js';
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
