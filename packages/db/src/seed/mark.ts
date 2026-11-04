import { sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { DEMO_ORGS } from './demo-data.js';
import { SeedError } from './common.js';
import { DEFAULT_YEAR_SEED } from './year/plan.js';
import { Rng } from './year/prng.js';
import { buildWorld } from './year/world.js';

/**
 * `pnpm db:mark-seed` (ADR-025 section 10): puts the seed data of an instance that was seeded before
 * migration 0096 into a `seed_batch`, so the promotion reports stop counting it. It marks:
 *   - organizations whose name is in the cast of the default seed or of the one-year scenario, and
 *   - tickets of those organizations that have a message with a seed provider id (`seed-...`, or the
 *     `<y12.3@mail.example.com>` ids of the year scenario).
 * A ticket of a cast organization without such a message is not marked and is counted separately, so a
 * person can look at it. Nothing else is touched.
 *
 * The dry run only counts. The real run needs the schema owner's connection (the batch columns are
 * written by the owner only), is one transaction, and on a real instance is a decision for the owner
 * after a backup ([ASK-HUMAN] in AGENTS.md).
 */
export interface MarkSeedOptions {
  readonly dryRun: boolean;
}

export interface MarkSeedKindReport {
  readonly kind: 'demo' | 'year';
  /** Organizations of the cast that exist and carry no batch yet. */
  readonly organizations: number;
  /** Tickets that would be (or were) marked. */
  readonly tickets: number;
  /** Tickets of those organizations that look like real work: left alone. */
  readonly leftAlone: number;
  readonly batchId: string | null;
}

export interface MarkSeedReport {
  readonly applied: boolean;
  readonly kinds: readonly MarkSeedKindReport[];
}

/** The `<y..>` provider ids of the one-year scenario's mail (seed/year/tickets.ts). */
const YEAR_MAIL_ID = String.raw`^<y[0-9]+\.[0-9]+@mail\.example\.com>$`;

export function castOrganizationNames(): { demo: string[]; year: string[] } {
  const world = buildWorld(new Rng(DEFAULT_YEAR_SEED), new Date());
  return {
    demo: DEMO_ORGS.map((org) => org.name.toLowerCase()),
    year: world.orgs.map((org) => org.name.toLowerCase()),
  };
}

interface Counts extends Record<string, unknown> {
  organizations: string;
  tickets: string;
  left_alone: string;
}

type Executor = Pick<Database['db'], 'execute'>;

/** `'a', 'b'` as bound parameters: a JS array cannot be bound as one text[] through drizzle's sql tag. */
const nameList = (names: readonly string[]) =>
  sql.join(
    names.map((name) => sql`${name}`),
    sql`, `,
  );

async function count(executor: Executor, names: readonly string[]): Promise<Counts> {
  const result = await executor.execute<Counts>(sql`
    WITH orgs AS (
      SELECT id FROM organization WHERE seed_batch_id IS NULL AND lower(name) IN (${nameList(names)})
    ), seeded AS (
      SELECT t.id
        FROM ticket t
       WHERE t.seed_batch_id IS NULL AND t.org_id IN (SELECT id FROM orgs)
         AND EXISTS (SELECT 1 FROM message m WHERE m.ticket_id = t.id
                      AND (m.external_id LIKE 'seed-%' OR m.external_id ~ ${YEAR_MAIL_ID}))
    )
    SELECT (SELECT count(*) FROM orgs)::text AS organizations,
           (SELECT count(*) FROM seeded)::text AS tickets,
           (SELECT count(*) FROM ticket t
             WHERE t.seed_batch_id IS NULL AND t.org_id IN (SELECT id FROM orgs)
               AND t.id NOT IN (SELECT id FROM seeded))::text AS left_alone
  `);
  const row = result.rows[0];
  if (row === undefined) throw new SeedError('mark-seed: the count returned no row');
  return row;
}

export async function markSeed(
  database: Database,
  options: MarkSeedOptions,
): Promise<MarkSeedReport> {
  const cast = castOrganizationNames();
  const kinds: MarkSeedKindReport[] = [];
  if (options.dryRun) {
    for (const kind of ['demo', 'year'] as const) {
      const counts = await count(database.db, cast[kind]);
      kinds.push({
        kind,
        organizations: Number(counts.organizations),
        tickets: Number(counts.tickets),
        leftAlone: Number(counts.left_alone),
        batchId: null,
      });
    }
    return { applied: false, kinds };
  }
  await database.db.transaction(async (tx) => {
    for (const kind of ['demo', 'year'] as const) {
      const names = cast[kind];
      const counts = await count(tx, names);
      let batchId: string | null = null;
      if (Number(counts.organizations) > 0) {
        const batch = await tx.execute<{ id: string }>(
          sql`INSERT INTO seed_batch (kind, note) VALUES (${kind}, 'marked afterwards by db:mark-seed') RETURNING id`,
        );
        batchId = batch.rows[0]?.id ?? null;
        if (batchId === null) throw new SeedError('mark-seed: the batch was not created');
        // The organizations first: a ticket may join a batch only when its organization is in it (a trigger).
        await tx.execute(sql`
          UPDATE organization SET seed_batch_id = ${batchId}::uuid
           WHERE seed_batch_id IS NULL AND lower(name) IN (${nameList(names)})
        `);
        await tx.execute(sql`
          UPDATE ticket t SET seed_batch_id = ${batchId}::uuid
           WHERE t.seed_batch_id IS NULL
             AND t.org_id IN (SELECT id FROM organization WHERE seed_batch_id = ${batchId}::uuid)
             AND EXISTS (SELECT 1 FROM message m WHERE m.ticket_id = t.id
                          AND (m.external_id LIKE 'seed-%' OR m.external_id ~ ${YEAR_MAIL_ID}))
        `);
      }
      kinds.push({
        kind,
        organizations: Number(counts.organizations),
        tickets: Number(counts.tickets),
        leftAlone: Number(counts.left_alone),
        batchId,
      });
    }
  });
  return { applied: true, kinds };
}
