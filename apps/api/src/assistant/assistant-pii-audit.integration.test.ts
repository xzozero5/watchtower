import { randomBytes } from 'node:crypto';

import { DevMockLlmProvider, type LlmProvider } from '@watchtower/ai';
import { assistantReplySchema, type AssistantReply, type TicketDetail } from '@watchtower/shared';
import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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

let h: Harness;
let lead: Persona;
let agent: Persona;
let orgId: string;
let ticket: TicketDetail;
const suffix = `x${randomBytes(3).toString('hex')}`;

const calls: string[] = [];
const sent: string[] = [];
const script: { plan?: string; answer?: string } = {};

const spy: LlmProvider = (() => {
  const inner = new DevMockLlmProvider();
  return {
    kind: 'mock' as const,
    generate(request) {
      calls.push(request.prompt.id);
      sent.push(request.system + request.messages.map((message) => message.content).join('\n'));
      const forced =
        request.prompt.id === 'assistant_turn'
          ? (script.plan ??
            (script.answer === undefined ? undefined : JSON.stringify({ calls: [] })))
          : request.prompt.id === 'assistant_answer'
            ? script.answer
            : undefined;
      if (forced !== undefined) {
        return Promise.resolve({
          text: forced,
          finishReason: 'stop' as const,
          usage: { inputTokens: 50, outputTokens: 20 },
          model: request.model,
        });
      }
      return inner.generate(request);
    },
  };
})();

const owner = () => h.db.owner.pool;

const ask = (who: Persona, text: string, extra: Record<string, unknown> = {}) =>
  who.client.post<AssistantReply>('/v1/assistant/messages', { text, ...extra });

const okReply = async (
  who: Persona,
  text: string,
  extra: Record<string, unknown> = {},
): Promise<AssistantReply> => {
  const res = await ask(who, text, extra);
  expect(res.status).toBe(200);
  return assistantReplySchema.parse(res.body);
};

beforeAll(async () => {
  h = await startHarness({
    overrides: [{ token: API_LLM, value: spy }],
  });
  lead = await signIn(h, 'lead');
  agent = await signIn(h, 'agent');
  orgId = (await apiOrg(lead, { name: `Audit Org ${suffix}` })).id;
  ticket = await fileTicket(agent, orgId, {
    subject: `PII Audit Test Ticket ${suffix}`,
  });
  await owner().query('UPDATE ticket SET assignee_id = $1 WHERE id = $2', [
    agent.userId,
    ticket.id,
  ]);
});

afterAll(async () => {
  net.restore();
  await h.close();
});

describe('T-445b Integration: PII Audit Catalogue and Fail-Closed Withhold', () => {
  it('(ก) No-chip tool calls write pii.read audit rows in DB', async () => {
    // 1. search_tickets without context chip
    script.plan = JSON.stringify({
      calls: [{ tool: 'search_tickets', input: { query: `PII Audit Test Ticket ${suffix}` } }],
    });
    try {
      const reply = await okReply(lead, `Find tickets about ${suffix}`);
      const ticketPiiReads = await owner().query<{ target_id: string; target_type: string }>(
        `SELECT target_id, target_type FROM audit_log WHERE action = 'pii.read' AND target_type = 'ticket' AND target_id = $1 AND metadata->>'conversationId' = $2`,
        [ticket.id, reply.conversationId],
      );
      expect(ticketPiiReads.rows.length).toBeGreaterThanOrEqual(1);
      expect(ticketPiiReads.rows[0]?.target_type).toBe('ticket');
    } finally {
      delete script.plan;
    }

    // 2. team_status without context chip
    script.plan = JSON.stringify({
      calls: [{ tool: 'team_status', input: {} }],
    });
    try {
      const reply = await okReply(lead, 'Who is on shift right now?');
      const shiftPiiReads = await owner().query<{ target_id: string; target_type: string }>(
        `SELECT target_id, target_type FROM audit_log WHERE action = 'pii.read' AND target_type = 'shift_overview' AND metadata->>'conversationId' = $1`,
        [reply.conversationId],
      );
      // Lead or agent present in brief/assignees has a shift_overview audit entry
      expect(shiftPiiReads.rows.length).toBeGreaterThanOrEqual(1);
      expect(shiftPiiReads.rows[0]?.target_type).toBe('shift_overview');
    } finally {
      delete script.plan;
    }

    // 3. team_load without context chip
    script.plan = JSON.stringify({
      calls: [{ tool: 'team_load', input: {} }],
    });
    try {
      const reply = await okReply(lead, 'How is the team load?');
      const loadPiiReads = await owner().query<{ target_id: string; target_type: string }>(
        `SELECT target_id, target_type FROM audit_log WHERE action = 'pii.read' AND target_type = 'performance' AND metadata->>'conversationId' = $1`,
        [reply.conversationId],
      );
      expect(loadPiiReads.rows.length).toBeGreaterThanOrEqual(1);
      expect(loadPiiReads.rows[0]?.target_type).toBe('performance');
    } finally {
      delete script.plan;
    }
  });

  it('(ข) Fail-closed withhold: when pii.read audit write fails during tool execution, data is withheld with 503', async () => {
    const auditService = h.app.get(AuditService);
    const spyAudit = vi
      .spyOn(auditService, 'recordPiiRead')
      .mockRejectedValue(new Error('Audit DB write simulated failure'));

    script.plan = JSON.stringify({
      calls: [{ tool: 'search_tickets', input: { query: `PII Audit Test Ticket ${suffix}` } }],
    });
    try {
      const res = await lead.client.post('/v1/assistant/messages', {
        text: `Find ticket ${ticket.key}`,
      });

      // Must fail closed with 503 assistant_audit_failed
      expect(res.status).toBe(503);
      const errorBody = res.body as ApiErrorBody;
      expect(errorBody.code).toBe('assistant_audit_failed');

      // The secret ticket subject must NEVER appear in the response body
      expect(JSON.stringify(res.body)).not.toContain(`PII Audit Test Ticket ${suffix}`);
    } finally {
      spyAudit.mockRestore();
      delete script.plan;
    }
  });

  it('(ข) Fail-closed withhold: when pre-audit for context chip fails, LLM is not called and 503 is returned', async () => {
    const auditService = h.app.get(AuditService);
    const spyAudit = vi
      .spyOn(auditService, 'recordPiiRead')
      .mockRejectedValue(new Error('Audit DB pre-audit simulated failure'));

    const callsBefore = calls.length;
    try {
      const res = await lead.client.post('/v1/assistant/messages', {
        text: 'Summarize this ticket',
        context: { ticket: ticket.key },
      });

      // Must fail closed with 503 assistant_audit_failed
      expect(res.status).toBe(503);
      const errorBody = res.body as ApiErrorBody;
      expect(errorBody.code).toBe('assistant_audit_failed');

      // Pre-audit fails closed BEFORE calling LLM
      expect(calls.length).toBe(callsBefore);

      // Data is withheld
      expect(JSON.stringify(res.body)).not.toContain(`PII Audit Test Ticket ${suffix}`);
    } finally {
      spyAudit.mockRestore();
    }
  });

  it('(ค) C-4 Fail-closed: when PII audit write fails during turn, zero assistant_message rows are committed', async () => {
    const auditService = h.app.get(AuditService);
    const messagesBefore = (
      await owner().query<{ count: string }>(
        'SELECT count(*) as count FROM assistant_message WHERE user_id = $1',
        [lead.userId],
      )
    ).rows[0]?.count;

    const spyAudit = vi
      .spyOn(auditService, 'recordPiiRead')
      .mockRejectedValue(new Error('Audit DB failure during tool run'));

    script.plan = JSON.stringify({
      calls: [{ tool: 'summarize_ticket', input: { ticket: ticket.key } }],
    });

    try {
      const res = await lead.client.post('/v1/assistant/messages', {
        text: `Summarize ticket ${ticket.key}`,
      });
      expect(res.status).toBe(503);
      expect((res.body as ApiErrorBody).code).toBe('assistant_audit_failed');

      // Verify zero new assistant_message rows were committed to DB
      const messagesAfter = (
        await owner().query<{ count: string }>(
          'SELECT count(*) as count FROM assistant_message WHERE user_id = $1',
          [lead.userId],
        )
      ).rows[0]?.count;
      expect(messagesAfter).toBe(messagesBefore);
    } finally {
      spyAudit.mockRestore();
      delete script.plan;
    }
  });
});
