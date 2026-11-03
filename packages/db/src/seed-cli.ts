// Entry point for `pnpm db:seed`. Like cli.ts it is an executable, so it may read process.env.
import { ticketKeyPrefixSchema } from '@watchtower/shared';

import { createDatabase } from './client.js';
import { SeedError, runSeed } from './seed/index.js';
import { createSeedObjectStore, s3SettingsFromEnv, seedYear } from './seed/year/index.js';

const USAGE =
  'usage: seed-cli.js [--examples <dir>] [--allow-production]\n' +
  '  Loads DEVELOPMENT/DEMO data: example holidays [VERIFY], SLA policies, intents, fictional\n' +
  '  organizations and tickets. Idempotent; writes only to the database.\n' +
  '  MIGRATION_DATABASE_URL (or DATABASE_URL) must be set; run `pnpm db:migrate` first.\n' +
  '  --examples <dir>  directory with intents/, calendars/ and sla/ (or SEED_EXAMPLES_DIR)\n' +
  '  --allow-production  required when NODE_ENV=production; then only reference data is loaded\n' +
  '                      (calendars, SLA policies, intents, shifts): no demo people, tickets or articles';

async function main(argv: readonly string[]): Promise<number> {
  let examplesDir = process.env.SEED_EXAMPLES_DIR || undefined;
  let allowProduction = false;
  let scenario: string | undefined;
  let yearSeed: number | undefined;
  let yearTickets: number | undefined;
  let withAttachments = true;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--allow-production') allowProduction = true;
    else if (arg === '--no-attachments') withAttachments = false;
    else if (arg === '--scenario' || arg === '--seed' || arg === '--tickets') {
      const value = argv[index + 1];
      index += 1;
      if (
        !value ||
        (arg === '--scenario' && value !== 'year') ||
        (arg !== '--scenario' && !/^\d+$/.test(value))
      ) {
        console.error(USAGE);
        return 2;
      }
      if (arg === '--scenario') scenario = value;
      else if (arg === '--seed') yearSeed = Number(value);
      else yearTickets = Number(value);
    } else if (arg === '--examples') {
      examplesDir = argv[index + 1];
      index += 1;
      if (!examplesDir) {
        console.error(USAGE);
        return 2;
      }
    } else {
      console.error(USAGE);
      return 2;
    }
  }
  const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error(`MIGRATION_DATABASE_URL or DATABASE_URL is not set. ${USAGE}`);
    return 2;
  }

  if (scenario === 'year' && process.env.NODE_ENV === 'production') {
    console.error(
      'seed refused: the one-year scenario is demo data and never runs with NODE_ENV=production',
    );
    return 1;
  }

  const database = createDatabase({ url, max: 2, applicationName: 'watchtower-seed' });
  try {
    await runSeed(database, {
      nodeEnv: process.env.NODE_ENV,
      allowProduction,
      ...(examplesDir === undefined ? {} : { examplesDir }),
      // Same normalisation as the api config, so seeded keys match what the api resolves.
      ticketKeyPrefix: ticketKeyPrefixSchema.parse(process.env.TICKET_KEY_PREFIX || 'OPS'),
      log: (message) => {
        console.log(`seeded: ${message}`);
      },
    });
    if (scenario === 'year') {
      const s3 = withAttachments ? s3SettingsFromEnv(process.env) : null;
      const result = await seedYear(database, {
        now: new Date(),
        ticketKeyPrefix: ticketKeyPrefixSchema.parse(process.env.TICKET_KEY_PREFIX || 'OPS'),
        ...(yearSeed === undefined ? {} : { seed: yearSeed }),
        ...(yearTickets === undefined ? {} : { ticketTarget: yearTickets }),
        objectStore: s3 ? createSeedObjectStore(s3) : null,
        log: (message) => {
          console.log(`seeded: ${message}`);
        },
      });
      if (!result.skipped) {
        console.log(`seeded: rows ${JSON.stringify(result.rows)}`);
        console.log(
          `seeded: attachment images uploaded: ${String(result.attachmentFiles)}${s3 ? '' : ' (no S3_* settings: no attachment rows written)'}`,
        );
      }
    }
    return 0;
  } catch (error) {
    // Messages name files and counts, never the connection string.
    const label = error instanceof SeedError ? 'seed refused or invalid' : 'seed failed';
    console.error(`${label}: ${error instanceof Error ? error.message : 'unknown error'}`);
    return 1;
  } finally {
    await database.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
