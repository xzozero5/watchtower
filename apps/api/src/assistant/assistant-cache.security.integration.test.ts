import { DevMockLlmProvider, type LlmProvider } from '@watchtower/ai';
import type { AssistantReply } from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import { API_LLM } from '../ai/ai-runtime.js';
import { RbacService } from '../rbac/rbac.service.js';
import { REDIS } from '../redis/redis.module.js';
import { startHarness, type Harness } from '../testing/harness.js';
import { apiOrg, fileTicket, signIn } from '../testing/ticketing.js';

// Uses only the disposable services selected by the integration config's TEST_* guard.
// No worker or outbound sender is started. The model deliberately returns no fallback evidence.
const net = disableNetConnect();
let h: Harness | undefined;
const provider: LlmProvider = new DevMockLlmProvider({
  rules: [
    { promptId: 'assistant_turn', text: JSON.stringify({ claims: [], proposals: [] }) },
    { promptId: 'assistant_answer', text: JSON.stringify({ claims: [], proposals: [] }) },
  ],
});

beforeAll(async () => {
  h = await startHarness({ overrides: [{ token: API_LLM, value: provider }] });
});

afterAll(async () => {
  vi.restoreAllMocks();
  try {
    await h?.close();
    expect(net.blocked()).toEqual([]);
  } finally {
    net.restore();
  }
});

it('C12: a real Redis hit repeats audit/pii.read, then permission revocation with the warm entry cannot replay facts', async () => {
  if (h === undefined) throw new Error('Disposable API harness did not start');
  const harness = h;
  const lead = await signIn(harness, 'lead');
  const agent = await signIn(harness, 'agent');
  const org = await apiOrg(lead, { name: 'Independent cache acceptance fixture' });
  const ticket = await fileTicket(agent, org.id, { subject: 'Synthetic cache-only ticket' });
  expect(
    (
      await lead.client.post(`/v1/tickets/${ticket.id}/assign`, {
        assigneeId: agent.userId,
      })
    ).status,
  ).toBe(200);

  const redis = harness.app.get<Redis>(REDIS, { strict: false });
  const get = vi.spyOn(redis, 'get'); // Call-through spy: real Redis, not a fabricated cache hit.
  const cacheReads = () =>
    get.mock.calls.flatMap((args, index) =>
      String(args[0]).includes(':assistant:facts:') ? [index] : [],
    );
  const ask = (conversationId?: string) =>
    agent.client.post<AssistantReply>('/v1/assistant/messages', {
      text: 'My tickets',
      ...(conversationId === undefined ? {} : { conversationId }),
    });
  const first = await ask();
  expect(first.status).toBe(200);
  expect(first.body.path).toBe('facts_only');
  expect(
    first.body.claims.flatMap((claim) => claim.evidence).map((evidence) => evidence.ref),
  ).toContainEqual({ kind: 'ticket', id: ticket.id });
  const miss = cacheReads();
  expect(miss).toHaveLength(1);
  expect(await get.mock.results[miss[0] ?? -1]?.value).toBeNull();

  const second = await ask(first.body.conversationId);
  expect(second.status).toBe(200);
  expect(second.body.path).toBe('facts_only');
  expect(second.body.claims).toEqual(first.body.claims);
  const hit = cacheReads();
  expect(hit).toHaveLength(2);
  expect(get.mock.calls[hit[1] ?? -1]?.[0]).toBe(get.mock.calls[hit[0] ?? -1]?.[0]);
  expect(await get.mock.results[hit[1] ?? -1]?.value).toEqual(expect.any(String));

  const owner = harness.db.owner.pool;
  const audit = await owner.query<{ action: string; n: number }>(
    `SELECT action, count(*)::int AS n FROM audit_log
     WHERE actor_id = $1 AND (
       (action = 'assistant.message' AND target_id = $2) OR
       (action = 'pii.read' AND target_id = $3 AND metadata->>'conversationId' = $2)
     ) GROUP BY action`,
    [agent.userId, first.body.conversationId, ticket.id],
  );
  expect(audit.rows).toEqual(
    expect.arrayContaining([
      { action: 'assistant.message', n: 2 },
      { action: 'pii.read', n: 2 },
    ]),
  );
  const rbac = harness.app.get(RbacService, { strict: false });
  const removed = await owner.query<{ permission: string }>(
    `DELETE FROM role_permissions WHERE role = 'agent'
     AND permission IN ('ticket.read', 'ticket.read.masked') RETURNING permission`,
  );
  rbac.invalidate();
  try {
    expect(removed.rows.length).toBeGreaterThan(0);
    const permissions = await rbac.effectivePermissions('agent', []);
    expect(permissions.has('assistant.use')).toBe(true);
    expect(permissions.has('ticket.read')).toBe(false);
    expect(permissions.has('ticket.read.masked')).toBe(false);
    expect((await agent.client.get(`/v1/tickets/${ticket.id}`)).status).toBe(403);
    const denied = await ask(first.body.conversationId);
    expect(denied.status).toBe(200); // Assistant stays usable; the revoked tool must not be.
    expect(denied.body.claims).toEqual([]);
    expect(
      denied.body.tools.some((tool) => tool.name === 'search_tickets' && tool.status === 'ok'),
    ).toBe(false);
    expect(cacheReads()).toHaveLength(2); // The warm result was not read around the tool guard.
    const warmKey = get.mock.calls[hit[1] ?? -1]?.[0];
    expect(typeof warmKey).toBe('string');
    expect(await redis.exists(String(warmKey))).toBe(1); // Revocation did not merely flush the cache.
  } finally {
    for (const row of removed.rows)
      await owner.query(
        `INSERT INTO role_permissions (role, permission) VALUES ('agent', $1) ON CONFLICT DO NOTHING`,
        [row.permission],
      );
    rbac.invalidate();
    get.mockRestore();
  }
});
