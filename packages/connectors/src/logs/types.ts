import type { ClientSource } from '../common/errors.js';

/**
 * Read-only access to Cloud Logging (R-5.1, N2). The interface has one method, and it lists: a method
 * that writes would not type-check against the contract test. The live adapter (T-208) is `[ASK-HUMAN]`.
 */

export const LOG_SEVERITIES = [
  'DEFAULT',
  'DEBUG',
  'INFO',
  'NOTICE',
  'WARNING',
  'ERROR',
  'CRITICAL',
  'ALERT',
  'EMERGENCY',
] as const;
export type LogSeverity = (typeof LOG_SEVERITIES)[number];

export interface LogEntry {
  /** Provider id; with the timestamp it identifies the entry. */
  readonly insertId: string;
  /** ISO 8601 UTC. */
  readonly timestamp: string;
  readonly severity: LogSeverity;
  readonly service: string;
  readonly message: string;
  /** Labels of the entry (org id, session id, ...). Values are text the product wrote: treat as personal data. */
  readonly labels: Readonly<Record<string, string>>;
}

export interface LogQuery {
  /**
   * A filter in the small subset of the Logging query language the templates use (see
   * `./filter.ts`): terms joined by `AND`. The time range is given apart, never inside the filter.
   */
  readonly filter: string;
  readonly from: Date;
  readonly to: Date;
  /** 1 to `MAX_LOG_PAGE`. */
  readonly pageSize: number;
  /** Newest first by default (what an investigator wants first). */
  readonly order?: 'asc' | 'desc';
  readonly pageToken?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface LogPage {
  readonly entries: readonly LogEntry[];
  /** Null on the last page. */
  readonly nextPageToken: string | null;
}

export const MAX_LOG_PAGE = 100;
/** The longest range one query may cover. */
export const MAX_LOG_RANGE_MS = 7 * 24 * 3600 * 1000;

export interface LogsClient {
  readonly source: ClientSource;
  /** One page of `entries.list`: one request against the quota (60 a minute a project, PRD R-5.1). */
  listEntries(query: LogQuery): Promise<LogPage>;
}
