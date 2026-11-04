// Entry point for `pnpm db:grant-owner-approval <email> [--revoke]` (ADR-025, owner decision 1). Gives one active
// person the permission `ai.autonomy.owner_approve` (approve a stage 3 promotion) or takes it away. It has to
// run with the schema owner's connection: a trigger refuses the application role. Like cli.ts it may read
// process.env because it is an executable.
import { createDatabase } from './client.js';
import { setOwnerApproval } from './owner-approval.js';

const USAGE =
  'usage: owner-approval-cli.js <email> [--revoke]\n' +
  '  MIGRATION_DATABASE_URL (or DATABASE_URL) must be set, as the schema owner.';

async function main(argv: readonly string[]): Promise<number> {
  const revoke = argv.includes('--revoke');
  const positional = argv.filter((arg) => arg !== '--revoke');
  const email = positional[0];
  if (
    positional.length !== 1 ||
    email === undefined ||
    email.startsWith('--') ||
    !email.includes('@')
  ) {
    console.error(USAGE);
    return 2;
  }
  const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error(`MIGRATION_DATABASE_URL or DATABASE_URL is not set. ${USAGE}`);
    return 2;
  }
  const database = createDatabase({ url, max: 1, applicationName: 'watchtower-owner-approval' });
  try {
    const result = await setOwnerApproval(database, email, !revoke);
    if (result === null) {
      console.error('no active user has that address');
      return 1;
    }
    console.log(
      result.change === 'unchanged'
        ? `owner approval already ${revoke ? 'absent' : 'present'} for user ${result.userId}`
        : `owner approval ${result.change} for user ${result.userId}`,
    );
    return 0;
  } catch (error) {
    // Typically "only the schema owner" when the connection is the application role.
    console.error(`failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    return 1;
  } finally {
    await database.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
