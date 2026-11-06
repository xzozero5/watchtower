import { randomUUID } from 'node:crypto';
import { createDatabase, purgeExpired, schema, type Database } from '@watchtower/db';
import { createTestDatabase, type TestDatabase } from '@watchtower/db/testing';
import { assistantMemoryListSchema, type Permission } from '@watchtower/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { OrganizationsService } from '../orgs/organizations.service.js';
import { resolveContext } from './context-resolver.js';
import {
  AssistantHistoryAuthorization,
  makeAssistantAuthorization,
} from './assistant-context-history.js';
import { AssistantMemoryService } from './assistant-memory.js';

// PG-only tests: the real GET organization reader, read-only scope, audit and memory storage.
// No Redis, external provider, customer sends or unrelated test services required.
let testDb: TestDatabase;
let db: Database;
let auth: AssistantHistoryAuthorization;
let memory: AssistantMemoryService;
let principal: Principal;
let orgId: string;
let conversationId: string;
let sourceId: string;
const ref = () => ({ kind: 'org' as const, ref: orgId });

async function message(body: string, authorization: unknown, who = principal): Promise<string> {
  const [row] = await db.db
    .insert(schema.assistantMessage)
    .values({
      conversationId,
      userId: who.userId,
      role: 'assistant',
      body,
      context: { authorization },
      evidence: [{ kind: 'org', id: orgId, claim: 0 }],
    })
    .returning({ id: schema.assistantMessage.id });
  if (row === undefined) throw new Error('fixture message missing');
  return row.id;
}

beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (url === undefined) throw new Error('TEST_DATABASE_URL required');
  testDb = await createTestDatabase(url);
  db = createDatabase({ url: testDb.appUrl, max: 5 });
  const [user] = await db.db
    .insert(schema.users)
    .values({ email: 'authorization@example.com', name: 'Synthetic', role: 'agent' })
    .returning();
  const [org] = await db.db
    .insert(schema.organization)
    .values({ name: 'Synthetic authorization organization' })
    .returning();
  if (user === undefined || org === undefined) throw new Error('fixture missing');
  orgId = org.id;
  principal = {
    userId: user.id,
    sessionId: randomUUID(),
    role: 'agent',
    permissions: new Set(['ticket.read', 'assistant.use']),
    orgScope: { kind: 'all' },
    orgId: null,
    email: user.email,
    name: user.name,
    authMethod: 'dev',
    accessExpiresAt: new Date(Date.now() + 60_000),
  };
  const [conversation] = await db.db
    .insert(schema.assistantConversation)
    .values({ userId: user.id })
    .returning();
  if (conversation === undefined) throw new Error('fixture conversation missing');
  conversationId = conversation.id;
  const rolePermissions = await testDb.owner.pool.query<{ permission: Permission }>(
    "SELECT permission FROM role_permissions WHERE role = 'agent'",
  );
  principal = {
    ...principal,
    permissions: new Set(rolePermissions.rows.map((row) => row.permission)),
  };
  const orgs = new OrganizationsService(db);
  auth = new AssistantHistoryAuthorization(
    db,
    {
      resolve: (context, caller) =>
        resolveContext(context, caller, {
          org: async (id, current) => {
            if (
              !current.permissions.has('ticket.read') &&
              !current.permissions.has('ticket.read.org')
            )
              return null;
            const row = await orgs.get(id, current);
            return { kind: 'org', id: row.id, label: row.name, orgId: row.id };
          },
        }),
    },
    new AuditService(db),
  );
  memory = new AssistantMemoryService(db, auth);
});

afterAll(async () => {
  await db.close();
  await testDb.cleanup();
});

describe('ADR-034 current authorization and durable memory', () => {
  it('keeps authorized history, then drops it and refuses pin after actual permission revocation', async () => {
    sourceId = await message(
      'Old private business sentence.',
      makeAssistantAuthorization(principal, [ref()], ['org_get']),
    );
    const pinned = await memory.create(principal, { messageId: sourceId, claim: 0 });
    expect(
      (await auth.history(principal, conversationId)).turns.map((turn) => turn.text),
    ).toContain('Old private business sentence.');
    await testDb.owner.pool.query(
      "DELETE FROM role_permissions WHERE role = 'agent' AND permission = 'ticket.read'",
    );
    const { rows } = await testDb.owner.pool.query<{ permission: Permission }>(
      "SELECT permission FROM role_permissions WHERE role = 'agent'",
    );
    const revoked = { ...principal, permissions: new Set(rows.map((row) => row.permission)) };
    expect((await auth.history(revoked, conversationId)).turns).toEqual([]);
    await expect(memory.create(revoked, { messageId: sourceId, claim: 0 })).rejects.toMatchObject({
      status: 404,
    });
    const list = await memory.list(revoked);
    expect(assistantMemoryListSchema.parse(list)).toEqual(list);
    expect(list.items).toEqual([
      expect.objectContaining({
        id: pinned.id,
        available: false,
        body: '',
        refs: [],
        sourceMessageId: null,
      }),
    ]);
    expect(JSON.stringify(list)).not.toContain('Old private');
    const [stored] = await db.db
      .select()
      .from(schema.assistantMemory)
      .where(eq(schema.assistantMemory.id, pinned.id));
    expect(stored?.body).toBe('Old private business sentence.');
    expect(stored?.authorization).not.toBeNull();
    await testDb.owner.pool.query(
      "INSERT INTO role_permissions(role, permission) VALUES ('agent', 'ticket.read') ON CONFLICT DO NOTHING",
    );
  });

  it('rejects cross-user pin/list/history, forged tools, changed scope and legacy provenance without deleting rows', async () => {
    const [other] = await db.db
      .insert(schema.users)
      .values({ email: 'authorization-other@example.com', name: 'Other', role: 'agent' })
      .returning();
    if (other === undefined) throw new Error('fixture missing');
    const caller = { ...principal, userId: other.id };
    expect((await auth.history(caller, conversationId)).turns).toEqual([]);
    expect((await memory.list(caller)).items).toEqual([]);
    await expect(memory.create(caller, { messageId: sourceId, claim: 0 })).rejects.toMatchObject({
      status: 404,
    });
    expect(
      await auth.authorize(caller, makeAssistantAuthorization(principal, [ref()], [])),
    ).toBeNull();
    const snapshot = makeAssistantAuthorization(principal, [ref()], []);
    expect(await auth.authorize(principal, { ...snapshot, tools: ['not_a_tool'] })).toBeNull();
    expect(
      await auth.authorize(
        { ...principal, orgScope: { kind: 'org', orgId: randomUUID() } },
        snapshot,
      ),
    ).toBeNull();
    const legacy = await message('Unknown legacy business content.', undefined);
    await expect(memory.create(principal, { messageId: legacy, claim: 0 })).rejects.toMatchObject({
      status: 404,
    });
    expect(
      (await auth.history(principal, conversationId)).turns.map((turn) => turn.text),
    ).not.toContain('Unknown legacy business content.');
    expect(
      await db.db
        .select()
        .from(schema.assistantMessage)
        .where(eq(schema.assistantMessage.id, legacy)),
    ).toHaveLength(1);
  });

  it('durable 90-day authorization survives actual 30-day conversation purge, but source deletion still tombstones', async () => {
    const now = new Date();
    await db.db
      .update(schema.assistantConversation)
      .set({ createdAt: new Date(now.getTime() - 31 * 86_400_000) })
      .where(eq(schema.assistantConversation.id, conversationId));
    await purgeExpired(db);
    const items = (await memory.list(principal, now)).items;
    expect(items[0]).toMatchObject({
      available: true,
      sourceMessageId: null,
      body: 'Old private business sentence.',
    });
    expect(Date.parse(items[0]?.expiresAt ?? '') - Date.parse(items[0]?.createdAt ?? '')).toBe(
      90 * 86_400_000,
    );
    await db.db.delete(schema.organization).where(eq(schema.organization.id, orgId));
    expect((await memory.list(principal, now)).items[0]).toMatchObject({
      available: false,
      body: '',
      refs: [],
    });
    const expired = new Date(now.getTime() + 91 * 86_400_000);
    expect((await memory.list(principal, expired)).items).toEqual([]);
  });

  it('counts unavailable legacy rows against 20, allows Forget/Clear and serializes concurrent last-slot pins', async () => {
    await memory.clear(principal);
    await db.db.insert(schema.assistantMemory).values(
      Array.from({ length: 19 }, (_, i) => ({
        userId: principal.userId,
        body: `legacy-${String(i)}`,
        expiresAt: new Date(Date.now() + 86_400_000),
      })),
    );
    const [conversation] = await db.db
      .insert(schema.assistantConversation)
      .values({ userId: principal.userId })
      .returning();
    if (conversation === undefined) throw new Error('fixture missing');
    conversationId = conversation.id;
    const first = await message('First new fact.', makeAssistantAuthorization(principal, [], []));
    const second = await message('Second new fact.', makeAssistantAuthorization(principal, [], []));
    const results = await Promise.allSettled([
      memory.create(principal, { messageId: first, claim: 0 }),
      memory.create(principal, { messageId: second, claim: 0 }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' ? rejected.reason : null).toMatchObject({ status: 409 });
    const list = await memory.list(principal);
    expect(list.items).toHaveLength(20);
    expect(list.items.filter((item) => item.available === false)).toHaveLength(19);
    const unavailable = list.items.find((item) => item.available === false);
    if (unavailable === undefined) throw new Error('fixture missing');
    await memory.remove(principal, unavailable.id);
    expect((await memory.list(principal)).items).toHaveLength(19);
    expect(await memory.clear(principal)).toBe(19);
  });
});
