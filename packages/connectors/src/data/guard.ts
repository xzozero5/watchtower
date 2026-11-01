import { ConnectorQueryRejectedError } from '../common/errors.js';
import { checkParams, hasStrayBraces, placeholdersOf } from '../common/template.js';
import {
  DATA_DEFAULT_MAX_ROWS,
  DATA_DEFAULT_TIMEOUT_MS,
  DATA_HARD_MAX_ROWS,
  DATA_HARD_TIMEOUT_MS,
  DATA_MAX_SQL_CHARS,
  type DataQuery,
  type DataQueryClient,
  type DataResult,
  type SqlExecutor,
  type SqlValue,
} from './types.js';

/** `EXTERNAL_QUERY` reaches a second database through BigQuery, past every limit set here (po decision 2). Off. */
export const EXTERNAL_QUERY_ENABLED = false as const;

const FORBIDDEN_WORDS = [
  'insert',
  'update',
  'delete',
  'merge',
  'drop',
  'alter',
  'create',
  'truncate',
  'grant',
  'revoke',
  'copy',
  'call',
  'do',
  'execute',
  'prepare',
  'vacuum',
  'analyze',
  'reindex',
  'cluster',
  'refresh',
  'comment',
  'lock',
  'listen',
  'notify',
  'set',
  'reset',
  'show',
  'begin',
  'commit',
  'rollback',
  'savepoint',
  'into',
  'external_query',
  'pg_sleep',
  'pg_read_file',
  'pg_read_binary_file',
  'pg_ls_dir',
  'pg_terminate_backend',
  'pg_cancel_backend',
  'set_config',
  'lo_import',
  'lo_export',
  'dblink',
  'dblink_exec',
];
const FORBIDDEN = new RegExp(`\\b(?:${FORBIDDEN_WORDS.join('|')})\\b`, 'i');

/**
 * Reduces a statement to its code: comments are removed and string literals emptied, so a word inside
 * a literal or a comment neither hides a keyword nor trips the check. A dollar-quoted string, a
 * quoted identifier that holds a quote, or an unterminated literal is refused.
 */
function codeOf(sql: string): string {
  let out = '';
  let index = 0;
  while (index < sql.length) {
    const char = sql[index] ?? '';
    const next = sql[index + 1] ?? '';
    if (char === '-' && next === '-') {
      while (index < sql.length && sql[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2);
      if (end === -1) throw new ConnectorQueryRejectedError('Unterminated comment');
      out += ' ';
      index = end + 2;
      continue;
    }
    if (char === "'") {
      index += 1;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === "'" && sql[index + 1] === "'") {
          index += 2;
          continue;
        }
        if (sql[index] === "'") {
          closed = true;
          index += 1;
          break;
        }
        index += 1;
      }
      if (!closed) throw new ConnectorQueryRejectedError('Unterminated string');
      out += "''";
      continue;
    }
    if (char === '$' && /[A-Za-z_]/.test(next)) {
      throw new ConnectorQueryRejectedError('Dollar-quoted strings are not allowed');
    }
    if (char === '$' && next === '$') {
      throw new ConnectorQueryRejectedError('Dollar-quoted strings are not allowed');
    }
    out += char;
    index += 1;
  }
  return out;
}

/**
 * One statement that reads: `SELECT` or `WITH ... SELECT`, no second statement, none of the words
 * that write, change settings or reach outside. This is defence in depth: the real barrier is the
 * read-only transaction and the database login behind the executor.
 */
export function assertReadOnlySql(sql: string): void {
  if (sql.length === 0 || sql.length > DATA_MAX_SQL_CHARS) {
    throw new ConnectorQueryRejectedError('The statement is empty or too long');
  }
  const code = codeOf(sql).trim().replace(/;\s*$/, '');
  if (code.includes(';')) throw new ConnectorQueryRejectedError('Only one statement is allowed');
  if (!/^(?:select|with)\b/i.test(code)) {
    throw new ConnectorQueryRejectedError('Only SELECT statements are allowed');
  }
  if (/\bexternal_query\b/i.test(code) && !(EXTERNAL_QUERY_ENABLED as boolean)) {
    throw new ConnectorQueryRejectedError('EXTERNAL_QUERY is turned off');
  }
  if (FORBIDDEN.test(code)) {
    throw new ConnectorQueryRejectedError('The statement holds a word that is not allowed');
  }
  if (/\bfor\s+(?:update|share|no\s+key\s+update|key\s+share)\b/i.test(code)) {
    throw new ConnectorQueryRejectedError('Row locks are not allowed');
  }
}

/**
 * Fills `{{name}}` placeholders of a saved SQL template with bind parameters (`$1..`). The values
 * travel as parameters, never inside the text.
 */
export function bindSqlTemplate(
  template: string,
  params: Readonly<Record<string, string>>,
): { readonly sql: string; readonly values: readonly SqlValue[] } {
  if (hasStrayBraces(template)) {
    throw new ConnectorQueryRejectedError('The template has a malformed placeholder');
  }
  const names = placeholdersOf(template);
  checkParams(names, params);
  const sql = template.replaceAll(/\{\{([a-z][a-z0-9_]{0,30})\}\}/g, (_all, name: string) =>
    `$${String(names.indexOf(name) + 1)}`,
  );
  return { sql, values: names.map((name) => params[name] ?? '') };
}

export interface DataGuardrails {
  /**
   * Result columns whose values may be shown (lower case, the name the statement gives the column).
   * Any other column is masked: its cells come back null and its name is listed in `masked`
   * (PII columns are hidden by default, R-5.2).
   */
  readonly allowColumns: ReadonlySet<string>;
  readonly maxRows?: number;
  readonly timeoutMs?: number;
}

/**
 * Wraps a client with the checks that do not depend on the database: the statement must be a read,
 * the row cap and timeout are clamped, and columns that are not on the allow-list are masked.
 */
export function withDataGuardrails(inner: DataQueryClient, guard: DataGuardrails): DataQueryClient {
  const ceiling = Math.min(guard.maxRows ?? DATA_HARD_MAX_ROWS, DATA_HARD_MAX_ROWS);
  const timeout = Math.min(guard.timeoutMs ?? DATA_HARD_TIMEOUT_MS, DATA_HARD_TIMEOUT_MS);
  return {
    source: inner.source,
    async query(query: DataQuery): Promise<DataResult> {
      assertReadOnlySql(query.sql);
      const params = query.params;
      const dollars = [...query.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
      if (dollars.some((n) => n < 1 || n > params.length) || params.length > 20) {
        throw new ConnectorQueryRejectedError('Bind parameters do not match the statement');
      }
      const maxRows = Math.max(1, Math.min(query.maxRows || DATA_DEFAULT_MAX_ROWS, ceiling));
      const timeoutMs = Math.max(
        100,
        Math.min(query.timeoutMs || DATA_DEFAULT_TIMEOUT_MS, timeout),
      );
      const result = await inner.query({ ...query, maxRows, timeoutMs });
      const hide = result.columns.map((name) => !guard.allowColumns.has(name.toLowerCase()));
      const masked = result.columns.filter((_name, i) => hide[i] === true);
      return {
        columns: result.columns,
        rows: result.rows
          .slice(0, maxRows)
          .map((row) => row.map((cell, i) => (hide[i] === true ? null : cell))),
        truncated: result.truncated || result.rows.length > maxRows,
        masked: [...new Set([...result.masked, ...masked])],
      };
    },
  };
}

/** A client over an executor (the database side). `sandbox` marks invented data in a real engine. */
export function createSqlDataQueryClient(
  executor: SqlExecutor,
  source: 'sandbox' | 'live',
): DataQueryClient {
  return {
    source,
    async query(query) {
      const raw = await executor.execute({
        sql: query.sql,
        params: query.params,
        maxRows: query.maxRows,
        timeoutMs: query.timeoutMs,
        signal: query.signal,
      });
      return { ...raw, masked: [] };
    },
  };
}
