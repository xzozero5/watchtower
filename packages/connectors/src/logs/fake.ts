import {
  ConnectorQueryRejectedError,
  ConnectorTimeoutError,
  MinuteQuota,
  type Clock,
} from '../common/errors.js';
import { matchesLogFilter, parseLogFilter } from './filter.js';
import {
  MAX_LOG_PAGE,
  MAX_LOG_RANGE_MS,
  type LogEntry,
  type LogPage,
  type LogQuery,
  type LogsClient,
} from './types.js';

export interface FakeLogsOptions {
  readonly entries?: readonly LogEntry[] | ((nowMs: number) => readonly LogEntry[]);
  /**
   * Requests a minute before the fake answers 429, counted on `clock` (Logging allows 60 reads a
   * minute a project, PRD R-5.1). 0 or absent: no quota.
   */
  readonly quotaPerMinute?: number;
  readonly clock?: Clock;
}

/**
 * Logs from an array, with the quota of the real API when asked for. It reads the filter with the
 * same parser the templates are checked with, so a filter that would be refused live is refused here.
 * No network, no credential.
 */
export class FakeLogsClient implements LogsClient {
  readonly source = 'fake' as const;
  /** Every query received, in order (the queries a test makes assertions on). */
  readonly queries: LogQuery[] = [];
  readonly #added: LogEntry[] = [];
  readonly #base: (nowMs: number) => readonly LogEntry[];
  readonly #quota: MinuteQuota;
  readonly #clock: Clock;
  /** Requests that got past the quota check. */
  served = 0;

  constructor(options: FakeLogsOptions = {}) {
    const entries = options.entries ?? [];
    this.#base = typeof entries === 'function' ? entries : () => entries;
    this.#clock = options.clock ?? Date.now;
    this.#quota = new MinuteQuota(options.quotaPerMinute ?? 0, this.#clock);
  }

  add(...entries: readonly LogEntry[]): void {
    this.#added.push(...entries);
  }

  listEntries(query: LogQuery): Promise<LogPage> {
    this.queries.push(query);
    try {
      if (query.signal?.aborted === true) throw new ConnectorTimeoutError();
      this.#quota.take();
      this.served += 1;
      return Promise.resolve(this.#page(query));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('fake logs failure'));
    }
  }

  #page(query: LogQuery): LogPage {
    if (!Number.isInteger(query.pageSize) || query.pageSize < 1 || query.pageSize > MAX_LOG_PAGE) {
      throw new ConnectorQueryRejectedError(`pageSize must be 1 to ${String(MAX_LOG_PAGE)}`);
    }
    const from = query.from.getTime();
    const to = query.to.getTime();
    if (!(from < to) || to - from > MAX_LOG_RANGE_MS) {
      throw new ConnectorQueryRejectedError('The time range is empty or longer than 7 days');
    }
    const terms = parseLogFilter(query.filter);
    const offset = decodeToken(query.pageToken);
    const direction = query.order === 'asc' ? 1 : -1;
    const found = [...this.#base(this.#clock()), ...this.#added]
      .filter((entry) => {
        const at = Date.parse(entry.timestamp);
        return at >= from && at < to && matchesLogFilter(entry, terms);
      })
      .toSorted((a, b) => direction * (Date.parse(a.timestamp) - Date.parse(b.timestamp)));
    const entries = found.slice(offset, offset + query.pageSize);
    const next = offset + entries.length;
    return { entries, nextPageToken: next < found.length ? encodeToken(next) : null };
  }
}

const encodeToken = (offset: number): string => Buffer.from(`o:${String(offset)}`).toString('base64url');

function decodeToken(token: string | undefined): number {
  if (token === undefined) return 0;
  const decoded = Buffer.from(token, 'base64url').toString('utf8');
  const match = /^o:(\d{1,9})$/.exec(decoded);
  if (match === null) throw new ConnectorQueryRejectedError('Unknown page token');
  return Number(match[1]);
}
