import { z } from 'zod';

import type { ToolAllowRule, ToolDefinition, ToolRegistry } from '../contract.js';
import { defineTool } from '../tools.js';
import {
  kbHitSchema,
  orgContextSchema,
  similarTicketSchema,
  stubLogEntrySchema,
  type KbSearchPort,
  type OrgContextPort,
  type SimilarTicketsPort,
  type StubFixtures,
} from './ports.js';

/** The tools of the investigator and the drafter (T-108a). All are read-only (N2). */
export const TOOL_NAMES = {
  kbSearch: 'kb_search',
  similarTickets: 'similar_tickets',
  orgContext: 'org_context',
  gcpLogs: 'gcp_logs',
  bigquery: 'bigquery_query',
  repoChanges: 'repo_changes',
} as const;
export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

/** The tools every ticket gets whatever its intent: they read this instance's own knowledge. */
export const GENERIC_INVESTIGATOR_TOOLS: readonly ToolName[] = [
  TOOL_NAMES.kbSearch,
  TOOL_NAMES.similarTickets,
  TOOL_NAMES.orgContext,
];

/** The tools that reach a system outside Watchtower: they need an intent that allows them. */
export const SYSTEM_TOOLS: readonly ToolName[] = [
  TOOL_NAMES.gcpLogs,
  TOOL_NAMES.bigquery,
  TOOL_NAMES.repoChanges,
];

const queryText = z.string().trim().min(1).max(300);

export const kbSearchInput = z.strictObject({
  query: queryText,
  limit: z.number().int().min(1).max(5).default(3),
});
export const kbSearchOutput = z.object({
  items: z.array(kbHitSchema).max(5),
  note: z.string().max(200).optional(),
});

export const similarTicketsInput = z.strictObject({
  query: queryText,
  limit: z.number().int().min(1).max(5).default(3),
});
export const similarTicketsOutput = z.object({
  items: z.array(similarTicketSchema).max(5),
  note: z.string().max(200).optional(),
});

/** No argument: the organization is the ticket's, and the model cannot name another one. */
export const orgContextInput = z.strictObject({});
export const orgContextOutput = z.object({
  items: z.array(orgContextSchema).max(1),
  note: z.string().max(200).optional(),
});

export const gcpLogsInput = z.strictObject({
  query: queryText,
  windowMinutes: z.number().int().min(1).max(1440).default(60),
  limit: z.number().int().min(1).max(50).default(20),
});
export const gcpLogsOutput = z.object({
  mock: z.literal(true),
  items: z.array(stubLogEntrySchema).max(50),
  note: z.string().max(200).optional(),
});

export const bigqueryInput = z.strictObject({
  /** The name of a saved query template (ad-hoc SQL is for a person, R-5.2). */
  template: z.string().trim().min(1).max(100),
  limit: z.number().int().min(1).max(100).default(20),
});
export const bigqueryOutput = z.object({
  mock: z.literal(true),
  columns: z.array(z.string().max(60)).max(20),
  items: z.array(z.array(z.union([z.string().max(200), z.number(), z.null()])).max(20)).max(100),
  note: z.string().max(200).optional(),
});

export const repoChangesInput = z.strictObject({
  service: z.string().trim().min(1).max(100),
  windowHours: z.number().int().min(1).max(168).default(24),
});
export const repoChangesOutput = z.object({
  mock: z.literal(true),
  items: z
    .array(
      z.object({
        kind: z.enum(['commit', 'pull_request', 'release', 'deploy']),
        ref: z.string().max(100),
        title: z.string().max(300),
        at: z.string().max(40),
        url: z.string().max(500).optional(),
      }),
    )
    .max(50),
  note: z.string().max(200).optional(),
});

export function createKbSearchTool(port: KbSearchPort) {
  return defineTool({
    name: TOOL_NAMES.kbSearch,
    description:
      'Search the knowledge base (published articles and runbooks) for passages that answer the question.',
    readOnly: true,
    input: kbSearchInput,
    output: kbSearchOutput,
    async execute(input, context) {
      const items = await port.search({
        query: input.query,
        limit: input.limit,
        intentKey: context.intent,
        ticketId: context.ticketId ?? null,
        signal: context.abortSignal,
      });
      return { items: items.slice(0, input.limit) };
    },
  });
}

export function createSimilarTicketsTool(port: SimilarTicketsPort) {
  return defineTool({
    name: TOOL_NAMES.similarTickets,
    description: 'Find earlier tickets that look like this one, with how they ended.',
    readOnly: true,
    input: similarTicketsInput,
    output: similarTicketsOutput,
    async execute(input, context) {
      if (context.ticketId === undefined || context.ticketId === null) {
        return { items: [], note: 'No ticket in scope.' };
      }
      const items = await port.find({
        ticketId: context.ticketId,
        query: input.query,
        limit: input.limit,
        signal: context.abortSignal,
      });
      return { items: items.slice(0, input.limit) };
    },
  });
}

export function createOrgContextTool(port: OrgContextPort) {
  return defineTool({
    name: TOOL_NAMES.orgContext,
    description: 'The organization of this ticket: tier, status and how busy its queue is.',
    readOnly: true,
    input: orgContextInput,
    output: orgContextOutput,
    async execute(_input, context) {
      if (context.ticketId === undefined || context.ticketId === null) {
        return { items: [], note: 'No ticket in scope.' };
      }
      const org = await port.get({ ticketId: context.ticketId, signal: context.abortSignal });
      return org === null ? { items: [], note: 'No organization.' } : { items: [org] };
    },
  });
}

function matches(query: string, words: readonly string[]): boolean {
  const lower = query.toLowerCase();
  return words.some((word) => lower.includes(word.toLowerCase()));
}

/** GCP Logs in mock mode (R-5.1): answers from a fixture. The real tool replaces it with the same schemas. */
export function createGcpLogsStub(fixtures: StubFixtures) {
  return defineTool({
    name: TOOL_NAMES.gcpLogs,
    description:
      'Read recent log entries of a service for a time window (fixture data in mock mode).',
    readOnly: true,
    mock: true,
    input: gcpLogsInput,
    output: gcpLogsOutput,
    execute(input) {
      const scenario = fixtures.gcpLogs.find((candidate) =>
        matches(input.query, candidate.keywords),
      );
      return Promise.resolve(
        scenario === undefined
          ? { mock: true as const, items: [], note: 'No fixture matches this query.' }
          : { mock: true as const, items: scenario.entries.slice(0, input.limit) },
      );
    },
  });
}

/** BigQuery / product DB in mock mode (R-5.2): a saved template by name, rows from a fixture. */
export function createBigQueryStub(fixtures: StubFixtures) {
  return defineTool({
    name: TOOL_NAMES.bigquery,
    description:
      'Run a saved, read-only query template and read its rows (fixture data in mock mode).',
    readOnly: true,
    mock: true,
    input: bigqueryInput,
    output: bigqueryOutput,
    execute(input) {
      const found = fixtures.bigquery.find((candidate) => candidate.template === input.template);
      return Promise.resolve(
        found === undefined
          ? { mock: true as const, columns: [], items: [], note: 'No such query template.' }
          : {
              mock: true as const,
              columns: found.columns,
              items: found.rows.slice(0, input.limit),
            },
      );
    },
  });
}

/** Commits, pull requests, releases and deploys of a service in mock mode (R-5.3). */
export function createRepoChangesStub(fixtures: StubFixtures) {
  return defineTool({
    name: TOOL_NAMES.repoChanges,
    description:
      'List recent changes of a service: commits, pull requests, releases, deploys (fixture data in mock mode).',
    readOnly: true,
    mock: true,
    input: repoChangesInput,
    output: repoChangesOutput,
    execute(input) {
      const found = fixtures.repoChanges.find(
        (candidate) => candidate.service.toLowerCase() === input.service.toLowerCase(),
      );
      return Promise.resolve(
        found === undefined
          ? { mock: true as const, items: [], note: 'No such service in the fixture.' }
          : { mock: true as const, items: found.changes },
      );
    },
  });
}

export interface InvestigationToolDeps {
  readonly kb: KbSearchPort;
  readonly tickets: SimilarTicketsPort;
  readonly org: OrgContextPort;
  /** Fixtures for the three stubs. Absent: the stubs are not registered, so no run can call them. */
  readonly fixtures?: StubFixtures | undefined;
}

export function investigationTools(deps: InvestigationToolDeps): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    createKbSearchTool(deps.kb),
    createSimilarTicketsTool(deps.tickets),
    createOrgContextTool(deps.org),
  ];
  if (deps.fixtures !== undefined) {
    tools.push(
      createGcpLogsStub(deps.fixtures),
      createBigQueryStub(deps.fixtures),
      createRepoChangesStub(deps.fixtures),
    );
  }
  return tools;
}

export interface IntentToolGrant {
  readonly key: string;
  /** `intent.allowed_tools`: what the instance's staff allowed for this intent. */
  readonly allowedTools: readonly string[];
}

const KNOWN_SYSTEM_TOOLS: ReadonlySet<string> = new Set(SYSTEM_TOOLS);

/**
 * The allow-list, as data (deny by default). Everyone gets the generic tools; a system tool
 * (logs, data, repo) is granted only to an intent whose `allowed_tools` names it. An unknown name
 * in `allowed_tools` grants nothing. The drafter may search the knowledge base and nothing else.
 */
export function buildAllowList(intents: readonly IntentToolGrant[]): ToolAllowRule[] {
  const rules: ToolAllowRule[] = [
    { agent: 'investigator', intent: '*', tools: GENERIC_INVESTIGATOR_TOOLS },
    { agent: 'drafter', intent: '*', tools: [TOOL_NAMES.kbSearch] },
  ];
  for (const intent of intents) {
    const tools = intent.allowedTools.filter((name) => KNOWN_SYSTEM_TOOLS.has(name));
    if (tools.length > 0) rules.push({ agent: 'investigator', intent: intent.key, tools });
  }
  return rules;
}

export function registerAll(
  registry: ToolRegistry,
  tools: readonly ToolDefinition[],
): ToolRegistry {
  for (const tool of tools) registry.register(tool);
  return registry;
}
