import { PERMISSIONS, type Permission } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import {
  PROPOSAL_PERMISSION,
  ROLE_PROPOSALS,
  ROLE_TOOLS,
  TOOL_PERMISSION,
  canUseAssistant,
  isMasked,
  proposalPermission,
  proposalKindsFor,
  startersFor,
  toolsFor,
} from './assistant-access.js';

const who = (role: string, permissions: readonly Permission[]) =>
  ({ role, permissions: new Set(permissions) }) as never;

const AGENT: Permission[] = [
  'ticket.read',
  'ticket.handle',
  'ticket.reply',
  'ticket.create',
  'ai.draft.review',
  'investigate.run',
  'kb.read',
  'kb.write',
];

describe('who the assistant works for', () => {
  it('gives a lead the load tool and an agent not', () => {
    expect(toolsFor(who('agent', AGENT))).not.toContain('team_load');
    expect(toolsFor(who('lead', AGENT))).toContain('team_load');
    expect(toolsFor(who('head', AGENT))).toContain('team_load');
  });

  it('needs the permission of the ordinary route behind each tool, not only the role', () => {
    const tools = toolsFor(who('agent', ['ticket.read']));
    expect(tools).toEqual([
      'search_tickets',
      'summarize_ticket',
      'explain_sla',
      // T-402: incidents and the status page ask `ticket.read` whole.
      'incident_search',
      'incident_get',
      'statuspage_status',
      'statuspage_drafts',
      'ticket_timeline',
      'autonomy_status',
      'org_get',
      'intent_get',
    ]);
    expect(toolsFor(who('agent', [...AGENT]))).toContain('investigate_run');
    expect(
      toolsFor(
        who(
          'agent',
          AGENT.filter((p) => p !== 'investigate.run'),
        ),
      ),
    ).not.toContain('investigate_run');
  });

  it('gives a client and the system identity nothing at all (po #34, N3)', () => {
    const everything = Object.keys(PERMISSIONS) as Permission[];
    for (const role of ['client', 'system', 'nobody']) {
      expect(toolsFor(who(role, everything)), role).toEqual([]);
      expect(proposalKindsFor(who(role, everything)), role).toEqual([]);
      expect(startersFor(who(role, everything), 'en', true), role).toEqual([]);
    }
  });

  // What `origin/wip/t-137` gives the dev role: the masked read, dev work on a ticket, investigate.
  const DEV: Permission[] = ['ticket.read.masked', 'ticket.dev.work', 'investigate.run'];

  it('works for a developer, who holds the masked read and not ticket.read (po #33)', () => {
    const dev = who('dev', DEV);
    expect(canUseAssistant(dev)).toBe(true);
    expect(toolsFor(dev)).toEqual([
      'search_tickets',
      'summarize_ticket',
      'explain_sla',
      'investigate_run',
      'ticket_timeline',
    ]);
    // A developer changes a status and writes a note, as a developer does, and nothing else.
    expect(proposalKindsFor(dev)).toEqual(['status', 'note']);
    expect(proposalPermission('status', dev)).toBe('ticket.dev.work');
    expect(proposalPermission('note', dev)).toBe('ticket.dev.work');
    expect(isMasked(dev)).toBe(true);
    // With the knowledge base permission as well, the guide search comes too.
    expect(toolsFor(who('dev', [...DEV, 'kb.read']))).toContain('kb_search');
  });

  it('masks by permission as well as by role, and never for a person who may read it all', () => {
    expect(isMasked(who('agent', ['ticket.read.masked']))).toBe(true);
    expect(isMasked(who('agent', ['ticket.read.masked', 'ticket.read']))).toBe(false);
    expect(isMasked(who('agent', AGENT))).toBe(false);
    // Whoever holds neither read has no assistant.
    expect(canUseAssistant(who('agent', ['ticket.handle']))).toBe(false);
    expect(toolsFor(who('agent', ['ticket.handle']))).toEqual(['team_status']);
  });

  it('never lets a role hold a tool or a proposal that has no permission mapped', () => {
    for (const tools of Object.values(ROLE_TOOLS)) {
      for (const tool of tools) expect(TOOL_PERMISSION[tool], tool).toBeDefined();
    }
    for (const kinds of Object.values(ROLE_PROPOSALS)) {
      for (const kind of kinds) expect(PROPOSAL_PERMISSION[kind], kind).toBeDefined();
    }
  });

  it('has no tool that writes: the list is searches, reads, and the template run of investigate.run', () => {
    const all = new Set(Object.values(ROLE_TOOLS).flat());
    expect([...all].sort()).toEqual([
      'alert_get',
      'alert_search',
      'autonomy_status',
      'ceo_metrics',
      'config_lookup',
      'conversation_get',
      'conversation_search',
      'explain_sla',
      'handoff_get',
      'handoff_incoming_get',
      'incident_get',
      'incident_search',
      'intent_get',
      'investigate_run',
      'kb_get',
      'kb_search',
      'ops_metrics',
      'org_get',
      'performance_view',
      'roster_view',
      'search_tickets',
      'service_get',
      'shift_context',
      'statuspage_drafts',
      'statuspage_status',
      'summarize_ticket',
      'team_load',
      'team_status',
      'ticket_timeline',
    ]);
    // Nothing that sets: no switch, role, user, credential or key tool (ADR-029 section 2). `autonomy_status` and
    // `config_lookup` only read (ADR-029 section 11), and their outputs are allow-lists (C-6).
    for (const name of all)
      expect(name).not.toMatch(/switch|_set|role|user|credential|secret|apikey|api_key|token/);
  });

  it('never offers a reply to a customer as a proposal kind', () => {
    for (const kinds of Object.values(ROLE_PROPOSALS)) {
      for (const kind of kinds) expect(kind).not.toMatch(/^(send|reply)$/);
    }
  });

  it('proposes only what the permissions allow', () => {
    expect(proposalKindsFor(who('agent', ['ticket.read']))).toEqual([]);
    expect(proposalKindsFor(who('agent', ['ticket.read', 'ticket.handle']))).toEqual([
      'assign',
      'status',
      'tag',
      'note',
      'reply_draft',
    ]);
  });
});

describe('starter prompts', () => {
  it('shows at most three, in the language asked for', () => {
    const agent = who('agent', AGENT);
    const th = startersFor(agent, 'th', true);
    expect(th).toHaveLength(3);
    expect(th.map((starter) => starter.text)).toEqual([
      'สรุปเรื่องนี้',
      'หาเคสคล้ายกัน',
      'ร่างคำตอบ',
    ]);
    expect(startersFor(agent, 'en', true).map((starter) => starter.text)).toEqual([
      'Summarize this',
      'Find similar tickets',
      'Draft a reply',
    ]);
  });

  it('offers nothing about "this" ticket without a ticket chip', () => {
    const starters = startersFor(who('agent', AGENT), 'en', false);
    expect(starters.map((starter) => starter.id)).toEqual(['my_tickets', 'sla_risk', 'find_guide']);
  });

  it('follows the role: a lead is asked about SLA and load, dev about their next ticket', () => {
    expect(startersFor(who('lead', AGENT), 'en', false).map((s) => s.id)).toEqual([
      'sla_risk',
      'overloaded',
      'team_status',
    ]);
    expect(startersFor(who('dev', AGENT), 'en', false).map((s) => s.id)).toEqual([
      'my_tickets',
      'find_guide',
    ]);
  });

  it('drops a prompt the person could not follow up on', () => {
    // Without ticket.handle there is no team status and no draft.
    const reader = who('lead', ['ticket.read', 'kb.read']);
    expect(startersFor(reader, 'en', true).map((s) => s.id)).toEqual([
      'sla_risk',
      'overloaded',
      'summarize_this',
    ]);
  });
});
