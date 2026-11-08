import { randomBytes } from 'node:crypto';

import type { LlmProvider } from '@watchtower/ai';
import { type AssistantMemory, type AssistantReply } from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { API_LLM } from '../ai/ai-runtime.js';
import { AuditService } from '../audit/audit.service.js';
import { startHarness, type Harness } from '../testing/harness.js';
import {
  apiOrg,
  fileTicket,
  signIn,
  type ApiErrorBody,
  type Persona,
} from '../testing/ticketing.js';

const net = disableNetConnect();

let say: string[] = ['The service is running normally.'];
type LlmRequest = Parameters<LlmProvider['generate']>[0];
const capturedRequests: LlmRequest[] = [];

const model: LlmProvider = {
  kind: 'mock',
  generate(request) {
    capturedRequests.push(request);
    const text =
      request.prompt.id === 'assistant_turn'
        ? JSON.stringify({ calls: [] })
        : JSON.stringify({
            claims: say.map((sentence) => ({ text: sentence, evidenceIds: [] })),
            proposals: [],
          });
    return Promise.resolve({
      text,
      finishReason: 'stop' as const,
      usage: { inputTokens: 20, outputTokens: 10 },
      model: request.model,
    });
  },
};

let h: Harness;
let lead: Persona;
const suffix = `u${randomBytes(3).toString('hex')}`;
const owner = () => h.db.owner.pool;

async function ask(who: Persona, text: string, sentences: string[]): Promise<AssistantReply> {
  say = sentences;
  const response = await who.client.post<AssistantReply>('/v1/assistant/messages', { text });
  if (response.status !== 200 || response.body.state !== 'ok') {
    throw new Error(`message failed: ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

const remember = (who: Persona, messageId: string, claim: number) =>
  who.client.post<AssistantMemory & ApiErrorBody>('/v1/assistant/memory', { messageId, claim });

beforeAll(async () => {
  h = await startHarness({ overrides: [{ token: API_LLM, value: model }] });
  lead = await signIn(h, 'lead');
});

afterAll(async () => {
  await h.close();
  expect(net.blocked()).toEqual([]);
  net.restore();
});

beforeEach(() => {
  capturedRequests.length = 0;
});

describe('T-445d: Assistant Memory to User Notes Integration', () => {
  it('connects <= 10 active memories to userNotes, updates lastUsedAt, keeps expiresAt intact', async () => {
    const who = await signIn(h, 'agent');
    const firstReply = await ask(who, 'Check system state', [
      'System kernel parameter net.core is 4096.',
    ]);
    const remRes = await remember(who, firstReply.messageId, 0);
    expect(remRes.status).toBe(201);
    const memoryId = remRes.body.id;

    const [beforeRow] = (
      await owner().query<{ last_used_at: Date; expires_at: Date }>(
        'SELECT last_used_at, expires_at FROM assistant_memory WHERE id = $1',
        [memoryId],
      )
    ).rows;
    expect(beforeRow).toBeDefined();

    // Small delay to ensure timestamp differences in DB clock
    await new Promise((r) => setTimeout(r, 50));

    capturedRequests.length = 0;
    const nextReply = await ask(who, 'What parameter did I check earlier?', [
      'You checked net.core parameter.',
    ]);
    expect(nextReply.state).toBe('ok');

    // Model must receive user_notes with the pinned fact
    expect(capturedRequests.length).toBeGreaterThan(0);
    const turnReq = capturedRequests.find((r) => r.prompt.id === 'assistant_turn');
    expect(turnReq).toBeDefined();
    const promptText = JSON.stringify(turnReq);
    expect(promptText).toContain('user_notes');
    expect(promptText).toContain('System kernel parameter net.core is 4096');

    // DB update: last_used_at moved forward, expires_at unchanged
    const [afterRow] = (
      await owner().query<{ last_used_at: Date; expires_at: Date }>(
        'SELECT last_used_at, expires_at FROM assistant_memory WHERE id = $1',
        [memoryId],
      )
    ).rows;
    if (beforeRow === undefined || afterRow === undefined) {
      throw new Error('memory rows missing in database');
    }
    expect(new Date(afterRow.last_used_at).getTime()).toBeGreaterThanOrEqual(
      new Date(beforeRow.last_used_at).getTime(),
    );
    expect(new Date(afterRow.expires_at).getTime()).toBe(new Date(beforeRow.expires_at).getTime());
  });

  it('enforces strict user isolation: memory of user A never leaks into user B turn', async () => {
    const userA = await signIn(h, 'agent');
    const userB = await signIn(h, 'agent');

    const replyA = await ask(userA, 'Seed fact for user A', [
      'Secret token of user A is ALPHA-99.',
    ]);
    await remember(userA, replyA.messageId, 0);

    capturedRequests.length = 0;
    const replyB = await ask(userB, 'Hello from user B', ['Hello user B.']);
    expect(replyB.state).toBe('ok');

    const promptTextB = JSON.stringify(capturedRequests);
    expect(promptTextB).not.toContain('ALPHA-99');
    expect(promptTextB).not.toContain('Secret token of user A');
  });

  it('ignores expired memories based on DB clock (expiresAt <= clock_timestamp())', async () => {
    const who = await signIn(h, 'agent');
    const reply = await ask(who, 'Time test', ['Temporary fact that will expire.']);
    const remRes = await remember(who, reply.messageId, 0);
    expect(remRes.status).toBe(201);
    const memoryId = remRes.body.id;

    // Fast-forward expiry into the past
    await owner().query(
      "UPDATE assistant_memory SET expires_at = clock_timestamp() - interval '1 hour' WHERE id = $1",
      [memoryId],
    );

    capturedRequests.length = 0;
    await ask(who, 'Tell me after expiry', ['Nothing remembered.']);

    const promptText = JSON.stringify(capturedRequests);
    expect(promptText).not.toContain('Temporary fact that will expire');
  });

  it('drops revoked/forged memory silently and propagates dependencies for authorized memories', async () => {
    const who = await signIn(h, 'agent');
    const reply = await ask(who, 'Auth propagation test', ['Important verified business rule.']);
    const remRes = await remember(who, reply.messageId, 0);
    expect(remRes.status).toBe(201);
    const memoryId = remRes.body.id;

    // Forge authorization fingerprint
    await owner().query(
      `UPDATE assistant_memory SET "authorization" = jsonb_set("authorization", '{fingerprint}', '"deadbeef00000000deadbeef00000000deadbeef00000000deadbeef00000000"'::jsonb) WHERE id = $1`,
      [memoryId],
    );

    capturedRequests.length = 0;
    const res = await ask(who, 'Ask after forged', ['Answer without forged memory.']);
    expect(res.state).toBe('ok');

    const promptText = JSON.stringify(capturedRequests);
    expect(promptText).not.toContain('Important verified business rule');
  });

  it('pre-audits PII for memory refs and fails closed (503 assistant_audit_failed) if audit write fails', async () => {
    const who = await signIn(h, 'agent');
    const org = await apiOrg(lead, { name: `PII Memory Org ${suffix}` });
    const ticket = await fileTicket(who, org.id, { subject: 'Ticket for PII audit test' });

    // Ask with ticket chip so memory captures ticket ref
    const reply = await who.client.post<AssistantReply>('/v1/assistant/messages', {
      text: 'Note about ticket',
      context: { ticket: ticket.key },
    });
    expect(reply.status).toBe(200);

    // Save claim referencing ticket evidence
    await owner().query(
      `UPDATE assistant_message
       SET evidence = jsonb_build_array(jsonb_build_object('claim', 0, 'kind', 'ticket', 'id', $1::text))
       WHERE id = $2`,
      [ticket.id, reply.body.messageId],
    );

    const remRes = await remember(who, reply.body.messageId, 0);
    expect(remRes.status).toBe(201);

    // Mock AuditService.recordPiiRead to simulate audit failure
    const auditService = h.app.get(AuditService);
    const originalRecord = auditService.recordPiiRead.bind(auditService);
    let shouldFail = true;
    auditService.recordPiiRead = async (entry) => {
      if (
        shouldFail &&
        entry.targetId === ticket.id &&
        entry.metadata?.purpose !== 'reauthorization'
      ) {
        throw new Error('Audit sink unavailable');
      }
      return originalRecord(entry);
    };

    try {
      capturedRequests.length = 0;
      const failedReply = await who.client.post<AssistantReply & ApiErrorBody>(
        '/v1/assistant/messages',
        {
          text: 'Followup turn that should fail closed on PII audit',
        },
      );
      expect(failedReply.status).toBe(503);
      expect((failedReply.body as ApiErrorBody).code).toBe('assistant_audit_failed');
      // LLM was not called!
      expect(capturedRequests.length).toBe(0);
    } finally {
      shouldFail = false;
      auditService.recordPiiRead = originalRecord;
    }
  });

  it('blocks investigate_run when userNotes are present', async () => {
    const who = await signIn(h, 'agent');
    const reply = await ask(who, 'Prepare note', ['Note that prevents investigation tool.']);
    await remember(who, reply.messageId, 0);

    capturedRequests.length = 0;
    // Ask with investigate intent text
    const invReply = await ask(who, 'Please investigate root cause of server crash', [
      'Analysis of crash.',
    ]);
    expect(invReply.state).toBe('ok');

    const turnReq = capturedRequests.find((r) => r.prompt.id === 'assistant_turn');
    expect(turnReq).toBeDefined();
    // In tool definitions passed to model, investigate_run must NOT be present
    const toolList = JSON.stringify(turnReq);
    expect(toolList).not.toContain('investigate_run');
  });
});
