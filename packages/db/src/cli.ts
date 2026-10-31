// Entry point for `pnpm db:migrate` and the compose `migrate` service. This is the one place in
// packages/db that reads process.env, because it is an executable, not a library.
import { createDatabase } from './client.js';
import { migrateDown, migrateUp, migrationStatus } from './migrator.js';

const USAGE = 'usage: cli.js up | down [steps] | status  (DATABASE_URL must be set)';

async function main(argv: readonly string[]): Promise<number> {
  const [command, stepsArg] = argv;
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(`DATABASE_URL is not set. ${USAGE}`);
    return 2;
  }
  if (command !== 'up' && command !== 'down' && command !== 'status') {
    console.error(USAGE);
    return 2;
  }

  const database = createDatabase({ url, max: 2, applicationName: 'watchtower-migrate' });
  const log = (message: string): void => {
    console.log(message);
  };
  try {
    if (command === 'up') {
      const applied = await migrateUp(database.pool, { log });
      log(
        applied.length === 0
          ? 'database is up to date'
          : `applied ${String(applied.length)} migration(s)`,
      );
    } else if (command === 'down') {
      const reverted = await migrateDown(database.pool, {
        log,
        steps: stepsArg === undefined ? 1 : Number(stepsArg),
      });
      log(`reverted ${String(reverted.length)} migration(s)`);
    } else {
      for (const row of await migrationStatus(database.pool)) {
        log(`${row.applied ? 'applied ' : 'pending '} ${row.id}`);
      }
    }
    return 0;
  } catch (error) {
    // The message never includes the connection string; pg errors name host and database only.
    console.error(`migration failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    return 1;
  } finally {
    await database.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
