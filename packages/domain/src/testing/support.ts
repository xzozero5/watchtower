import { randomBytes, randomUUID } from 'node:crypto';

import { createDatabase, schema, type Database } from '@watchtower/db';
import { createTestDatabase, type TestDatabase } from '@watchtower/db/testing';
import type { SlaTargets } from '@watchtower/shared';
import { eq } from 'drizzle-orm';

import {
  createDomain,
  type Actor,
  type DbTransaction,
  type Domain,
  type DomainContext,
  type DomainOptions,
  type TicketNotifier,
} from '../index.js';

const ADMIN_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

export const STAFF: Actor = { type: 'user', id: null };

export interface DomainTestEnv {
  readonly db: TestDatabase;
  /** The restricted application role, the one the api and worker log in as. */
  readonly database: Database;
  readonly domain: Domain;
  /** Runs `work` in one transaction that commits when it returns and rolls back when it throws. */
  tx<T>(work: (tx: DbTransaction) => Promise<T>): Promise<T>;
  ctx(actor?: Actor, overrides?: Partial<DomainContext>): DomainContext;
  close(): Promise<void>;
}

/** A throwaway migrated Postgres database (from compose) and a domain that talks to it. */
export async function startDomainTest(
  options: Partial<DomainOptions> = {},
): Promise<DomainTestEnv> {
  const db = await createTestDatabase(ADMIN_URL);
  const database = createDatabase({ url: db.appUrl, max: 6, applicationName: 'wt-domain-test' });
  const domain = createDomain({
    ticketKeyPrefix: 'OPS',
    sealKey: randomBytes(32),
    ...options,
  });
  return {
    db,
    database,
    domain,
    tx: (work) => database.db.transaction(work),
    ctx: (actor = STAFF, overrides = {}) => ({
      ...domain.context({
        actor,
        auditMeta: { ip: '203.0.113.7', requestId: 'req-test' },
      }),
      ...overrides,
    }),
    async close() {
      await database.close();
      await db.cleanup();
    },
  };
}

/** A notifier that remembers every call, in order. */
export function recordingNotifier(): TicketNotifier & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    closeLinks: (_tx, ticketId) => {
      calls.push(`closeLinks:${ticketId}`);
      return Promise.resolve(1);
    },
    statusChange: (_tx, _ticket, key, from, to) => {
      calls.push(`statusChange:${key}:${from}>${to}`);
      return Promise.resolve();
    },
    merged: (_tx, _source, sourceKey, intoKey) => {
      calls.push(`merged:${sourceKey}>${intoKey}`);
      return Promise.resolve();
    },
    staffReply: (_tx, ticket, key) => {
      calls.push(`staffReply:${key}:${ticket.status}`);
      return Promise.resolve();
    },
  };
}

export async function addStaff(
  env: DomainTestEnv,
  role: 'agent' | 'lead' | 'head' = 'agent',
): Promise<{ id: string; actor: Actor }> {
  const [row] = await env.db.owner.db
    .insert(schema.users)
    .values({ email: `${randomUUID()}@example.test`, name: `Staff ${role}`, role })
    .returning({ id: schema.users.id });
  if (!row) throw new Error('user insert returned no row');
  return { id: row.id, actor: { type: 'user', id: row.id } };
}

export async function addOrg(
  env: DomainTestEnv,
  fields: Partial<typeof schema.organization.$inferInsert> = {},
): Promise<typeof schema.organization.$inferSelect> {
  const [row] = await env.db.owner.db
    .insert(schema.organization)
    .values({ name: `Org ${randomUUID()}`, ...fields })
    .returning();
  if (!row) throw new Error('organization insert returned no row');
  return row;
}

/** Puts a person on shift: an open clock-in session, so round-robin and load balancing can pick them (T-111). */
export async function clockIn(
  env: DomainTestEnv,
  userId: string,
  at: Date = new Date(),
): Promise<void> {
  await env.db.owner.db.insert(schema.shiftSession).values({ userId, clockedInAt: at });
}

export async function addQueue(
  env: DomainTestEnv,
  fields: {
    mode?: 'manual' | 'round_robin' | 'load_balanced' | 'stay_with_last_handler';
    isDefault?: boolean;
    members?: readonly string[];
  } = {},
): Promise<typeof schema.teamQueue.$inferSelect> {
  const [queue] = await env.db.owner.db
    .insert(schema.teamQueue)
    .values({
      name: `Queue ${randomUUID()}`,
      assignmentMode: fields.mode ?? 'manual',
      isDefault: fields.isDefault ?? false,
    })
    .returning();
  if (!queue) throw new Error('queue insert returned no row');
  for (const userId of fields.members ?? []) {
    await env.db.owner.db.insert(schema.teamQueueMember).values({ queueId: queue.id, userId });
  }
  return queue;
}

/** A policy for the `standard` tier on a 24x7 calendar-free fallback: every minute counts when `24x7`. */
export async function addPolicy(
  env: DomainTestEnv,
  targets: SlaTargets,
  tier: 'gold' | 'silver' | 'standard' | null = 'standard',
): Promise<typeof schema.slaPolicy.$inferSelect> {
  const [row] = await env.db.owner.db
    .insert(schema.slaPolicy)
    .values({ name: `Policy ${randomUUID()}`, tier, targets })
    .returning();
  if (!row) throw new Error('policy insert returned no row');
  return row;
}

export async function addIntent(
  env: DomainTestEnv,
  fields: Partial<typeof schema.intent.$inferInsert> = {},
): Promise<typeof schema.intent.$inferSelect> {
  const [row] = await env.db.owner.db
    .insert(schema.intent)
    .values({
      key: `intent_${randomUUID().slice(0, 8).replace(/-/g, '')}`,
      name: 'An intent',
      ...fields,
    })
    .returning();
  if (!row) throw new Error('intent insert returned no row');
  return row;
}

export async function auditRows(env: DomainTestEnv, action?: string) {
  const rows = await env.db.owner.db.select().from(schema.auditLog);
  return action === undefined ? rows : rows.filter((row) => row.action === action);
}

export async function eventTypes(env: DomainTestEnv, ticketId: string): Promise<string[]> {
  const rows = await env.db.owner.db.select().from(schema.ticketEvent);
  // Events of one transaction share a timestamp, so callers compare as a set, not as a sequence.
  return rows.filter((row) => row.ticketId === ticketId).map((row) => row.type);
}

/** Puts a ticket in the `merged` state the way a merge leaves it (the database wants a parent). */
export async function markMerged(env: DomainTestEnv, ticketId: string): Promise<void> {
  const [ticket] = await env.db.owner.db
    .select({ orgId: schema.ticket.orgId })
    .from(schema.ticket)
    .where(eq(schema.ticket.id, ticketId));
  if (!ticket) throw new Error('no such ticket');
  const [parent] = await env.db.owner.db
    .insert(schema.ticket)
    .values({ subject: 'merge target', orgId: ticket.orgId })
    .returning({ id: schema.ticket.id });
  if (!parent) throw new Error('ticket insert returned no row');
  await env.db.owner.db
    .update(schema.ticket)
    .set({ status: 'merged', parentTicketId: parent.id })
    .where(eq(schema.ticket.id, ticketId));
}
