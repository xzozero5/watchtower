// Re-wraps the stored integration credentials after APP_ENCRYPTION_KEY was replaced (ADR-012).
// Needs the same environment as the api (DATABASE_URL, APP_ENCRYPTION_KEY, APP_ENCRYPTION_KEY_VERSION
// and, while rotating, APP_ENCRYPTION_KEY_PREVIOUS and its version). Prints counts, never values.
//
//   node dist/cli/credentials.js status
//   node dist/cli/credentials.js rotate
import { createDatabase } from '@watchtower/db';

import { loadConfig } from '../config/config.js';
import { CREDENTIALS_USAGE, runCredentialsCli } from './credentials-cli.js';

async function main(argv: readonly string[]): Promise<number> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    // A ConfigError names variables, never values.
    console.error(error instanceof Error ? error.message : 'invalid environment');
    console.error(CREDENTIALS_USAGE);
    return 2;
  }
  const database = createDatabase({
    url: config.DATABASE_URL,
    max: 2,
    applicationName: 'watchtower-credentials-cli',
  });
  try {
    return await runCredentialsCli(argv, config, database, {
      out: (line) => {
        console.log(line);
      },
      err: (line) => {
        console.error(line);
      },
    });
  } catch {
    // The reason can include connection details; the exit code and this line are enough.
    console.error('failed: the credential command could not finish');
    return 1;
  } finally {
    await database.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
