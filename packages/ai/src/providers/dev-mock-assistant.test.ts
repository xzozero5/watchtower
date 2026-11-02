import { describe, expect, it } from 'vitest';

import type { LlmRequest } from '../contract.js';
import type { RedactedText } from '../redaction/redacted-text.js';
import { assistantAnswer, assistantPlan } from './dev-mock-assistant.js';

const as = (text: string): RedactedText => text as RedactedText;

const TOOLS = [
  'search_tickets',
  'summarize_ticket',
  'explain_sla',
  'team_load',
  'team_status',
  'kb_search',
  'investigate_run',
];

function plan(text: string, tools: readonly string[] = TOOLS, ticket?: string) {
  const request = {
    system: as(`Tools:\n${tools.map((tool) => `- ${tool}: does a thing. Input: {}`).join('\n')}`),
    messages: [
      {
        role: 'user',
        content: as(
          `<context>\nlanguage: en\n${ticket === undefined ? '' : `ticket_in_view: ${ticket}\n`}</context>\n<request>\n${text}\n</request>`,
        ),
      },
    ],
  } as unknown as LlmRequest;
  return (JSON.parse(assistantPlan(request)) as { calls: { tool: string; input: unknown }[] })
    .calls;
}

function answer(text: string, kinds: readonly string[], facts: readonly string[] = []) {
  const request = {
    system: as(
      `At most 5 claims. Allowed kinds in this conversation: ${kinds.length === 0 ? 'none' : kinds.join(', ')}. Write in English.`,
    ),
    messages: [
      {
        role: 'user',
        content: as(
          `<context>\nlanguage: en\nticket_in_view: OPS-12\n</context>\n<tool_results>\n${facts.join('\n')}\n</tool_results>\n<request>\n${text}\n</request>`,
        ),
      },
    ],
  } as unknown as LlmRequest;
  return JSON.parse(assistantAnswer(request)) as {
    claims: { text: string; evidenceIds: string[] }[];
    proposals: Record<string, unknown>[];
  };
}

describe('dev mock: assistant plan', () => {
  it.each([
    ['who is overloaded', 'team_load'],
    ['ใครงานล้น', 'team_load'],
    ['team status', 'team_status'],
    ['what is at SLA risk', 'search_tickets'],
    ['my tickets', 'search_tickets'],
    ['งานของฉัน', 'search_tickets'],
    ['how do I reset a password', 'kb_search'],
    ['หาคู่มือ', 'kb_search'],
  ])('%s -> %s', (text, tool) => {
    expect(plan(text).map((call) => call.tool)).toContain(tool);
  });

  it('uses the ticket in view for "this"', () => {
    expect(plan('summarize this', TOOLS, 'OPS-12')).toEqual([
      { tool: 'summarize_ticket', input: { ticket: 'OPS-12' } },
    ]);
    expect(plan('explain the SLA of OPS-7', TOOLS, 'OPS-12')).toEqual([
      { tool: 'explain_sla', input: { ticket: 'OPS-7' } },
    ]);
    expect(plan('investigate OPS-12 logs')[0]?.tool).toBe('investigate_run');
  });

  it('chooses only among the tools it is told exist', () => {
    expect(plan('who is overloaded', ['search_tickets'])).toEqual([]);
    expect(plan('my tickets', ['kb_search'])).toEqual([]);
  });
});

describe('dev mock: assistant answer', () => {
  it('writes one claim per fact, citing it', () => {
    const result = answer(
      'find my tickets',
      [],
      ['[e1] ticket: OPS-1 "A" is open. More text.', '[e2] ticket: OPS-2 "B" is open.'],
    );
    expect(result.claims).toEqual([
      { text: 'OPS-1 "A" is open.', evidenceIds: ['e1'] },
      { text: 'OPS-2 "B" is open.', evidenceIds: ['e2'] },
    ]);
  });

  it('says plainly that nothing was found, with no evidence', () => {
    expect(answer('find my tickets', []).claims).toEqual([
      { text: 'Nothing relevant was found.', evidenceIds: [] },
    ]);
  });

  it.each([
    [
      'assign this to Mali Srisuk',
      ['assign'],
      { kind: 'assign', ticket: 'OPS-12', assignee: 'Mali Srisuk' },
    ],
    ['unassign OPS-3', ['assign'], { kind: 'assign', ticket: 'OPS-3', assignee: null }],
    ['resolve this', ['status'], { kind: 'status', ticket: 'OPS-12', status: 'resolved' }],
    [
      'set OPS-4 to waiting on customer',
      ['status'],
      { kind: 'status', ticket: 'OPS-4', status: 'waiting_on_customer' },
    ],
    ['tag this vip', ['tag'], { kind: 'tag', ticket: 'OPS-12', add: ['vip'] }],
    [
      'add a note: called the customer',
      ['note'],
      { kind: 'note', ticket: 'OPS-12', body: 'called the customer' },
    ],
    ['draft a reply', ['reply_draft'], { kind: 'reply_draft', ticket: 'OPS-12' }],
    ['ร่างคำตอบ', ['reply_draft'], { kind: 'reply_draft', ticket: 'OPS-12' }],
  ])('%s -> one %j proposal', (text, kinds, expected) => {
    expect(answer(text, kinds).proposals).toEqual([expected]);
  });

  it('proposes nothing that is not on the allowed list', () => {
    expect(answer('assign this to Mali', ['note']).proposals).toEqual([]);
    expect(answer('resolve this', []).proposals).toEqual([]);
  });

  it('prepares a new ticket and a knowledge base draft from a plain request', () => {
    expect(
      answer('create ticket for Acme Co about login failures', ['create_ticket']).proposals,
    ).toEqual([
      {
        kind: 'create_ticket',
        org: 'Acme Co',
        subject: 'login failures',
        body: 'login failures',
      },
    ]);
    expect(
      answer('draft a KB article about password resets', ['kb_draft']).proposals[0],
    ).toMatchObject({
      kind: 'kb_draft',
      title: 'password resets',
    });
  });
});
