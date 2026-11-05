import type { AssistantFact } from '@watchtower/ai';
import type { Permission } from '@watchtower/shared';
import { claimHrefSchema } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import { buildAssistantTools, type AssistantToolDeps } from './assistant-tools.js';

const ALL: Permission[] = [
  'ticket.read',
  'ticket.handle',
  'kb.read',
  'investigate.run',
  'ticket.create',
];

const principal = (role: string, permissions: readonly Permission[] = ALL) =>
  ({
    userId: 'user-1',
    role,
    permissions: new Set(permissions),
    orgScope: { kind: 'all' },
  }) as never;

const view = (number: number) => ({
  t: {
    id: `00000000-0000-4000-8000-00000000000${String(number)}`,
    number,
    subject: 'Cannot sign in jane@customer.example',
    status: 'open',
    priority: 'P2',
    orgId: 'org-1',
    updatedAt: new Date(),
  },
  orgName: 'Acme',
  assigneeName: 'Mali',
  requesterName: 'Jane Doe',
  intentKey: 'access_issue',
  intentName: 'Access problems',
  aiSummary: 'Customer cannot sign in.',
});

interface Spy {
  writes: string[];
  runs: number;
  reads: string[];
}

function deps(spy: Spy): AssistantToolDeps {
  const noWrite = (name: string) => () => {
    spy.writes.push(name);
    throw new Error(`${name} must not be called by a read tool`);
  };
  const fakeDb = {
    select: () => ({
      from: () => ({
        // Awaited as it is (the people of team_load), or narrowed by orderBy/limit (messages, contacts).
        where: () =>
          Object.assign([{ id: '3f9c5a1e-6c2b-4b7a-9e0d-0f2f6f5f1a11', name: 'Mali' }], {
            orderBy: () => ({ limit: () => Promise.resolve([]) }),
            limit: () => Promise.resolve([{ name: 'Jane Doe' }]),
          }),
      }),
    }),
    insert: noWrite('insert'),
    update: noWrite('update'),
    delete: noWrite('delete'),
  };
  return {
    // The database is only asked for messages and contacts; an empty answer is enough.
    database: { db: fakeDb } as never,
    // The read-only transaction is tested against Postgres (read-only.integration.test.ts); here it hands over the fake.
    readOnly: (work) => work(fakeDb as never),
    readOnlyScope: (work) => work(),
    reader: {
      viewRow: (ref: string) =>
        ref === 'OPS-404' ? Promise.reject(new Error('404')) : Promise.resolve(view(12)),
      list: () =>
        Promise.resolve({
          items: [
            {
              key: 'OPS-12',
              subject: 'Cannot sign in',
              status: 'open',
              priority: 'P2',
              org: { id: 'org-1', name: 'Acme' },
              assignee: { id: 'u', name: 'Mali' },
              sla: { state: 'at_risk' },
            },
          ],
          nextCursor: null,
        }),
      stats: () =>
        Promise.resolve({
          byAssignee: [
            {
              assigneeId: '3f9c5a1e-6c2b-4b7a-9e0d-0f2f6f5f1a11',
              count: 14,
              open: 12,
              sla: { ok: 8, at_risk: 2, breached: 2, paused: 0 },
            },
            {
              assigneeId: null,
              count: 3,
              open: 3,
              sla: { ok: 3, at_risk: 0, breached: 0, paused: 0 },
            },
          ],
        }),
    } as never,
    keys: { format: (n: number) => `OPS-${String(n)}` } as never,
    sla: {
      view: () =>
        Promise.resolve({
          target: 'resolution',
          state: 'at_risk',
          dueAt: '2026-11-02T08:00:00.000Z',
          calendar: 'business',
          minutesLeft: 45,
        }),
    } as never,
    kb: {
      search: () =>
        Promise.resolve({
          mode: 'hybrid',
          hits: [
            { title: 'Reset a password', section: 'Steps', snippet: 'Open settings.', lang: 'en' },
          ],
        }),
    } as never,
    brief: {
      assignees: () =>
        Promise.resolve({
          assignees: [
            {
              id: 'u1',
              name: 'Mali',
              role: 'agent',
              onShift: true,
              openTickets: 4,
              inQueue: false,
            },
            { id: 'u2', name: 'Nok', role: 'lead', onShift: false, openTickets: 1, inQueue: false },
          ],
        }),
    } as never,
    runner: {
      ticketSubject: () => Promise.resolve({ kind: 'ticket', ticketId: 't1' }),
      aiTemplateOf: () => Promise.resolve('3f9c5a1e-6c2b-4b7a-9e0d-0f2f6f5f1a22'),
      // The person's own button: pins an evidence card. The assistant must never reach it (N2).
      runTemplate: () => {
        spy.writes.push('runTemplate');
        throw new Error('runTemplate pins an evidence card: the assistant must not call it');
      },
      runForAssistant: () => {
        spy.runs += 1;
        return Promise.resolve({
          kind: 'logs',
          title: 'Logs: sign-in errors',
          summary: '3 log entries',
          excerpt: 'ERROR login failed',
          resultCount: 3,
          mock: true,
        });
      },
    } as never,
    embeddingMock: true,
    aiMock: true,
  };
}

function build(
  role: string,
  options: { masked?: boolean; permissions?: readonly Permission[] } = {},
) {
  const spy: Spy = { writes: [], runs: 0, reads: [] };
  const host = buildAssistantTools(deps(spy), {
    principal: principal(role, options.permissions),
    locale: 'en',
    masked: options.masked ?? false,
    now: new Date('2026-11-02T01:00:00.000Z'),
    onRead: (ticket) => {
      spy.reads.push(ticket.key);
    },
  });
  return { host, spy };
}

const names = (host: { info: readonly { name: string }[] }) => host.info.map((tool) => tool.name);

describe('the tools of one person', () => {
  it('registers exactly the tools of the role and the permissions', () => {
    expect(names(build('agent').host)).toEqual([
      'search_tickets',
      'summarize_ticket',
      'explain_sla',
      'team_status',
      'kb_search',
      'investigate_run',
    ]);
    expect(names(build('lead').host)).toContain('team_load');
    expect(names(build('client').host)).toEqual([]);
    expect(names(build('agent', { permissions: ['ticket.read'] }).host)).toEqual([
      'search_tickets',
      'summarize_ticket',
      'explain_sla',
    ]);
  });

  it('refuses a tool that is not on the list even when the model names it', async () => {
    const { host } = build('agent');
    await expect(host.tools.call('team_load', {})).rejects.toThrow(/not allowed/);
    await expect(host.tools.call('write_note', { ticket: 'OPS-1' })).rejects.toThrow(/not allowed/);
    expect(host.tools.calls().map((call) => [call.name, call.ok, call.errorCode])).toEqual([
      ['team_load', false, 'ToolNotAllowedError'],
      ['write_note', false, 'ToolNotAllowedError'],
    ]);
  });

  it('validates every input: an unknown field, a bad ticket number, a bad limit', async () => {
    const { host } = build('lead');
    await expect(host.tools.call('search_tickets', { limit: 99 })).rejects.toThrow(/Invalid input/);
    await expect(host.tools.call('search_tickets', { admin: true })).rejects.toThrow(
      /Invalid input/,
    );
    await expect(host.tools.call('summarize_ticket', { ticket: '../etc' })).rejects.toThrow(
      /Invalid input/,
    );
    await expect(host.tools.call('team_load', { all: true })).rejects.toThrow(/Invalid input/);
  });
});

describe.each([
  ['search_tickets', {}],
  ['summarize_ticket', { ticket: 'OPS-12' }],
  ['explain_sla', { ticket: 'OPS-12' }],
  ['team_load', {}],
  ['team_status', {}],
  ['kb_search', { query: 'password' }],
  ['investigate_run', { ticket: 'OPS-12' }],
] as const)('tool %s', (name, input) => {
  it('answers with facts whose links are pages of the app, and writes nothing', async () => {
    const { host, spy } = build('lead');
    const output = await host.tools.call(name, input);
    const facts: readonly AssistantFact[] = host.facts(name, output);
    expect(facts.length).toBeGreaterThan(0);
    for (const fact of facts) {
      expect(fact.label.length).toBeGreaterThan(0);
      expect(fact.text.length).toBeGreaterThan(0);
      if (fact.href !== undefined) {
        expect(claimHrefSchema.safeParse(fact.href).success, fact.href).toBe(true);
      }
    }
    expect(spy.writes).toEqual([]);
  });

  it('is recorded as ok in the run, with the tool flagged mock only where it is', async () => {
    const { host } = build('lead');
    await host.tools.call(name, input);
    expect(host.tools.calls()).toMatchObject([{ name, ok: true, errorCode: null }]);
    expect(host.tools.list().find((tool) => tool.name === name)?.mock).toBe(name === 'kb_search');
  });
});

describe('what the tools say', () => {
  it('links a ticket to the queue page and nothing else', async () => {
    const { host } = build('agent');
    const facts = host.facts('search_tickets', await host.tools.call('search_tickets', {}));
    expect(facts[0]).toMatchObject({ kind: 'ticket', label: 'OPS-12', href: '/?ticket=OPS-12' });
    expect(facts[0]?.text).toContain('assigned to Mali');
  });

  it('shows the requester to staff and withholds it from a masked reader', async () => {
    const staff = build('agent').host;
    const staffFacts = staff.facts(
      'summarize_ticket',
      await staff.tools.call('summarize_ticket', { ticket: 'OPS-12' }),
    );
    expect(staffFacts[0]?.text).toContain('Requester Jane Doe');
    const dev = build('dev', { masked: true }).host;
    const devFacts = dev.facts(
      'summarize_ticket',
      await dev.tools.call('summarize_ticket', { ticket: 'OPS-12' }),
    );
    expect(devFacts[0]?.text).not.toContain('Jane Doe');
    expect(devFacts[0]?.text).not.toContain('Requester');
    // The redactor still learns the name, so a mention in free text is masked.
    expect(devFacts[0]?.names).toContain('Jane Doe');
  });

  it('flags an overloaded person and links to their queue', async () => {
    const { host } = build('head');
    const facts = host.facts('team_load', await host.tools.call('team_load', {}));
    expect(facts[0]).toMatchObject({
      kind: 'person',
      href: '/?assignee=3f9c5a1e-6c2b-4b7a-9e0d-0f2f6f5f1a11',
    });
    expect(facts[0]?.text).toContain('overloaded');
    expect(facts[1]?.text).toContain('3 open tickets have no assignee');
  });

  it('marks knowledge base hits as demo while embeddings are the mock ones, and links to no page', async () => {
    const { host } = build('agent');
    const [fact] = host.facts(
      'kb_search',
      await host.tools.call('kb_search', { query: 'password' }),
    );
    expect(fact).toMatchObject({ kind: 'kb', mock: true });
    expect(fact?.href).toBeUndefined();
  });

  it('runs one investigation a message, then refuses', async () => {
    const { host, spy } = build('agent');
    const output = await host.tools.call('investigate_run', { ticket: 'OPS-12' });
    const [fact] = host.facts('investigate_run', output);
    expect(fact).toMatchObject({ kind: 'log', mock: true, href: '/?ticket=OPS-12' });
    await expect(host.tools.call('investigate_run', { ticket: 'OPS-12' })).rejects.toThrow(
      /one investigation/,
    );
    expect(spy.runs).toBe(1);
    expect(host.tools.calls().map((call) => call.ok)).toEqual([true, false]);
  });

  it('does not find a ticket the person cannot open', async () => {
    const { host } = build('agent');
    await expect(host.tools.call('summarize_ticket', { ticket: 'OPS-404' })).rejects.toThrow('404');
  });

  it('runs the investigation as the AI, and never through the button that pins a card (N2)', async () => {
    const { host, spy } = build('agent');
    await host.tools.call('investigate_run', { ticket: 'OPS-12' });
    expect(spy.runs).toBe(1);
    expect(spy.writes).not.toContain('runTemplate');
  });

  it('says which tickets it read, for the audit of personal data read', async () => {
    const { host, spy } = build('agent');
    await host.tools.call('summarize_ticket', { ticket: 'OPS-12' });
    await host.tools.call('search_tickets', {});
    await host.tools.call('explain_sla', { ticket: 'OPS-12' });
    expect(spy.reads).toEqual(['OPS-12', 'OPS-12', 'OPS-12']);
  });

  it('puts the people named in a fact in its dictionary: staff as well as the customer', async () => {
    const lead = build('lead').host;
    const load = lead.facts('team_load', await lead.tools.call('team_load', {}));
    expect(load[0]?.names).toEqual(['Mali']);
    const status = lead.facts('team_status', await lead.tools.call('team_status', {}));
    expect(status.map((fact) => fact.names)).toEqual([['Mali'], ['Nok']]);
    const search = lead.facts('search_tickets', await lead.tools.call('search_tickets', {}));
    // The organization's people ride on the first fact (the contacts and the client users of the org).
    expect(search[0]?.names).toEqual(expect.arrayContaining(['Mali', 'Jane Doe']));
    const read = lead.facts(
      'summarize_ticket',
      await lead.tools.call('summarize_ticket', { ticket: 'OPS-12' }),
    );
    expect(read[0]?.names).toEqual(expect.arrayContaining(['Jane Doe', 'Mali']));
  });

  it('shows no text of a ticket when the people of its organization could not all be listed (fail closed)', async () => {
    const spy: Spy = { writes: [], runs: 0, reads: [] };
    const base = deps(spy);
    // An organization with more people than the redactor can take: the query comes back over the limit.
    const many = Array.from({ length: 10_001 }, (_, index) => ({
      name: `Person ${String(index)}`,
    }));
    const manyDb = {
      select: () => ({
        from: () => ({
          where: () =>
            Object.assign(many, {
              orderBy: () => ({ limit: () => Promise.resolve([]) }),
              limit: () => Promise.resolve(many),
            }),
        }),
      }),
    };
    const host = buildAssistantTools(
      {
        ...base,
        database: { db: manyDb } as never,
        readOnly: (work) => work(manyDb as never),
      },
      {
        principal: principal('agent'),
        locale: 'en',
        masked: false,
        now: new Date('2026-11-02T01:00:00.000Z'),
      },
    );
    for (const [name, input] of [
      ['summarize_ticket', { ticket: 'OPS-12' }],
      ['explain_sla', { ticket: 'OPS-12' }],
      ['search_tickets', {}],
    ] as const) {
      const facts = host.facts(name, await host.tools.call(name, input));
      expect(facts.length, name).toBeGreaterThan(0);
      for (const fact of facts) {
        expect(fact.text, name).toContain('text hidden');
        expect(fact.text, name).not.toContain('Cannot sign in');
        expect(fact.names, name).toBeUndefined();
      }
    }
  });
});
