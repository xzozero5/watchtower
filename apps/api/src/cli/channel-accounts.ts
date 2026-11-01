// Registers LINE Official Accounts and Gmail mailboxes from the command line (T-131), the same
// thing as /v1/admin/channel-accounts. Needs the api's environment (DATABASE_URL, APP_URL, API_URL,
// APP_ENCRYPTION_KEY...). Prints ids, names and the LINE webhook URL, never a credential.
//
//   node dist/cli/channel-accounts.js list
//   node dist/cli/channel-accounts.js create line --name "Support LINE"
//   node dist/cli/channel-accounts.js create gmail --name "Support mailbox" --email support@example.com
//   node dist/cli/channel-accounts.js disable <id>
import { createDatabase } from '@watchtower/db';

import { loadConfig } from '../config/config.js';
import { CHANNEL_ACCOUNTS_USAGE, runChannelAccountsCli } from './channel-accounts-cli.js';

async function main(argv: readonly string[]): Promise<number> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    // A ConfigError names variables, never values.
    console.error(error instanceof Error ? error.message : 'invalid environment');
    console.error(CHANNEL_ACCOUNTS_USAGE);
    return 2;
  }
  const database = createDatabase({
    url: config.DATABASE_URL,
    max: 2,
    applicationName: 'watchtower-channel-accounts-cli',
  });
  try {
    return await runChannelAccountsCli(argv, config, database, {
      out: (line) => {
        console.log(line);
      },
      err: (line) => {
        console.error(line);
      },
    });
  } catch {
    // The reason can include connection details; the exit code and this line are enough.
    console.error('failed: the channel account command could not finish');
    return 1;
  } finally {
    await database.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
