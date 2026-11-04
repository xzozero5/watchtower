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
import { seedShiftDefinitions, type ShiftSeedResult } from './shifts.js';

export interface SeedOptions {
  /** `NODE_ENV` of the caller. The library never reads the environment; the CLI passes it. */
  readonly nodeEnv?: string | undefined;
  /**
   * Required to run when `nodeEnv` is `production`. In production the seed loads reference data
   * only (calendars, SLA policies, intents, shifts): no organization, user, ticket, audit row or
   * example article is created (T-121c).
   */
  readonly allowProduction?: boolean;
  /**
   * Load reference data only. Defaults to true when `nodeEnv` is `production` and false otherwise;
   * pass it to get the production behaviour in a development database.
   */
  readonly referenceOnly?: boolean;
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
  readonly shifts: ShiftSeedResult;
  readonly demo: DemoSeedResult;
  /** Example knowledge base articles from `examples/kb`; they become searchable once a worker indexes them. */
  readonly kb: KbSeedResult;
}

const NO_DEMO: DemoSeedResult = {
  users: 0,
  organizations: 0,
  contacts: 0,
  queues: 0,
  tickets: 0,
  messages: 0,
  events: 0,
  audits: 0,
  merges: 0,
};

/** True when the seed must load reference data only: asked for, or running with NODE_ENV=production. */
export function isReferenceOnly(options: Pick<SeedOptions, 'nodeEnv' | 'referenceOnly'>): boolean {
  return options.referenceOnly ?? options.nodeEnv === 'production';
}

/** Refuses to seed a production database unless the caller said so explicitly. */
export function assertSeedAllowed(options: Pick<SeedOptions, 'nodeEnv' | 'allowProduction'>): void {
  if (options.nodeEnv === 'production' && options.allowProduction !== true) {
    throw new SeedError(
      'refusing to seed: NODE_ENV=production. The seed loads demo organizations, people, tickets and ' +
        'example holidays marked [VERIFY]. A production instance starts empty. If you really mean it ' +
        '(a staging copy that runs with NODE_ENV=production), pass --allow-production: it then loads ' +
        'reference data only (calendars, SLA policies, intents, shifts), never demo people or tickets.',
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
  const referenceOnly = isReferenceOnly(options);
  const examples = options.examplesDir ?? DEFAULT_EXAMPLES_DIR;
  const log = options.log ?? (() => undefined);

  // Read and check every file before the first write: a typo in an example file fails fast.
  const [intentDefinitions, holidayFiles, policyFiles, kbArticles] = await Promise.all([
    loadIntentDefinitions(join(examples, 'intents')),
    loadHolidayFiles(join(examples, 'calendars')),
    loadSlaPolicyFiles(join(examples, 'sla')),
    referenceOnly ? Promise.resolve([]) : loadKbArticleFiles(join(examples, 'kb')),
  ]);

  const result = await database.db.transaction(async (tx) => {
    const calendars = await seedCalendars(tx, holidayFiles);
    const policies = await seedSlaPolicies(tx, policyFiles);
    const intents = await upsertIntentDefinitions(tx, intentDefinitions);
    const shifts = await seedShiftDefinitions(tx);
    // Fictional organizations, people, tickets, audit rows and example articles are demo data: never
    // in a reference-only run (production).
    const demo = referenceOnly
      ? NO_DEMO
      : await seedDemo(tx, {
          now: options.now ?? new Date(),
          ticketKeyPrefix: options.ticketKeyPrefix ?? DEFAULT_TICKET_KEY_PREFIX,
          log,
        });
    const kb = referenceOnly ? { created: [], existing: [] } : await seedKbArticles(tx, kbArticles);
    return { calendars, policies, intents, shifts, demo, kb };
  });
  if (referenceOnly) log('reference data only: no demo organizations, users, tickets or articles');
  log(
    `calendars +${String(result.calendars.created.length)}, SLA policies +${String(result.policies.created.length)}, ` +
      `intents +${String(result.intents.inserted.length)}, shifts +${String(result.shifts.created.length)}, tickets +${String(result.demo.tickets)}, ` +
      `organizations +${String(result.demo.organizations)}, users +${String(result.demo.users)}, ` +
      `knowledge base articles +${String(result.kb.created.length)}`,
  );
  return result;
}

export { DEFAULT_EXAMPLES_DIR, SeedError } from './common.js';
export { seedYear, type YearSeedOptions, type YearSeedResult } from './year/index.js';
export { seedDemo, type DemoSeedResult } from './demo.js';
export { seedShiftDefinitions, type ShiftSeedResult } from './shifts.js';
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
