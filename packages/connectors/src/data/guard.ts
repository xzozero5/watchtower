import {
  ConnectorError,
  ConnectorQueryRejectedError,
  ConnectorTimeoutError,
} from '../common/errors.js';
import { checkParams, hasStrayBraces, placeholdersOf } from '../common/template.js';
import {
  DATA_DEFAULT_MAX_ROWS,
  DATA_DEFAULT_TIMEOUT_MS,
  DATA_HARD_MAX_ROWS,
  DATA_SYSTEM_MAX_ROWS,
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
  'nextval',
  'setval',
  'lo_import',
  'lo_export',
  'dblink',
  'dblink_exec',
];
const FORBIDDEN = new RegExp(`\\b(?:${FORBIDDEN_WORDS.join('|')})\\b`, 'i');
/** Families of functions that lock, write WAL, read files or control backends, by prefix (a courtesy: the database revokes them). */
const FORBIDDEN_FAMILIES =
  /\b(?:pg_(?:try_)?advisory|pg_logical|pg_replication|pg_notify|pg_read|pg_ls|pg_stat_file|pg_current_wal|pg_current_xact|pg_xact|pg_wal|pg_switch|pg_cancel|pg_terminate|pg_sleep|pg_import|pg_export|txid_|lo_(?:import|export|open|create|creat|unlink|read|write|from_bytea|get|put)|dblink)\w*/i;

/**
 * Reduces a statement to its code the way Postgres reads it: a `--` comment ends at a line feed or a
 * carriage return, `/* *\/` comments nest, `'...'` and `E'...'` strings are emptied (an `E` string
 * takes a backslash as an escape), and `"..."` identifiers are emptied too, so a word inside any of
 * them neither hides a keyword nor trips the check. A dollar-quoted string or an unterminated
 * literal, identifier or comment is refused.
 *
 * This text check is defence in depth and a courtesy (a clear message before the database is asked).
 * It is not what keeps the data tool read-only: the executor runs one statement as a cursor in a
 * read-only transaction under a role that can read nothing else (T-203c, ADR-016). Anything this
 * check cannot see therefore still cannot write.
 */
function codeOf(sql: string): string {
  let out = '';
  let index = 0;
  while (index < sql.length) {
    const char = sql[index] ?? '';
    const next = sql[index + 1] ?? '';
    if (char === '-' && next === '-') {
      while (index < sql.length && sql[index] !== '\n' && sql[index] !== '\r') index += 1;
      out += ' ';
      continue;
    }
    if (char === '/' && next === '*') {
      let depth = 1;
      index += 2;
      while (index < sql.length && depth > 0) {
        if (sql[index] === '/' && sql[index + 1] === '*') {
          depth += 1;
          index += 2;
        } else if (sql[index] === '*' && sql[index + 1] === '/') {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      if (depth > 0) throw new ConnectorQueryRejectedError('Unterminated comment');
      out += ' ';
      continue;
    }
    if (char === "'") {
      // `E'...'` (not the tail of a longer word) reads a backslash as an escape.
      const before = out.at(-1) ?? ' ';
      const escapes = /[eE]/.test(before) && !/[A-Za-z0-9_$]/.test(out.at(-2) ?? ' ');
      index += 1;
      let closed = false;
      while (index < sql.length) {
        if (escapes && sql[index] === '\\') {
          index += 2;
          continue;
        }
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
    if (char === '"') {
      index += 1;
      const start = index;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === '"' && sql[index + 1] === '"') {
          index += 2;
          continue;
        }
        if (sql[index] === '"') {
          closed = true;
          index += 1;
          break;
        }
        index += 1;
      }
      if (!closed) throw new ConnectorQueryRejectedError('Unterminated identifier');
      // Keep what the identifier says: "dblink"(...) is a call to dblink, and the word check must see it.
      out += ` ${sql.slice(start, index - 1).replaceAll('""', '"')} `;
      continue;
    }
    if (char === '$' && (next === '$' || /[A-Za-z_]/.test(next))) {
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
  if (FORBIDDEN.test(code) || FORBIDDEN_FAMILIES.test(code)) {
    throw new ConnectorQueryRejectedError('The statement holds a word that is not allowed');
  }
  if (/\bfor\s+(?:update|share|no\s+key\s+update|key\s+share)\b/i.test(code)) {
    throw new ConnectorQueryRejectedError('Row locks are not allowed');
  }
}

/** Functions and forms that build a huge value out of a small statement (T-207a C-1). */
const MEMORY_HOGS =
  /\b(?:repeat|lpad|rpad|array_fill|string_agg|array_agg)\b|\bwith\s+recursive\b/i;

/**
 * A statement a person wrote on the spot (not a saved template) may not use the forms that make the
 * server build one enormous value: `repeat`, `lpad`, `rpad`, `array_fill`, `string_agg`, `array_agg`,
 * `WITH RECURSIVE`. A courtesy for a clear message, not a barrier: Postgres has no per-statement memory
 * limit, so what really bounds the damage is the memory limit of the server that answers (ADR-016 5e)
 * and the flag that keeps ad-hoc data off by default. Saved templates, which a head wrote and saved,
 * are not held to it.
 */
export function assertAdhocSql(sql: string): void {
  const code = codeOf(sql);
  if (MEMORY_HOGS.test(code)) {
    throw new ConnectorQueryRejectedError(
      'The statement uses a function that can build a very large value (repeat, lpad, rpad, array_fill, string_agg, array_agg, WITH RECURSIVE); use a saved template for that',
    );
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
  const sql = template.replaceAll(
    /\{\{([a-z][a-z0-9_]{0,30})\}\}/g,
    (_all, name: string) => `$${String(names.indexOf(name) + 1)}`,
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
  // A person gets at most DATA_HARD_MAX_ROWS; a caller that is the system (the usage scheduler) may ask the guard for more.
  const ceiling = Math.min(guard.maxRows ?? DATA_HARD_MAX_ROWS, DATA_SYSTEM_MAX_ROWS);
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

/** What a Postgres error means to a caller. The message of the database is not passed on: it can name columns and values. */
function translateDatabaseError(error: unknown): Error {
  const code = (error as { code?: unknown } | null)?.code;
  switch (code) {
    case '57014': // query_canceled: statement_timeout
    case '55P03': // lock_not_available
      return new ConnectorTimeoutError();
    case 'WT002': // the executor: more bytes than a result may carry
      return new ConnectorQueryRejectedError(
        'The result is larger than the limit; ask for fewer rows or columns',
      );
    case '53000':
    case '53100': // disk_full
    case '53200': // out_of_memory
    case '53300':
    case '53400': // configuration_limit_exceeded: temp_file_limit
    case '54000': // program_limit_exceeded
    case '54001':
    case '54011':
    case '54023':
      return new ConnectorQueryRejectedError(
        'The statement needs more resources than a run may use',
      );
    case '42501': // insufficient_privilege: a column the login may not read
      return new ConnectorQueryRejectedError('The database login may not read that');
    case '42601': // syntax_error
    case '42703': // undefined_column
    case '42P01': // undefined_table
    case '42883': // undefined_function
    case '22P02': // invalid_text_representation
    case '25006': // read_only_sql_transaction
      return new ConnectorQueryRejectedError(`The database refused the statement (${code})`);
    default:
      return new ConnectorError('upstream', 'The database could not answer');
  }
}

/** A client over an executor (the database side). `sandbox` marks invented data in a real engine. */
export function createSqlDataQueryClient(
  executor: SqlExecutor,
  source: 'sandbox' | 'live',
): DataQueryClient {
  return {
    source,
    async query(query) {
      try {
        const raw = await executor.execute({
          sql: query.sql,
          params: query.params,
          maxRows: query.maxRows,
          timeoutMs: query.timeoutMs,
          signal: query.signal,
        });
        return { ...raw, masked: [] };
      } catch (error) {
        throw translateDatabaseError(error);
      }
    },
  };
}

/**
 * The data client of a deployment: an executor over the product database, behind the guardrails.
 * Labelled `sandbox` when the executor says its data is invented (the `product_mock` database).
 */
export function createGuardedSqlClient(
  executor: SqlExecutor & { readonly sandbox: boolean },
  guard: DataGuardrails,
): DataQueryClient {
  return withDataGuardrails(
    createSqlDataQueryClient(executor, executor.sandbox ? 'sandbox' : 'live'),
    guard,
  );
}
