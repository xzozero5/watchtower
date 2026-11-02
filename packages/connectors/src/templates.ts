import { TOOL_AUTO_PARAMS, type ToolKind } from '@watchtower/shared';

import { ConnectorQueryRejectedError } from './common/errors.js';
import { hasStrayBraces, placeholdersOf } from './common/template.js';
import { assertReadOnlySql, bindSqlTemplate } from './data/guard.js';
import type { DataQueryClient, DataResult } from './data/types.js';
import { parseLogFilter, renderLogFilter } from './logs/filter.js';
import type { LogEntry, LogsClient } from './logs/types.js';

/**
 * Saved templates (R-5.1, R-5.2) turned into calls. A template is a body with `{{name}}` placeholders:
 * the ticket fills `org_id` and `ticket_id`, a person types the rest. These functions are the one
 * place a body becomes a filter or a statement, whoever asks (a person's button, the AI's tool).
 */

const AUTO: ReadonlySet<string> = new Set(TOOL_AUTO_PARAMS);

/** Every placeholder of a body. */
export const templatePlaceholders = (body: string): string[] => placeholdersOf(body);

/** The placeholders a person must give: those the ticket does not fill. */
export const templateInputParams = (body: string): string[] =>
  placeholdersOf(body).filter((name) => !AUTO.has(name));

/**
 * Throws `ConnectorQueryRejectedError` when a body could never run: a filter that does not parse, a
 * statement that is not a read (or holds `EXTERNAL_QUERY`), a malformed placeholder, or too many
 * placeholders. Called when a template is saved, so a head sees the mistake then and not at 3 a.m.
 */
export function validateTemplate(kind: ToolKind, body: string): void {
  if (hasStrayBraces(body)) {
    throw new ConnectorQueryRejectedError('The body has a malformed placeholder');
  }
  const names = placeholdersOf(body);
  const sample = Object.fromEntries(names.map((name) => [name, 'sample']));
  if (kind === 'logs') {
    parseLogFilter(renderLogFilter(body, sample));
  } else {
    assertReadOnlySql(bindSqlTemplate(body, sample).sql);
  }
}

export interface TemplateRunWindow {
  readonly now: Date;
  readonly windowMinutes: number;
}

export interface LogsTemplateRun {
  readonly entries: readonly LogEntry[];
  readonly hasMore: boolean;
  readonly from: Date;
  readonly to: Date;
}

/** Renders the filter and reads one page: one request against the logging quota. */
export async function runLogsTemplate(
  client: LogsClient,
  input: {
    readonly body: string;
    readonly params: Readonly<Record<string, string>>;
    readonly window: TemplateRunWindow;
    readonly limit: number;
    readonly signal?: AbortSignal | undefined;
  },
): Promise<LogsTemplateRun> {
  const filter = renderLogFilter(input.body, input.params);
  const to = input.window.now;
  const from = new Date(to.getTime() - input.window.windowMinutes * 60_000);
  const page = await client.listEntries({
    filter,
    from,
    to,
    pageSize: input.limit,
    order: 'desc',
    signal: input.signal,
  });
  return { entries: page.entries, hasMore: page.nextPageToken !== null, from, to };
}

/** Binds the parameters and runs the statement through the (guarded) data client. */
export async function runDataTemplate(
  client: DataQueryClient,
  input: {
    readonly name: string;
    readonly body: string;
    readonly params: Readonly<Record<string, string>>;
    readonly maxRows: number;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal | undefined;
  },
): Promise<DataResult> {
  const bound = bindSqlTemplate(input.body, input.params);
  return client.query({
    label: input.name,
    sql: bound.sql,
    params: bound.values,
    maxRows: input.maxRows,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  });
}

/** One line a person reads, with the log line's text as the provider wrote it. */
export function formatLogLine(entry: LogEntry): string {
  return `${entry.timestamp} ${entry.severity} ${entry.service}: ${entry.message}`;
}

/** A header and one line per row, cells joined by ` | `; a masked or empty cell is `-`. */
export function formatRows(result: DataResult, maxLines: number): string {
  const lines = [result.columns.join(' | ')];
  for (const row of result.rows.slice(0, maxLines)) {
    lines.push(row.map((cell) => (cell === null ? '-' : String(cell))).join(' | '));
  }
  return lines.join('\n');
}
