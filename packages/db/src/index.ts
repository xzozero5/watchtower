export const packageName = '@watchtower/db';

export { createDatabase, type CreateDatabaseOptions, type Database } from './client.js';
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
