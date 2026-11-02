import type {
  DataToolPort,
  LogsToolPort,
  RepoToolPort,
  SystemToolPorts,
  ToolDataCell,
  ToolRepoChange,
} from '@watchtower/ai';
import {
  isMockSource,
  runDataTemplate,
  runLogsTemplate,
  templateInputParams,
  templatePlaceholders,
  type ToolClients,
} from '@watchtower/connectors';
import { schema, type Database } from '@watchtower/db';
import { templateForAi } from '@watchtower/domain';
import { DATA_RUN_TIMEOUT_MS } from '@watchtower/shared';
import { and, desc, eq, gte, sql } from 'drizzle-orm';

/**
 * The AI's logs, data and repository tools over the read-only clients of `@watchtower/connectors`
 * (T-203d). They replace the fixture stubs of T-108 and keep every guard of it: the run's scope
 * intent (`resolveToolScope`) decides which template is the query, the model chooses neither a
 * filter nor a statement, the intent's `allowed_tools` decide whether the tool exists at all, and the
 * budget and audit rows are taken by `withToolBudget` before a port is reached. What comes back is
 * text a person wrote in a log or a column: it passes `redactToolOutput` before a model sees it (N4).
 *
 * Templates, services and deploys are our own tables, read on the application connection (the `ai_v_*`
 * views are for tickets and organizations only).
 */

type Reader = Pick<Database['db'], 'select'>;

const MAX_REPOS = 3;
const REPO_CHANGES_PER_REPO = 20;

async function orgOfTicket(db: Reader, ticketId: string): Promise<string | null> {
  const [row] = await db
    .select({ orgId: schema.ticket.orgId })
    .from(schema.ticket)
    .where(eq(schema.ticket.id, ticketId))
    .limit(1);
  return row?.orgId ?? null;
}

/**
 * The values the ticket fills in a template (`org_id`, `ticket_id`). A template that needs anything
 * else is for a person to press: the AI does not invent a session id.
 */
async function ticketParams(
  db: Reader,
  body: string,
  ticketId: string,
): Promise<Record<string, string> | null> {
  // The AI runs only a template about the ticket's organization (also a CHECK of the table, and
  // `templateForAi` leaves the others out): defence in depth if one reaches here.
  if (!templatePlaceholders(body).includes('org_id')) return null;
  if (templateInputParams(body).length > 0) return null;
  const orgId = await orgOfTicket(db, ticketId);
  if (orgId === null) return null;
  const all: Record<string, string> = { org_id: orgId, ticket_id: ticketId };
  return Object.fromEntries(templatePlaceholders(body).map((name) => [name, all[name] ?? '']));
}

export function createLogsToolPort(
  db: Reader,
  clients: Pick<ToolClients, 'logs'>,
  now: () => Date = () => new Date(),
): LogsToolPort | undefined {
  const logs = clients.logs;
  if (logs === undefined) return undefined;
  return {
    mock: isMockSource(logs.source),
    async run(input) {
      if (input.intentKey === null || input.ticketId === null) {
        return { items: [], note: 'No intent in scope.' };
      }
      const template = await templateForAi(db, input.intentKey, 'logs');
      if (template === null) return { items: [], note: 'No log template for this intent.' };
      const params = await ticketParams(db, template.body, input.ticketId);
      if (params === null)
        return { items: [], note: 'The log template cannot run without a person.' };
      const run = await runLogsTemplate(logs, {
        body: template.body,
        params,
        window: { now: now(), windowMinutes: input.windowMinutes },
        limit: input.limit,
        signal: input.signal,
      });
      return {
        items: run.entries.map((entry) => ({
          timestamp: entry.timestamp,
          severity: entry.severity,
          service: entry.service.slice(0, 100),
          message: entry.message.slice(0, 600),
        })),
      };
    },
  };
}

const cell = (value: string | number | boolean | null): ToolDataCell => {
  if (value === null || typeof value === 'number') return value;
  return String(value).slice(0, 200);
};

export function createDataToolPort(
  db: Reader,
  clients: Pick<ToolClients, 'data' | 'dataMock'>,
): DataToolPort | undefined {
  const data = clients.data;
  if (data === undefined) return undefined;
  return {
    mock: clients.dataMock ?? true,
    async run(input) {
      if (input.intentKey === null || input.ticketId === null) {
        return { columns: [], items: [], note: 'No intent in scope.' };
      }
      const template = await templateForAi(db, input.intentKey, 'data');
      if (template === null) {
        return { columns: [], items: [], note: 'No query template for this intent.' };
      }
      const params = await ticketParams(db, template.body, input.ticketId);
      if (params === null) {
        return { columns: [], items: [], note: 'The query template cannot run without a person.' };
      }
      const result = await runDataTemplate(data(template.allowedColumns), {
        name: template.name,
        body: template.body,
        params,
        maxRows: input.limit,
        timeoutMs: DATA_RUN_TIMEOUT_MS,
        signal: input.signal,
      });
      return {
        columns: result.columns.map((name) => name.slice(0, 60)),
        items: result.rows.map((row) => row.map(cell)),
        ...(result.masked.length === 0
          ? {}
          : { note: `${String(result.masked.length)} column(s) hidden by the allow-list.` }),
      };
    },
  };
}

export function createRepoToolPort(
  db: Reader,
  clients: Pick<ToolClients, 'repo'>,
  now: () => Date = () => new Date(),
): RepoToolPort | undefined {
  const repo = clients.repo;
  if (repo === undefined) return undefined;
  return {
    mock: isMockSource(repo.source),
    async run(input) {
      // The runbook names the service by the intent key (snake_case) until a ticket knows its service;
      // a catalog slug is kebab-case, so both spellings are tried. `[ASSUMED]`
      const wanted = input.service.toLowerCase();
      const [service] = await db
        .select({ id: schema.service.id, slug: schema.service.slug, repos: schema.service.repos })
        .from(schema.service)
        .where(
          and(
            sql`lower(${schema.service.slug}) IN (${wanted}, ${wanted.replaceAll('_', '-')})`,
            eq(schema.service.active, true),
          ),
        )
        .limit(1);
      if (service === undefined) return { items: [], note: 'No such service in the catalog.' };
      const until = now();
      const since = new Date(until.getTime() - input.windowHours * 3_600_000);
      const changes: ToolRepoChange[] = [];
      for (const name of service.repos.slice(0, MAX_REPOS)) {
        for (const change of await repo.listChanges({
          repo: name,
          since,
          until,
          limit: REPO_CHANGES_PER_REPO,
          signal: input.signal,
        })) {
          changes.push({
            kind: change.kind,
            ref: change.ref.slice(0, 100),
            title: (change.title ?? '').slice(0, 300),
            at: change.at,
            ...(change.url === null ? {} : { url: change.url.slice(0, 500) }),
          });
        }
      }
      // Deploys the CI told us about come from our own table: they exist even when no repo is connected.
      const deploys = await db
        .select({
          version: schema.deploy.version,
          env: schema.deploy.env,
          at: schema.deploy.occurredAt,
          url: schema.deploy.url,
        })
        .from(schema.deploy)
        .where(and(eq(schema.deploy.serviceId, service.id), gte(schema.deploy.occurredAt, since)))
        .orderBy(desc(schema.deploy.occurredAt))
        .limit(REPO_CHANGES_PER_REPO);
      for (const deploy of deploys) {
        if (deploy.at === null) continue;
        changes.push({
          kind: 'deploy',
          ref: deploy.version.slice(0, 100),
          title: `Deploy ${deploy.version} to ${deploy.env}`.slice(0, 300),
          at: deploy.at.toISOString(),
          ...(deploy.url === null ? {} : { url: deploy.url.slice(0, 500) }),
        });
      }
      return {
        items: changes.toSorted((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 50),
      };
    },
  };
}

/** The three ports over the clients that exist; a missing client leaves its tool unregistered. */
export function createSystemToolPorts(
  db: Reader,
  clients: ToolClients,
  now?: () => Date,
): SystemToolPorts {
  return {
    logs: createLogsToolPort(db, clients, now),
    data: createDataToolPort(db, clients),
    repo: createRepoToolPort(db, clients, now),
  };
}
