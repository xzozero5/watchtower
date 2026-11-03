// Entry point for `pnpm kb:sync` (ADR-019). Like seed-cli.ts it is an executable, so it may read process.env.
import { createDatabase } from './client.js';
import { KbSyncError, loadKbFolder } from './kb-sync/parse.js';
import { syncKbArticles } from './kb-sync/sync.js';

const USAGE =
  'usage: kb-sync-cli.js [--dir <folder>] [--dry-run]\n' +
  '  Imports the Markdown articles of the knowledge base folder (WATCHTOWER_KB_DIR, or --dir) into\n' +
  '  kb_article / kb_article_version. Idempotent. Customer-visible articles arrive as drafts.\n' +
  '  MIGRATION_DATABASE_URL (or DATABASE_URL) must be set and point at a Postgres reachable from this machine.\n' +
  '  --dry-run  read and validate the folder only; the database is not touched';

async function main(argv: readonly string[]): Promise<number> {
  let dir = process.env.WATCHTOWER_KB_DIR || undefined;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--dir') {
      dir = argv[index + 1];
      index += 1;
    } else {
      console.error(USAGE);
      return 2;
    }
  }
  if (!dir) {
    console.error(`WATCHTOWER_KB_DIR or --dir is not set. ${USAGE}`);
    return 2;
  }
  try {
    const articles = await loadKbFolder(dir);
    console.log(`kb:sync read ${String(articles.length)} article file(s)`);
    if (dryRun) return 0;
    const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
    if (!url) {
      console.error(`MIGRATION_DATABASE_URL or DATABASE_URL is not set. ${USAGE}`);
      return 2;
    }
    const database = createDatabase({ url, max: 2, applicationName: 'watchtower-kb-sync' });
    try {
      const { entries } = await syncKbArticles(database, articles);
      for (const entry of entries) {
        console.log(
          `kb:sync ${entry.outcome} ${entry.slug}${entry.note ? ` (${entry.note})` : ''}`,
        );
      }
    } finally {
      await database.close();
    }
    return 0;
  } catch (error) {
    // Messages name files and slugs, never the connection string or article text.
    const label = error instanceof KbSyncError ? 'kb:sync refused' : 'kb:sync failed';
    console.error(`${label}: ${error instanceof Error ? error.message : 'unknown error'}`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
