// Entry point for `pnpm db:migrate` and the compose `migrate` service. This is the one place in
// packages/db that reads process.env, because it is an executable, not a library.
import { provisionAiReadOnlyRole, provisionAppRole } from './app-role.js';
import { createDatabase } from './client.js';
import { migrateDown, migrateUp, migrationStatus } from './migrator.js';

const USAGE =
  'usage: cli.js up | down [steps] | status | provision-app-role | provision-ai-role\n' +
  '  MIGRATION_DATABASE_URL (or DATABASE_URL) must be set, as the schema owner.\n' +
  '  up and provision-app-role create the restricted login role when APP_DB_USER and APP_DB_PASSWORD are set.\n' +
  '  up and provision-ai-role create the AI tools read-only login (watchtower_ai_ro) when AI_DB_USER and AI_DB_PASSWORD are set.';

const COMMANDS = ['up', 'down', 'status', 'provision-app-role', 'provision-ai-role'];

async function main(argv: readonly string[]): Promise<number> {
  const [command, stepsArg] = argv;
  // The owner connection runs DDL. DATABASE_URL is what the api uses, which may be the restricted role.
  const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error(`MIGRATION_DATABASE_URL or DATABASE_URL is not set. ${USAGE}`);
    return 2;
  }
  if (command === undefined || !COMMANDS.includes(command)) {
    console.error(USAGE);
    return 2;
  }

  const database = createDatabase({ url, max: 2, applicationName: 'watchtower-migrate' });
  const log = (message: string): void => {
    console.log(message);
  };
  const provision = async (explicit: boolean): Promise<void> => {
    const user = process.env.APP_DB_USER;
    const password = process.env.APP_DB_PASSWORD;
    if (!user || !password) {
      if (explicit) throw new Error('APP_DB_USER and APP_DB_PASSWORD must both be set');
      return;
    }
    const result = await provisionAppRole(database.pool, { user, password });
    log(`${result} login role ${user} (member of watchtower_app)`);
  };
  const provisionAi = async (explicit: boolean): Promise<void> => {
    const user = process.env.AI_DB_USER;
    const password = process.env.AI_DB_PASSWORD;
    if (!user || !password) {
      if (explicit) throw new Error('AI_DB_USER and AI_DB_PASSWORD must both be set');
      return;
    }
    const result = await provisionAiReadOnlyRole(database.pool, { user, password });
    log(`${result} login role ${user} (member of watchtower_ai_ro, reads the ai_v_* views only)`);
  };
  try {
    if (command === 'up') {
      const applied = await migrateUp(database.pool, { log });
      log(
        applied.length === 0
          ? 'database is up to date'
          : `applied ${String(applied.length)} migration(s)`,
      );
      await provision(false);
      await provisionAi(false);
    } else if (command === 'down') {
      const reverted = await migrateDown(database.pool, {
        log,
        steps: stepsArg === undefined ? 1 : Number(stepsArg),
      });
      log(`reverted ${String(reverted.length)} migration(s)`);
    } else if (command === 'provision-app-role') {
      await provision(true);
    } else if (command === 'provision-ai-role') {
      await provisionAi(true);
    } else {
      for (const row of await migrationStatus(database.pool)) {
        log(`${row.applied ? 'applied ' : 'pending '} ${row.id}`);
      }
    }
    return 0;
  } catch (error) {
    // The message never includes the connection string or the password; pg errors name host and
    // database only.
    console.error(`migration failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    return 1;
  } finally {
    await database.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
