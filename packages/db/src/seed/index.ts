import { join } from 'node:path';

import { DEFAULT_TICKET_KEY_PREFIX } from '@watchtower/shared';

import type { Database } from '../client.js';
import { SeedError, DEFAULT_EXAMPLES_DIR } from './common.js';
import { seedDemo, type DemoSeedResult } from './demo.js';
import { loadIntentDefinitions, upsertIntentDefinitions } from './intents.js';
import { loadKbArticleFiles, seedKbArticles, type KbSeedResult } from './kb.js';
import {
  loadHolidayFiles,
  loadSlaPolicyFiles,
  seedCalendars,
  seedSlaPolicies,
  type ReferenceSeedResult,
} from './reference.js';

export interface SeedOptions {
  /** `NODE_ENV` of the caller. The library never reads the environment; the CLI passes it. */
  readonly nodeEnv?: string | undefined;
  /** Required to run when `nodeEnv` is `production`. The seed is dev/demo data only. */
  readonly allowProduction?: boolean;
  /** Directory with `intents/`, `calendars/` and `sla/`. Default: `examples/` of this repository. */
  readonly examplesDir?: string;
  /** What "now" is for the demo tickets (tests pass a fixed moment). */
  readonly now?: Date;
  /** Prefix of ticket keys written into merge events. Default `OPS`. */
  readonly ticketKeyPrefix?: string;
  readonly log?: (message: string) => void;
}

export interface SeedResult extends ReferenceSeedResult {
  readonly intents: { readonly inserted: readonly string[]; readonly existing: readonly string[] };
  readonly demo: DemoSeedResult;
  /** Example knowledge base articles from `examples/kb`; they become searchable once a worker indexes them. */
  readonly kb: KbSeedResult;
}

/** Refuses to seed a production database unless the caller said so explicitly. */
export function assertSeedAllowed(options: Pick<SeedOptions, 'nodeEnv' | 'allowProduction'>): void {
  if (options.nodeEnv === 'production' && options.allowProduction !== true) {
    throw new SeedError(
      'refusing to seed: NODE_ENV=production. The seed loads demo organizations, people, tickets and ' +
        'example holidays marked [VERIFY]. A production instance starts empty. If you really mean it ' +
        '(a staging copy that runs with NODE_ENV=production), pass --allow-production.',
    );
  }
}

/**
 * The development seed (T-008): starter intents, the business calendars with the example Thai
 * holidays, the tier SLA policies, and a fictional demo organization set with about thirty tickets.
 * Idempotent and additive: running it twice creates nothing the second time, and it never
 * overwrites a row that already exists. One transaction, so a failure leaves the database as it was.
 * Reads files under `examplesDir`; writes only to the database.
 */
export async function runSeed(database: Database, options: SeedOptions = {}): Promise<SeedResult> {
  assertSeedAllowed(options);
  const examples = options.examplesDir ?? DEFAULT_EXAMPLES_DIR;
  const log = options.log ?? (() => undefined);

  // Read and check every file before the first write: a typo in an example file fails fast.
  const [intentDefinitions, holidayFiles, policyFiles, kbArticles] = await Promise.all([
    loadIntentDefinitions(join(examples, 'intents')),
    loadHolidayFiles(join(examples, 'calendars')),
    loadSlaPolicyFiles(join(examples, 'sla')),
    loadKbArticleFiles(join(examples, 'kb')),
  ]);

  const result = await database.db.transaction(async (tx) => {
    const calendars = await seedCalendars(tx, holidayFiles);
    const policies = await seedSlaPolicies(tx, policyFiles);
    const intents = await upsertIntentDefinitions(tx, intentDefinitions);
    const demo = await seedDemo(tx, {
      now: options.now ?? new Date(),
      ticketKeyPrefix: options.ticketKeyPrefix ?? DEFAULT_TICKET_KEY_PREFIX,
    });
    const kb = await seedKbArticles(tx, kbArticles);
    return { calendars, policies, intents, demo, kb };
  });
  log(
    `calendars +${String(result.calendars.created.length)}, SLA policies +${String(result.policies.created.length)}, ` +
      `intents +${String(result.intents.inserted.length)}, tickets +${String(result.demo.tickets)}, ` +
      `organizations +${String(result.demo.organizations)}, users +${String(result.demo.users)}, ` +
      `knowledge base articles +${String(result.kb.created.length)}`,
  );
  return result;
}

export { DEFAULT_EXAMPLES_DIR, SeedError } from './common.js';
export { seedDemo, type DemoSeedResult } from './demo.js';
export {
  loadKbArticleFiles,
  parseKbArticleFile,
  seedKbArticles,
  type KbSeedArticle,
  type KbSeedResult,
} from './kb.js';
export {
  CALENDAR_24X7,
  loadHolidayFiles,
  loadSlaPolicyFiles,
  seedCalendars,
  seedSlaPolicies,
  type ReferenceSeedResult,
} from './reference.js';
