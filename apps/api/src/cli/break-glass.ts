// Creates or resets the break-glass admin from a terminal, for when the environment variables are
// not the right place (a one-off on a server). There is no default password: it is read from
// BREAK_GLASS_PASSWORD or, when that is unset and stdin is piped, from the first line of stdin. It
// is never accepted as an argument, which would leave it in shell history and the process list.
//
//   BREAK_GLASS_PASSWORD='...' DATABASE_URL=... node dist/cli/break-glass.js admin@example.com
//   printf '%s\n' "$PW" | DATABASE_URL=... node dist/cli/break-glass.js admin@example.com
//
// `--unlock` clears every lockout of that account (all client addresses) and writes an audit row;
// it needs no password. Use it when the real admin typed their password wrong too often.
//
//   DATABASE_URL=... node dist/cli/break-glass.js --unlock admin@example.com
import { createInterface } from 'node:readline';

import { createDatabase, type Database } from '@watchtower/db';
import { AUDIT_ACTIONS } from '@watchtower/shared';

import { AuditService } from '../audit/audit.service.js';
import { provisionBreakGlass } from '../auth/break-glass-provision.js';
import { PasswordService } from '../auth/password.service.js';

const USAGE = [
  'usage: break-glass.js <email>            (password from BREAK_GLASS_PASSWORD or piped stdin)',
  '       break-glass.js --unlock <email>   (clear every lockout of the account)',
].join('\n');

async function readPasswordFromStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    lines.close();
    return line;
  }
  return undefined;
}

/** Clears the lockouts of one break-glass account and says so in the audit log. Returns how many addresses were locked or counted. */
async function unlock(database: Database, rawEmail: string): Promise<number | null> {
  const email = rawEmail.trim().toLowerCase();
  const found = await database.pool.query<{ id: string }>(
    'SELECT id FROM users WHERE email = $1 AND is_break_glass',
    [email],
  );
  const id = found.rows[0]?.id;
  if (id === undefined) return null;
  const cleared = await database.pool.query('DELETE FROM break_glass_attempt WHERE user_id = $1', [
    id,
  ]);
  await new AuditService(database).record({
    actor: { type: 'system', id: 'break-glass-cli' },
    action: AUDIT_ACTIONS.breakGlassUnlocked,
    targetType: 'user',
    targetId: id,
    metadata: { clearedAddresses: cleared.rowCount ?? 0 },
  });
  return cleared.rowCount ?? 0;
}

async function main(argv: readonly string[]): Promise<number> {
  const unlockRequested = argv.includes('--unlock');
  const [email, ...extra] = argv.filter((argument) => argument !== '--unlock');
  if (!email || extra.length > 0) {
    console.error(USAGE);
    return 2;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(`DATABASE_URL is not set. ${USAGE}`);
    return 2;
  }
  if (unlockRequested) {
    const database = createDatabase({ url, max: 1, applicationName: 'watchtower-break-glass-cli' });
    try {
      const cleared = await unlock(database, email);
      if (cleared === null) {
        console.error('failed: no break-glass account with that address');
        return 1;
      }
      console.log(
        `break-glass account ${email.trim().toLowerCase()}: unlocked (${String(cleared)} address(es) cleared)`,
      );
      return 0;
    } catch (error) {
      console.error(`failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      return 1;
    } finally {
      await database.close();
    }
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
