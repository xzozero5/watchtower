import { AI_TOOL_BUDGETS } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import type { ToolDefinition } from '../contract.js';
import {
  createToolRegistry,
  ToolBudgetError,
  ToolInputError,
  ToolNotAllowedError,
  ToolOutputError,
} from '../tools.js';
import { createMemoryToolLedger, withToolBudget, type ToolBudgetLimits } from './budget.js';
import {
  stubFixturesSchema,
  type KbHit,
  type KbSearchPort,
  type OrgContext,
  type OrgContextPort,
  type SimilarTicket,
  type SimilarTicketsPort,
} from './ports.js';
import {
  buildAllowList,
  createBigQueryStub,
  createGcpLogsStub,
  createKbSearchTool,
  createOrgContextTool,
  createRepoChangesStub,
  createSimilarTicketsTool,
  GENERIC_INVESTIGATOR_TOOLS,
  investigationTools,
  SYSTEM_TOOLS,
  TOOL_NAMES,
} from './tools.js';

const TICKET = '11111111-1111-4111-8111-111111111111';
const OTHER_TICKET = '22222222-2222-4222-8222-222222222222';
const HASH_KEY = 'unit-test-hash-key-0123456789abcdef';

const HIT: KbHit = {
  articleId: 'a1',
  slug: 'webhook-not-received',
  title: 'Webhook not received',
  section: 'Check the endpoint',
  snippet: 'Make sure the endpoint answers within the time limit.',
  score: 0.9,
  kind: 'runbook',
  lang: 'en',
  customerVisible: true,
  isRunbook: true,
  href: '/kb/webhook-not-received',
};
const SIMILAR: SimilarTicket = {
  id: OTHER_TICKET,
  key: 'OPS-7',
  subject: 'Webhook retries',
  intentKey: 'webhook_not_received',
  status: 'resolved',
  snippet: 'Retries stopped after the endpoint returned errors.',
  similarity: 0.8,
  sameOrg: false,
  href: '/tickets/OPS-7',
};
const ORG: OrgContext = {
  orgName: 'Example Org',
  tier: 'standard',
  status: 'active',
  openTickets: 2,
  ticketsLast30Days: 5,
  href: '/orgs/1',
};

const FIXTURES = stubFixturesSchema.parse({
  gcpLogs: [
    {
      keywords: ['timeout'],
      entries: [
        {
          timestamp: '2026-01-01T00:00:00Z',
          severity: 'ERROR',
          service: 'api',
          message: 'upstream timed out',
        },
      ],
    },
  ],
  bigquery: [{ template: 'failed_deliveries', columns: ['org', 'failed'], rows: [['a', 3]] }],
  repoChanges: [
    {
      service: 'api',
      changes: [{ kind: 'deploy', ref: 'v1', title: 'Deploy v1', at: '2026-01-01T00:00:00Z' }],
    },
  ],
});

function ports() {
  const calls: Record<string, unknown[]> = { kb: [], tickets: [], org: [] };
  const kb: KbSearchPort = {
    search(input) {
      calls.kb?.push(input);
      return Promise.resolve([HIT]);
    },
  };
  const tickets: SimilarTicketsPort = {
    find(input) {
      calls.tickets?.push(input);
      return Promise.resolve([SIMILAR]);
    },
  };
  const org: OrgContextPort = {
    get(input) {
      calls.org?.push(input);
      return Promise.resolve(ORG);
    },
  };
  return { kb, tickets, org, calls };
}

function registryWith(tools: readonly ToolDefinition[], intent: string | null = null) {
  const registry = createToolRegistry(
    buildAllowList([{ key: 'upstream_timeout', allowedTools: [...SYSTEM_TOOLS, 'not_a_tool'] }]),
  );
  for (const tool of tools) registry.register(tool);
  return {
    registry,
    scope: (agent: 'investigator' | 'drafter' = 'investigator', forIntent = intent) =>
      registry.scope({ agent, intent: forIntent, stage: 2 }, { ticketId: TICKET }),
  };
}

describe('investigation tools: schemas and read-only (N2)', () => {
  const p = ports();
  const all = investigationTools({ ...p, fixtures: FIXTURES });

  it('registers the three real tools, and the stubs only when fixtures exist', () => {
    expect(all.map((tool) => tool.name).toSorted()).toEqual(Object.values(TOOL_NAMES).toSorted());
    expect(investigationTools(p).map((tool) => tool.name)).toEqual([...GENERIC_INVESTIGATOR_TOOLS]);
  });

  it('every tool is declared read-only and every stub says it is mock', () => {
    for (const tool of all) {
      expect(tool.readOnly).toBe(true);
      expect(tool.mock === true).toBe(SYSTEM_TOOLS.includes(tool.name as never));
    }
  });

  it('kb_search validates input and output on every call', async () => {
    const { scope } = registryWith(all);
    const handle = scope();
    const output = (await handle.call(TOOL_NAMES.kbSearch, { query: 'webhook' })) as {
      items: KbHit[];
    };
    expect(output.items[0]?.slug).toBe(HIT.slug);
    // The default limit is applied by the schema, then passed to the port.
    expect((p.calls.kb?.at(-1) as { limit: number }).limit).toBeGreaterThan(0);
    await expect(handle.call(TOOL_NAMES.kbSearch, { query: '' })).rejects.toBeInstanceOf(
      ToolInputError,
    );
    await expect(
      handle.call(TOOL_NAMES.kbSearch, { query: 'x', extra: true }),
    ).rejects.toBeInstanceOf(ToolInputError);
    await expect(
      handle.call(TOOL_NAMES.kbSearch, { query: 'x'.repeat(301) }),
    ).rejects.toBeInstanceOf(ToolInputError);
  });

  it('a port that returns the wrong shape is a ToolOutputError, not data for the model', async () => {
    const bad = createKbSearchTool({
      search: () => Promise.resolve([{ ...HIT, score: 7 }]),
    });
    const { scope } = registryWith([bad]);
    await expect(scope().call(TOOL_NAMES.kbSearch, { query: 'q' })).rejects.toBeInstanceOf(
      ToolOutputError,
    );
  });

  it('similar_tickets and org_context take the ticket from the run, never from the arguments', async () => {
    const own = ports();
    const { scope } = registryWith([
      createSimilarTicketsTool(own.tickets),
      createOrgContextTool(own.org),
    ]);
    const handle = scope();
    await handle.call(TOOL_NAMES.similarTickets, { query: 'webhook' });
    expect((own.calls.tickets?.at(-1) as { ticketId: string }).ticketId).toBe(TICKET);
    // A model that tries to name a ticket or an organization is refused by the schema.
    await expect(
      handle.call(TOOL_NAMES.similarTickets, { query: 'q', ticketId: OTHER_TICKET }),
    ).rejects.toBeInstanceOf(ToolInputError);
    await expect(
      handle.call(TOOL_NAMES.orgContext, { orgId: OTHER_TICKET }),
    ).rejects.toBeInstanceOf(ToolInputError);
    const org = (await handle.call(TOOL_NAMES.orgContext, {})) as { items: OrgContext[] };
    expect(org.items).toEqual([ORG]);
    expect((own.calls.org?.at(-1) as { ticketId: string }).ticketId).toBe(TICKET);
  });

  it('without a ticket in scope the tools return nothing instead of guessing', async () => {
    const own = ports();
    const registry = createToolRegistry([
      { agent: '*', intent: '*', tools: [TOOL_NAMES.orgContext] },
    ]);
    registry.register(createOrgContextTool(own.org));
    const out = await registry
      .scope({ agent: 'investigator', intent: null, stage: 0 })
      .call(TOOL_NAMES.orgContext, {});
    expect(out).toMatchObject({ items: [] });
    expect(own.calls.org).toHaveLength(0);
  });

  it('the stubs answer from fixtures, say so in the output, and find nothing for an unknown key', async () => {
    const { scope } = registryWith(all, 'upstream_timeout');
    const handle = scope();
    const logs = (await handle.call(TOOL_NAMES.gcpLogs, { query: 'API TIMEOUT errors' })) as {
      mock: boolean;
      items: unknown[];
    };
    expect(logs.mock).toBe(true);
    expect(logs.items).toHaveLength(FIXTURES.gcpLogs[0]?.entries.length ?? -1);
    const none = (await handle.call(TOOL_NAMES.gcpLogs, { query: 'unrelated' })) as {
      items: unknown[];
      note?: string;
    };
    expect(none.items).toEqual([]);
    expect(none.note).toBeTruthy();
    const rows = (await handle.call(TOOL_NAMES.bigquery, { template: 'failed_deliveries' })) as {
      mock: boolean;
      columns: string[];
    };
    expect(rows).toMatchObject({ mock: true, columns: ['org', 'failed'] });
    const changes = (await handle.call(TOOL_NAMES.repoChanges, { service: 'API' })) as {
      mock: boolean;
      items: unknown[];
    };
    expect(changes.mock).toBe(true);
    expect(changes.items).toHaveLength(1);
    // Ad-hoc SQL is not an argument: only a saved template name.
    await expect(
      handle.call(TOOL_NAMES.bigquery, { template: 'x', sql: 'DROP TABLE ticket' }),
    ).rejects.toBeInstanceOf(ToolInputError);
  });

  it('a fixture file with a wrong shape is refused before any tool exists', () => {
    expect(() => stubFixturesSchema.parse({ gcpLogs: [{ keywords: [], entries: [] }] })).toThrow();
    expect(stubFixturesSchema.parse({}).repoChanges).toEqual([]);
    expect(createGcpLogsStub(FIXTURES).mock).toBe(true);
    expect(createBigQueryStub(FIXTURES).mock).toBe(true);
    expect(createRepoChangesStub(FIXTURES).mock).toBe(true);
  });
});

describe('allow-list per agent and intent (deny by default)', () => {
  const all = investigationTools({ ...ports(), fixtures: FIXTURES });

  it('gives the generic tools to every intent and the system tools only where allowed_tools names them', () => {
    const { scope } = registryWith(all);
    const names = (intent: string | null, agent: 'investigator' | 'drafter' = 'investigator') =>
      scope(agent, intent)
        .list()
        .map((tool) => tool.name)
        .toSorted();
    expect(names(null)).toEqual([...GENERIC_INVESTIGATOR_TOOLS].toSorted());
    expect(names('some_other_intent')).toEqual([...GENERIC_INVESTIGATOR_TOOLS].toSorted());
    expect(names('upstream_timeout')).toEqual(Object.values(TOOL_NAMES).toSorted());
    expect(names('upstream_timeout', 'drafter')).toEqual([TOOL_NAMES.kbSearch]);
  });

  it('refuses a tool outside the scope and a name that was never registered', async () => {
    const { scope } = registryWith(all);
    await expect(
      scope('investigator', 'some_other_intent').call(TOOL_NAMES.gcpLogs, { query: 'timeout' }),
    ).rejects.toBeInstanceOf(ToolNotAllowedError);
    await expect(scope().call('not_a_tool', {})).rejects.toBeInstanceOf(ToolNotAllowedError);
    await expect(scope('drafter').call(TOOL_NAMES.orgContext, {})).rejects.toBeInstanceOf(
      ToolNotAllowedError,
    );
  });

  it('an agent without a rule gets nothing', () => {
    const registry = createToolRegistry(buildAllowList([]));
    for (const tool of all) registry.register(tool);
    expect(registry.scope({ agent: 'grader', intent: null, stage: 2 }).list()).toEqual([]);
  });
});

describe('the tool budget lives outside the handle (SR106-R8, N2)', () => {
  const limits: ToolBudgetLimits = {
    perRun: AI_TOOL_BUDGETS.perRun,
    perTicketPerHour: AI_TOOL_BUDGETS.perRun + 1,
    perToolPerMinute: AI_TOOL_BUDGETS.perToolPerMinute,
  };
  const all = investigationTools({ ...ports(), fixtures: FIXTURES });

  function budgeted(
    ledger: ReturnType<typeof createMemoryToolLedger>,
    runKey: string,
    ticketId: string | null = TICKET,
  ) {
    const { scope } = registryWith(all);
    return withToolBudget({
      scoped: scope('investigator', 'upstream_timeout'),
      ledger,
      runKey,
      ticketId,
      agent: 'investigator',
      intent: 'upstream_timeout',
      stage: 2,
      hashKey: HASH_KEY,
    });
  }

  it('stops a run at its call budget, and a new handle for the same run does not reset it', async () => {
    const ledger = createMemoryToolLedger(limits);
    const first = budgeted(ledger, 'run-1');
    for (let index = 0; index < limits.perRun; index += 1) {
      await first.call(TOOL_NAMES.orgContext, {});
    }
    await expect(first.call(TOOL_NAMES.orgContext, {})).rejects.toBeInstanceOf(ToolBudgetError);
    // A caller that builds a fresh scope for the same run starts over in the registry, not in the ledger.
    await expect(budgeted(ledger, 'run-1').call(TOOL_NAMES.orgContext, {})).rejects.toBeInstanceOf(
      ToolBudgetError,
    );
    const denied = ledger.rows().filter((row) => row.status === 'denied');
    expect(denied.map((row) => row.reason)).toEqual(['run_budget', 'run_budget']);
  });

  it('caps a ticket across runs for an hour, then lets it start again', async () => {
    let now = 1_000_000;
    const ledger = createMemoryToolLedger(limits, () => now);
    const one = budgeted(ledger, 'run-a');
    for (let index = 0; index < limits.perRun; index += 1) {
      await one.call(TOOL_NAMES.orgContext, {});
    }
    // A second run gets exactly the one call that is left on the ticket's hour.
    const two = budgeted(ledger, 'run-b');
    await two.call(TOOL_NAMES.kbSearch, { query: 'q' });
    await expect(two.call(TOOL_NAMES.kbSearch, { query: 'q' })).rejects.toBeInstanceOf(
      ToolBudgetError,
    );
    expect(ledger.rows().at(-1)?.reason).toBe('ticket_budget');
    // Another ticket is not affected.
    await budgeted(ledger, 'run-c', OTHER_TICKET).call(TOOL_NAMES.orgContext, {});
    now += 3_600_001;
    await budgeted(ledger, 'run-d').call(TOOL_NAMES.kbSearch, { query: 'q' });
  });

  it('rate-limits one tool across tickets inside a minute', async () => {
    let now = 5_000_000;
    const tight: ToolBudgetLimits = { ...limits, perToolPerMinute: 2, perTicketPerHour: 1000 };
    const ledger = createMemoryToolLedger(tight, () => now);
    await budgeted(ledger, 'r1', TICKET).call(TOOL_NAMES.gcpLogs, { query: 'timeout' });
    await budgeted(ledger, 'r2', OTHER_TICKET).call(TOOL_NAMES.gcpLogs, { query: 'timeout' });
    await expect(
      budgeted(ledger, 'r3', TICKET).call(TOOL_NAMES.gcpLogs, { query: 'timeout' }),
    ).rejects.toBeInstanceOf(ToolBudgetError);
    expect(ledger.rows().at(-1)?.reason).toBe('tool_rate');
    // Another tool has its own bucket; the window slides.
    await budgeted(ledger, 'r4', TICKET).call(TOOL_NAMES.orgContext, {});
    now += 60_001;
    await budgeted(ledger, 'r5', TICKET).call(TOOL_NAMES.gcpLogs, { query: 'timeout' });
  });

  it('records a refusal by the allow-list, a failure and a success, and never the input or the result', async () => {
    const ledger = createMemoryToolLedger(limits);
    const { scope } = registryWith(all);
    const failing = createToolRegistry([{ agent: '*', intent: '*', tools: ['boom'] }]);
    failing.register({
      name: 'boom',
      description: 'always fails',
      readOnly: true,
      input: all[0]?.input ?? (undefined as never),
      output: all[0]?.output ?? (undefined as never),
      execute: () => Promise.reject(new TypeError('secret detail')),
    });
    const guarded = budgeted(ledger, 'run-x');
    await guarded.call(TOOL_NAMES.kbSearch, { query: 'password for jane@example.com' });
    await expect(
      withToolBudget({
        scoped: scope('investigator', 'other'),
        ledger,
        runKey: 'run-x',
        ticketId: TICKET,
        agent: 'investigator',
        intent: 'other',
        stage: 2,
        hashKey: HASH_KEY,
      }).call(TOOL_NAMES.gcpLogs, { query: 'timeout' }),
    ).rejects.toBeInstanceOf(ToolNotAllowedError);
    await expect(
      withToolBudget({
        scoped: failing.scope({ agent: 'investigator', intent: null, stage: 2 }),
        ledger,
        runKey: 'run-x',
        ticketId: TICKET,
        agent: 'investigator',
        intent: null,
        stage: 2,
        hashKey: HASH_KEY,
      }).call('boom', { query: 'q' }),
    ).rejects.toBeInstanceOf(TypeError);

    expect(ledger.rows().map((row) => row.status)).toEqual(['ok', 'denied', 'error']);
    expect(ledger.rows()[1]?.reason).toBe('not_allowed');
    const dump = JSON.stringify(ledger.rows());
    expect(dump).not.toContain('jane@example.com');
    expect(dump).not.toContain('secret detail');
    expect(ledger.rows()[0]?.entry.inputHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keys the input hash: the same input differs under another key and is stable under the same', async () => {
    const hashOf = async (key: string): Promise<string> => {
      const ledger = createMemoryToolLedger(limits);
      const { scope } = registryWith(all);
      await withToolBudget({
        scoped: scope(),
        ledger,
        runKey: 'k',
        ticketId: TICKET,
        agent: 'investigator',
        intent: null,
        stage: 2,
        hashKey: key,
      }).call(TOOL_NAMES.kbSearch, { query: 'q', limit: 3 });
      return ledger.rows()[0]?.entry.inputHash ?? '';
    };
    expect(await hashOf(HASH_KEY)).toBe(await hashOf(HASH_KEY));
    expect(await hashOf(HASH_KEY)).not.toBe(await hashOf(`${HASH_KEY}-other`));
  });
});
