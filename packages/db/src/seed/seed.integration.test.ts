import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  computeSlaDueDates,
  holidaySchema,
  slaTargetsSchema,
  weeklyHoursSchema,
  type SlaPause,
} from '@watchtower/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type Database } from '../client.js';
import { createTestDatabase, type TestDatabase } from '../testing.js';
import { DEFAULT_EXAMPLES_DIR, SeedError } from './common.js';
import { DEMO_ORGS, DEMO_QUEUES, DEMO_STAFF } from './demo-data.js';
import { runSeed, type SeedResult } from './index.js';
import { loadHolidayFiles } from './reference.js';

// `pnpm db:seed` against the real Postgres from docker compose, in throwaway databases.
const adminUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower';

let testDb: TestDatabase;
let first: SeedResult;
let second: SeedResult;
const owner = (): Pool => testDb.owner.pool;

async function count(pool: Pool, table: string, where = 'true'): Promise<number> {
  const result = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
  );
  return result.rows[0]?.n ?? 0;
}

const TABLES = [
  'users',
  'organization',
  'contact',
  'team_queue',
  'team_queue_member',
  'business_calendar',
  'sla_policy',
  'intent',
  'ticket',
  'message',
  'ticket_event',
  'audit_log',
  'kb_article',
  'kb_article_version',
  'outbox',
];

async function snapshot(pool: Pool): Promise<Record<string, number>> {
  const entries = await Promise.all(
    TABLES.map(async (table) => [table, await count(pool, table)] as const),
  );
  return Object.fromEntries(entries);
}

let afterFirst: Record<string, number>;
let afterSecond: Record<string, number>;

beforeAll(async () => {
  testDb = await createTestDatabase(adminUrl);
  first = await runSeed(testDb.owner, { nodeEnv: 'test' });
  afterFirst = await snapshot(owner());
  second = await runSeed(testDb.owner, { nodeEnv: 'test' });
  afterSecond = await snapshot(owner());
});

afterAll(async () => {
  await testDb.cleanup();
});

describe('the first run', () => {
  it('creates the reference data: two calendars, three SLA policies, every starter intent', async () => {
    expect(first.calendars.created.toSorted()).toEqual(['24x7', 'Bangkok office hours']);
    expect(first.policies.created.toSorted()).toEqual(['Gold', 'Silver', 'Standard']);
    expect(first.intents.inserted).toHaveLength(11);
    expect(await count(owner(), 'intent')).toBe(11);
    // N3: nothing starts above draft-for-approval.
    expect(await count(owner(), 'intent', 'autonomy_stage <> 2')).toBe(0);
  });

  it('creates the example knowledge base articles as published, with one indexing job each', async () => {
    expect(first.kb.created.length).toBeGreaterThanOrEqual(5);
    expect(await count(owner(), 'kb_article', "status = 'published'")).toBe(
      first.kb.created.length,
    );
    expect(await count(owner(), 'kb_article', 'published_version_id = current_version_id')).toBe(
      first.kb.created.length,
    );
    expect(await count(owner(), 'outbox', "queue = 'kb' AND job_name = 'embed_article'")).toBe(
      first.kb.created.length,
    );
    // Nothing is indexed by the seed itself: the worker does that, so there are no chunks yet.
    expect(await count(owner(), 'kb_chunk')).toBe(0);
    expect(second.kb).toEqual({ created: [], existing: first.kb.created });
  });

  it('loads the example Thai holidays into the default business calendar', async () => {
    const [file] = await loadHolidayFiles(join(DEFAULT_EXAMPLES_DIR, 'calendars'));
    const row = await owner().query<{
      timezone: string;
      is_default: boolean;
      hours: Record<string, { start: string; end: string }[]>;
      holidays: { date: string; name: string; checked?: boolean }[];
    }>(
      `SELECT timezone, is_default, hours, holidays FROM business_calendar WHERE name = 'Bangkok office hours'`,
    );
    expect(row.rows[0]?.timezone).toBe('Asia/Bangkok');
    expect(row.rows[0]?.is_default).toBe(true);
    expect(row.rows[0]?.holidays).toHaveLength(file?.holidays.length ?? -1);
    // Example data is [VERIFY]: nobody has compared it with the official announcement (T-127).
    expect(row.rows[0]?.holidays.length).toBeGreaterThan(0);
    for (const holiday of row.rows[0]?.holidays ?? []) {
      expect(holiday).toMatchObject({ checked: false, checkedAt: null, checkedBy: null });
    }
    expect(row.rows[0]?.hours.mon).toEqual([{ start: '09:00', end: '18:00' }]);
    expect(row.rows[0]?.hours.sat).toEqual([]);
    const wide = await owner().query<{ is_default: boolean; hours: Record<string, unknown[]> }>(
      `SELECT is_default, hours FROM business_calendar WHERE name = '24x7'`,
    );
    expect(wide.rows[0]?.is_default).toBe(false);
    expect(Object.values(wide.rows[0]?.hours ?? {}).every((day) => day.length === 1)).toBe(true);
  });

  it('creates the tier policies of PO decision 8 and attaches the tiers', async () => {
    const policies = await owner().query<{
      name: string;
      tier: string;
      targets: Record<string, unknown>;
    }>('SELECT name, tier, targets FROM sla_policy ORDER BY name');
    expect(policies.rows.map((row) => row.tier)).toEqual(['gold', 'silver', 'standard']);
    expect(policies.rows[0]?.targets.P1).toEqual({
      first_response_min: 15,
      resolution_min: 240,
      calendar: '24x7',
    });
  });

  it('creates three organizations (one per tier), their contacts, staff and queues', async () => {
    expect(first.demo).toMatchObject({ organizations: 3, queues: 3, tickets: 30, merges: 3 });
    const orgs = await owner().query<{
      name: string;
      tier: string;
      domains: string[];
      primary_contact_id: string | null;
    }>('SELECT name, tier, domains, primary_contact_id FROM organization ORDER BY name');
    expect(orgs.rows.map((row) => row.tier).toSorted()).toEqual(['gold', 'silver', 'standard']);
    expect(orgs.rows.every((row) => row.primary_contact_id !== null)).toBe(true);
    for (const row of orgs.rows) expect(row.domains[0]).toMatch(/\.example\.(com|org|net)$/);

    const perOrg = await owner().query<{ n: number }>(
      'SELECT count(*)::int AS n FROM contact GROUP BY org_id',
    );
    expect(perOrg.rows.map((row) => row.n).toSorted()).toEqual(
      DEMO_ORGS.map((org) => org.contacts.length).toSorted(),
    );
    for (const role of ['head', 'lead', 'agent']) {
      expect(await count(owner(), 'users', `role = '${role}'`)).toBe(
        DEMO_STAFF.filter((person) => person.role === role).length,
      );
    }
    expect(await count(owner(), 'users', `role = 'client' AND org_id IS NOT NULL`)).toBe(3);
    expect(await count(owner(), 'team_queue')).toBe(DEMO_QUEUES.length);
    expect(await count(owner(), 'team_queue', 'is_default')).toBe(1);
    // Every email in the data is on a reserved example domain (N1).
    expect(
      await count(owner(), 'users', `email !~ '@([a-z0-9-]+\\.)*example\\.(com|org|net)$'`),
    ).toBe(0);
    expect(
      await count(
        owner(),
        'contact',
        `NOT (emails[1] ~ '@([a-z0-9-]+\\.)*example\\.(com|org|net)$')`,
      ),
    ).toBe(0);
  });

  it('creates 30 tickets in every status, with merged, paused, resolved and closed among them', async () => {
    const byStatus = await owner().query<{ status: string; n: number }>(
      'SELECT status, count(*)::int AS n FROM ticket GROUP BY status ORDER BY status',
    );
    expect(Object.fromEntries(byStatus.rows.map((row) => [row.status, row.n]))).toEqual({
      closed: 3,
      merged: 3,
      new: 4,
      open: 6,
      resolved: 4,
      triage: 3,
      waiting_on_customer: 4,
      waiting_on_dev: 3,
    });
    expect(afterFirst.ticket).toBe(30);
    // The SLA clock is stopped for exactly the tickets that wait on the customer.
    expect(await count(owner(), 'ticket', `sla_paused_at IS NOT NULL`)).toBe(4);
    expect(
      await count(
        owner(),
        'ticket',
        `sla_paused_at IS NOT NULL AND status <> 'waiting_on_customer'`,
      ),
    ).toBe(0);
    expect(await count(owner(), 'ticket', 'reopen_count > 0')).toBe(1);
    expect(await count(owner(), 'ticket', `autonomy_stage_at_creation <> 2 OR ai_handled`)).toBe(0);
  });

  it('keeps merged tickets one level deep, in the same organization, with events on both sides', async () => {
    const merged = await owner().query<{ id: string; parent_ticket_id: string; org_id: string }>(
      `SELECT id, parent_ticket_id, org_id FROM ticket WHERE status = 'merged'`,
    );
    expect(merged.rows).toHaveLength(3);
    for (const row of merged.rows) {
      const parent = await owner().query<{
        org_id: string;
        parent_ticket_id: string | null;
        status: string;
      }>('SELECT org_id, parent_ticket_id, status FROM ticket WHERE id = $1', [
        row.parent_ticket_id,
      ]);
      expect(parent.rows[0]).toMatchObject({ org_id: row.org_id, parent_ticket_id: null });
      expect(parent.rows[0]?.status).not.toBe('merged');
      expect(
        await count(owner(), 'ticket_event', `ticket_id = '${row.id}' AND type = 'ticket.merged'`),
      ).toBe(1);
      expect(
        await count(
          owner(),
          'ticket_event',
          `ticket_id = '${row.parent_ticket_id}' AND type = 'ticket.merge_received'`,
        ),
      ).toBeGreaterThanOrEqual(1);
      expect(
        await count(owner(), 'audit_log', `action = 'ticket.merge' AND target_id = '${row.id}'`),
      ).toBe(1);
    }
    const key = await owner().query<{ payload: { intoKey: string } }>(
      `SELECT payload FROM ticket_event WHERE type = 'ticket.merged' LIMIT 1`,
    );
    expect(key.rows[0]?.payload.intoKey).toMatch(/^OPS-\d+$/);
  });

  it('writes messages in Thai and English, public replies and internal notes', async () => {
    expect(
      await count(owner(), 'message', `direction = 'internal' AND visibility = 'internal'`),
    ).toBeGreaterThanOrEqual(5);
    expect(
      await count(
        owner(),
        'message',
        `direction = 'outbound' AND visibility = 'public' AND delivery_status = 'delivered'`,
      ),
    ).toBeGreaterThanOrEqual(10);
    expect(await count(owner(), 'message', `body_text ~ '[ก-๙]'`)).toBeGreaterThanOrEqual(8);
    expect(await count(owner(), 'message', `body_text !~ '[ก-๙]'`)).toBeGreaterThanOrEqual(8);
    expect(await count(owner(), 'message', `external_id LIKE 'seed-demo-%'`)).toBe(30);
  });

  it('keeps events and audit rows consistent with each ticket', async () => {
    // One creation event and one creation audit row per ticket.
    expect(await count(owner(), 'ticket_event', `type = 'ticket.created'`)).toBe(30);
    expect(await count(owner(), 'audit_log', `action = 'ticket.create'`)).toBe(30);
    // Every status change has both an event and an audit row.
    expect(await count(owner(), 'ticket_event', `type = 'ticket.status_changed'`)).toBe(
      await count(owner(), 'audit_log', `action = 'ticket.status_change'`),
    );
    expect(await count(owner(), 'ticket_event', `type = 'ticket.assigned'`)).toBe(
      await count(owner(), 'audit_log', `action = 'ticket.assign'`),
    );
    // Audit rows hold ids and statuses, not what people wrote.
    expect(
      await count(
        owner(),
        'audit_log',
        // Phrases from seeded subjects/bodies; bare digits like 502 also occur in random UUIDs.
        `after::text ILIKE '%returns 502 intermittently%' OR after::text ILIKE '%open the dashboard%' OR before::text ILIKE '%open the dashboard%'`,
      ),
    ).toBe(0);
    expect(await count(owner(), 'audit_log', `metadata->>'seed' = 'true'`)).toBeGreaterThan(100);
  });

  it('dates nothing in the future and nothing in a default partition', async () => {
    expect(await count(owner(), 'ticket', 'created_at > now() OR updated_at > now()')).toBe(0);
    expect(await count(owner(), 'ticket_event', 'created_at > now()')).toBe(0);
    expect(await count(owner(), 'audit_log', 'created_at > now()')).toBe(0);
    expect(await count(owner(), 'ticket_event_default')).toBe(0);
    expect(await count(owner(), 'audit_log_default')).toBe(0);
  });

  it('numbers tickets without gaps or repeats', async () => {
    const numbers = await owner().query<{ number: string }>(
      'SELECT number::text FROM ticket ORDER BY number',
    );
    const values = numbers.rows.map((row) => Number(row.number));
    expect(new Set(values).size).toBe(30);
    expect(values[0]).toBe(1001);
    expect(values.at(-1)).toBe(1030);
  });
});

describe('SLA due dates of the seeded tickets', () => {
  it('equal computeSlaDueDates for every ticket, counting the pauses that ended', async () => {
    const tickets = await owner().query<{
      id: string;
      priority: string;
      created_at: Date;
      first_response_due_at: Date | null;
      resolution_due_at: Date | null;
      targets: unknown;
      hours: unknown;
      holidays: unknown;
      timezone: string;
      key: string;
    }>(
      `SELECT t.id, t.priority, t.created_at, t.first_response_due_at, t.resolution_due_at,
              p.targets, c.hours, c.holidays, c.timezone, m.external_id AS key
       FROM ticket t
       JOIN organization o ON o.id = t.org_id
       JOIN sla_policy p ON p.id = t.sla_policy_id AND p.tier = o.tier
       JOIN business_calendar c ON c.id = p.business_calendar_id
       JOIN message m ON m.ticket_id = t.id AND m.external_id LIKE 'seed-demo-%'`,
    );
    expect(tickets.rows).toHaveLength(30);
    let withPause = 0;
    for (const row of tickets.rows) {
      const events = await owner().query<{ payload: { pausedAt: string; resumedAt: string } }>(
        `SELECT payload FROM ticket_event WHERE ticket_id = $1 AND type = 'sla.resumed' ORDER BY created_at, id`,
        [row.id],
      );
      const pauses: SlaPause[] = events.rows.map((event) => ({
        pausedAt: new Date(event.payload.pausedAt),
        resumedAt: new Date(event.payload.resumedAt),
      }));
      if (pauses.length > 0) withPause += 1;
      const expected = computeSlaDueDates({
        startedAt: row.created_at,
        priority: row.priority as 'P1' | 'P2' | 'P3' | 'P4',
        targets: slaTargetsSchema.parse(row.targets),
        calendar: {
          timezone: row.timezone,
          hours: weeklyHoursSchema.parse(row.hours),
          holidays: holidaySchema
            .array()
            .parse(row.holidays)
            .map((holiday) => holiday.date),
        },
        pauses,
      });
      expect(row.first_response_due_at?.getTime(), `${row.key} first response`).toBe(
        expected.firstResponseDueAt?.getTime(),
      );
      expect(row.resolution_due_at?.getTime(), `${row.key} resolution`).toBe(
        expected.resolutionDueAt?.getTime(),
      );
      expect(row.first_response_due_at, row.key).not.toBeNull();
    }
    // At least one ticket really went through a pause and a resume.
    expect(withPause).toBeGreaterThanOrEqual(1);
  });

  it('gives a Gold P1 ticket a first response due 15 minutes after creation (24x7)', async () => {
    const row = await owner().query<{ minutes: number }>(
      `SELECT extract(epoch FROM (t.first_response_due_at - t.created_at)) / 60 AS minutes
       FROM ticket t JOIN message m ON m.ticket_id = t.id WHERE m.external_id = 'seed-demo-04'`,
    );
    expect(Number(row.rows[0]?.minutes)).toBe(15);
  });
});

describe('the second run', () => {
  it('creates nothing and changes no row count', () => {
    expect(afterSecond).toEqual(afterFirst);
    expect(second.calendars.created).toEqual([]);
    expect(second.policies.created).toEqual([]);
    expect(second.intents.inserted).toEqual([]);
    expect(second.demo).toEqual({
      users: 0,
      organizations: 0,
      contacts: 0,
      queues: 0,
      tickets: 0,
      messages: 0,
      events: 0,
      audits: 0,
      merges: 0,
    });
  });

  it('leaves what someone edited since alone', async () => {
    await owner().query(
      `UPDATE business_calendar SET holidays = '[]'::jsonb WHERE name = 'Bangkok office hours'`,
    );
    await owner().query(
      `UPDATE ticket SET subject = 'Edited by a person' WHERE id = (SELECT id FROM ticket ORDER BY number LIMIT 1)`,
    );
    await owner().query(
      `UPDATE organization SET notes = 'Edited note' WHERE name = 'Acme Logistics'`,
    );
    await runSeed(testDb.owner, { nodeEnv: 'test' });
    expect(
      await count(
        owner(),
        'business_calendar',
        `name = 'Bangkok office hours' AND holidays = '[]'::jsonb`,
      ),
    ).toBe(1);
    expect(await count(owner(), 'ticket', `subject = 'Edited by a person'`)).toBe(1);
    expect(await count(owner(), 'organization', `notes = 'Edited note'`)).toBe(1);
    expect(await snapshot(owner())).toEqual(afterFirst);
  });

  it('adds only the ticket that is missing when one was removed from the data', async () => {
    // A seed ticket's external id is the only link to the script, so removing the message row is
    // impossible for the app role; as owner we simulate "this ticket was never seeded".
    const target = await owner().query<{ ticket_id: string }>(
      `SELECT ticket_id FROM message WHERE external_id = 'seed-demo-05'`,
    );
    expect(target.rowCount).toBe(1);
    await owner().query(
      `UPDATE message SET external_id = 'renamed-by-hand' WHERE external_id = 'seed-demo-05'`,
    );
    const again = await runSeed(testDb.owner, { nodeEnv: 'test' });
    expect(again.demo.tickets).toBe(1);
    expect(await count(owner(), 'ticket')).toBe(31);
  });
});

describe('guards and configuration', () => {
  it('refuses NODE_ENV=production without the flag, before writing anything', async () => {
    const empty = await createTestDatabase(adminUrl);
    try {
      await expect(runSeed(empty.owner, { nodeEnv: 'production' })).rejects.toThrow(
        /refusing to seed/,
      );
      expect(await count(empty.owner.pool, 'ticket')).toBe(0);
      expect(await count(empty.owner.pool, 'organization')).toBe(0);
      expect(await count(empty.owner.pool, 'business_calendar')).toBe(0);
      expect(await count(empty.owner.pool, 'audit_log')).toBe(0);
      // With the explicit flag it runs.
      const result = await runSeed(empty.owner, { nodeEnv: 'production', allowProduction: true });
      // Production loads reference data only (T-121c): no demo people, tickets, audit rows or articles.
      expect(result.demo.tickets).toBe(0);
      expect(result.kb.created).toEqual([]);
      expect(result.calendars.created.length).toBeGreaterThan(0);
      expect(result.policies.created.length).toBeGreaterThan(0);
      expect(result.intents.inserted.length).toBeGreaterThan(0);
      expect(result.shifts.created.length).toBeGreaterThan(0);
      for (const table of [
        'ticket',
        'message',
        'organization',
        'contact',
        'users',
        'audit_log',
        'ticket_event',
        'kb_article',
      ]) {
        expect(await count(empty.owner.pool, table), table).toBe(0);
      }
      expect(await count(empty.owner.pool, 'business_calendar')).toBeGreaterThan(0);
    } finally {
      await empty.cleanup();
    }
  });

  it('reads the examples from a directory of your choosing, and a bad file changes nothing', async () => {
    const copy = await mkdtemp(join(tmpdir(), 'wt-examples-'));
    const empty = await createTestDatabase(adminUrl);
    try {
      await cp(DEFAULT_EXAMPLES_DIR, copy, { recursive: true });
      const missing = join(copy, 'nowhere');
      await expect(runSeed(empty.owner, { examplesDir: missing })).rejects.toThrow();
      expect(await count(empty.owner.pool, 'intent')).toBe(0);

      const ok = await runSeed(empty.owner, { examplesDir: copy });
      expect(ok.calendars.created).toContain('Bangkok office hours');
      expect(await count(empty.owner.pool, 'ticket')).toBe(30);
    } finally {
      await empty.cleanup();
      await rm(copy, { recursive: true, force: true });
    }
  });

  it('stops before the first write when an example file is invalid', async () => {
    const copy = await mkdtemp(join(tmpdir(), 'wt-examples-'));
    const empty = await createTestDatabase(adminUrl);
    try {
      await cp(DEFAULT_EXAMPLES_DIR, copy, { recursive: true });
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(copy, 'calendars', 'th-public-holidays-2026-2027.json'), '{"_meta":{}}');
      await expect(runSeed(empty.owner, { examplesDir: copy })).rejects.toThrow(SeedError);
      expect(await count(empty.owner.pool, 'intent')).toBe(0);
      expect(await count(empty.owner.pool, 'sla_policy')).toBe(0);
    } finally {
      await empty.cleanup();
      await rm(copy, { recursive: true, force: true });
    }
  });

  it('also works as the restricted application role (the role compose gives DATABASE_URL)', async () => {
    const fresh = await createTestDatabase(adminUrl);
    let app: Database | undefined;
    try {
      app = createDatabase({ url: fresh.appUrl, max: 2 });
      const result = await runSeed(app, { nodeEnv: 'test' });
      expect(result.demo.tickets).toBe(30);
      expect(await count(fresh.owner.pool, 'ticket')).toBe(30);
    } finally {
      await app?.close();
      await fresh.cleanup();
    }
  });

  it('honours the ticket key prefix in merge events', async () => {
    const fresh = await createTestDatabase(adminUrl);
    try {
      await runSeed(fresh.owner, { nodeEnv: 'test', ticketKeyPrefix: 'SUP' });
      const row = await fresh.owner.pool.query<{ payload: { intoKey: string } }>(
        `SELECT payload FROM ticket_event WHERE type = 'ticket.merged' LIMIT 1`,
      );
      expect(row.rows[0]?.payload.intoKey).toMatch(/^SUP-\d+$/);
    } finally {
      await fresh.cleanup();
    }
  });
});
