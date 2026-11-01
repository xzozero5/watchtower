import { z } from 'zod';

import type { ToolAllowRule, ToolDefinition, ToolRegistry } from '../contract.js';
import { defineTool } from '../tools.js';
import {
  kbHitSchema,
  orgContextSchema,
  similarTicketSchema,
  toolDataCellSchema,
  toolLogEntrySchema,
  toolRepoChangeSchema,
  type DataToolPort,
  type KbSearchPort,
  type LogsToolPort,
  type OrgContextPort,
  type RepoToolPort,
  type SimilarTicketsPort,
  type SystemToolPorts,
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

/**
 * No filter, no text: the logs of the ticket's organization come from the log template of the scope
 * intent, and the model (or the ticket) names only a window and a size. Customer text never becomes
 * part of a query (T-203d).
 */
export const gcpLogsInput = z.strictObject({
  windowMinutes: z.number().int().min(1).max(1440).default(60),
  limit: z.number().int().min(1).max(50).default(20),
});
export const gcpLogsOutput = z.object({
  /** True when the lines come from a fake or a sandbox. */
  mock: z.boolean(),
  items: z.array(toolLogEntrySchema).max(50),
  note: z.string().max(200).optional(),
});

/** The data template of the scope intent is the query (ad-hoc SQL is for a person, R-5.2). */
export const bigqueryInput = z.strictObject({
  limit: z.number().int().min(1).max(100).default(20),
});
export const bigqueryOutput = z.object({
  mock: z.boolean(),
  columns: z.array(z.string().max(60)).max(20),
  items: z.array(z.array(toolDataCellSchema).max(20)).max(100),
  note: z.string().max(200).optional(),
});

export const repoChangesInput = z.strictObject({
  service: z.string().trim().min(1).max(100),
  windowHours: z.number().int().min(1).max(168).default(24),
});
export const repoChangesOutput = z.object({
  mock: z.boolean(),
  items: z.array(toolRepoChangeSchema).max(50),
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

/** Logs of the ticket's organization (R-5.1), through a port over the read-only logs client. */
export function createGcpLogsTool(port: LogsToolPort) {
  return defineTool({
    name: TOOL_NAMES.gcpLogs,
    description:
      'Read recent log entries of the ticket\'s organization for a time window, from the log template of the intent.',
    readOnly: true,
    mock: port.mock,
    input: gcpLogsInput,
    output: gcpLogsOutput,
    async execute(input, context) {
      const result = await port.run({
        windowMinutes: input.windowMinutes,
        limit: input.limit,
        intentKey: context.intent,
        ticketId: context.ticketId ?? null,
        signal: context.abortSignal,
      });
      return {
        mock: port.mock,
        items: result.items.slice(0, input.limit),
        ...(result.note === undefined ? {} : { note: result.note }),
      };
    },
  });
}

/** The data template of the intent (R-5.2), through a port over the guarded, read-only data client. */
export function createBigQueryTool(port: DataToolPort) {
  return defineTool({
    name: TOOL_NAMES.bigquery,
    description:
      'Run the saved, read-only query template of the intent for the ticket\'s organization and read its rows.',
    readOnly: true,
    mock: port.mock,
    input: bigqueryInput,
    output: bigqueryOutput,
    async execute(input, context) {
      const result = await port.run({
        limit: input.limit,
        intentKey: context.intent,
        ticketId: context.ticketId ?? null,
        signal: context.abortSignal,
      });
      return {
        mock: port.mock,
        columns: [...result.columns],
        items: result.items.slice(0, input.limit).map((row) => [...row]),
        ...(result.note === undefined ? {} : { note: result.note }),
      };
    },
  });
}

/** Commits, pull requests, releases and deploys of a service (R-5.3), through a port over the repository client. */
export function createRepoChangesTool(port: RepoToolPort) {
  return defineTool({
    name: TOOL_NAMES.repoChanges,
    description:
      'List recent changes of a service: commits, pull requests, releases, deploys.',
    readOnly: true,
    mock: port.mock,
    input: repoChangesInput,
    output: repoChangesOutput,
    async execute(input, context) {
      const result = await port.run({
        service: input.service,
        windowHours: input.windowHours,
        signal: context.abortSignal,
      });
      return {
        mock: port.mock,
        items: result.items.slice(0, 50),
        ...(result.note === undefined ? {} : { note: result.note }),
      };
    },
  });
}

export interface InvestigationToolDeps {
  readonly kb: KbSearchPort;
  readonly tickets: SimilarTicketsPort;
  readonly org: OrgContextPort;
  /** The systems outside Watchtower. A missing port means that tool is not registered, so no run can call it. */
  readonly systems?: SystemToolPorts | undefined;
}

export function investigationTools(deps: InvestigationToolDeps): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    createKbSearchTool(deps.kb),
    createSimilarTicketsTool(deps.tickets),
    createOrgContextTool(deps.org),
  ];
  const systems = deps.systems;
  if (systems?.logs !== undefined) tools.push(createGcpLogsTool(systems.logs));
  if (systems?.data !== undefined) tools.push(createBigQueryTool(systems.data));
  if (systems?.repo !== undefined) tools.push(createRepoChangesTool(systems.repo));
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
