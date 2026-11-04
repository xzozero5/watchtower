// Entry point for `pnpm db:mark-seed` (ADR-025 section 10). Like cli.ts it is an executable, so it may read
// process.env. It marks seed data that was loaded before migration 0096 so the stage 3 promotion reports stop
// counting it. The default is a dry run that only counts.
import { createDatabase } from './client.js';
import { markSeed } from './seed/mark.js';

const USAGE =
  'usage: mark-seed-cli.js [--dry-run] | --apply --i-have-a-backup\n' +
  '  --dry-run              count what would be marked (the default); writes nothing\n' +
  "  --apply                mark the rows. Needs --i-have-a-backup: on a real instance this is the owner's\n" +
  '                         decision after a database backup (AGENTS.md [ASK-HUMAN]).\n' +
  '  MIGRATION_DATABASE_URL (or DATABASE_URL) must be set, as the schema owner.';

async function main(argv: readonly string[]): Promise<number> {
  const apply = argv.includes('--apply');
  const dryRun = !apply;
  const known = new Set(['--dry-run', '--apply', '--i-have-a-backup']);
  if (argv.some((arg) => !known.has(arg)) || (apply && argv.includes('--dry-run'))) {
    console.error(USAGE);
    return 2;
  }
  if (apply && !argv.includes('--i-have-a-backup')) {
    console.error(`refused: --apply needs --i-have-a-backup. ${USAGE}`);
    return 2;
  }
  const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error(`MIGRATION_DATABASE_URL or DATABASE_URL is not set. ${USAGE}`);
    return 2;
  }
  const database = createDatabase({ url, max: 2, applicationName: 'watchtower-mark-seed' });
  try {
    const report = await markSeed(database, { dryRun });
    console.log(dryRun ? 'mark-seed (dry run, nothing written):' : 'mark-seed (applied):');
    for (const kind of report.kinds) {
      console.log(
        `  ${kind.kind}: ${String(kind.organizations)} organization(s), ${String(kind.tickets)} ticket(s) ` +
          `${dryRun ? 'would be marked' : 'marked'}, ${String(kind.leftAlone)} ticket(s) of those organizations left alone` +
          (kind.batchId === null ? '' : ` (batch ${kind.batchId})`),
      );
    }
    return 0;
  } catch (error) {
    console.error(`mark-seed failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    return 1;
  } finally {
    await database.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
