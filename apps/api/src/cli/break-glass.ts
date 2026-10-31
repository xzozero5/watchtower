// Creates or resets the break-glass admin from a terminal, for when the environment variables are
// not the right place (a one-off on a server). There is no default password: it is read from
// BREAK_GLASS_PASSWORD or, when that is unset and stdin is piped, from the first line of stdin. It
// is never accepted as an argument, which would leave it in shell history and the process list.
//
//   BREAK_GLASS_PASSWORD='...' DATABASE_URL=... node dist/cli/break-glass.js admin@example.com
//   printf '%s\n' "$PW" | DATABASE_URL=... node dist/cli/break-glass.js admin@example.com
import { createInterface } from 'node:readline';

import { createDatabase } from '@watchtower/db';

import { provisionBreakGlass } from '../auth/break-glass-provision.js';
import { PasswordService } from '../auth/password.service.js';

const USAGE = 'usage: break-glass.js <email>   (password from BREAK_GLASS_PASSWORD or piped stdin)';

async function readPasswordFromStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    lines.close();
    return line;
  }
  return undefined;
}

async function main(argv: readonly string[]): Promise<number> {
  const [email, ...extra] = argv;
  if (!email || extra.length > 0) {
    console.error(USAGE);
    return 2;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(`DATABASE_URL is not set. ${USAGE}`);
    return 2;
  }
  const password = process.env.BREAK_GLASS_PASSWORD || (await readPasswordFromStdin());
  if (!password) {
    console.error(`No password given. ${USAGE}`);
    return 2;
  }

  const database = createDatabase({ url, max: 1, applicationName: 'watchtower-break-glass-cli' });
  try {
    const result = await provisionBreakGlass(database, new PasswordService(), email, password);
    console.log(`break-glass account ${email.trim().toLowerCase()}: ${result}`);
    return 0;
  } catch (error) {
    // Messages name the problem (length, existing account), never the password or the connection string.
    console.error(`failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    return 1;
  } finally {
    await database.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
