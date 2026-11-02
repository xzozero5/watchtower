import type { RepoChange } from '@watchtower/shared';

import { ConnectorQueryRejectedError, MinuteQuota, type Clock } from '../common/errors.js';
import { MAX_REPO_LIMIT, REPO_NAME_PATTERN, type RepoClient, type RepoQuery } from './types.js';

export interface FakeRepoOptions {
  /** Requests a minute before the fake answers 429. 0 or absent: no quota. */
  readonly quotaPerMinute?: number;
  readonly clock?: Clock;
  /** Changes computed when asked (relative to now), on top of those added by hand. */
  readonly changes?: (nowMs: number) => readonly RepoChange[];
}

/** Changes from an array, per repository. No network, no token. */
export class FakeRepoClient implements RepoClient {
  readonly source = 'fake' as const;
  readonly queries: RepoQuery[] = [];
  readonly #changes = new Map<string, RepoChange[]>();
  readonly #quota: MinuteQuota;
  readonly #clock: Clock;
  readonly #provider: ((nowMs: number) => readonly RepoChange[]) | undefined;

  constructor(options: FakeRepoOptions = {}) {
    this.#clock = options.clock ?? Date.now;
    this.#quota = new MinuteQuota(options.quotaPerMinute ?? 0, this.#clock);
    this.#provider = options.changes;
  }

  add(change: RepoChange): void {
    const list = this.#changes.get(change.repo) ?? [];
    list.push(change);
    this.#changes.set(change.repo, list);
  }

  listChanges(query: RepoQuery): Promise<RepoChange[]> {
    this.queries.push(query);
    try {
      this.#quota.take();
      if (!REPO_NAME_PATTERN.test(query.repo)) {
        throw new ConnectorQueryRejectedError('repo must be owner/name');
      }
      if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_REPO_LIMIT) {
        throw new ConnectorQueryRejectedError(`limit must be 1 to ${String(MAX_REPO_LIMIT)}`);
      }
      if (query.since.getTime() > query.until.getTime()) {
        throw new ConnectorQueryRejectedError('since is after until');
      }
      const found = [
        ...(this.#changes.get(query.repo) ?? []),
        ...(this.#provider?.(this.#clock()) ?? []),
      ]
        .filter((change) => change.repo === query.repo)
        .filter((change) => {
          const at = Date.parse(change.at);
          return at >= query.since.getTime() && at <= query.until.getTime();
        })
        .toSorted((a, b) => Date.parse(b.at) - Date.parse(a.at));
      return Promise.resolve(found.slice(0, query.limit));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('fake repo failure'));
    }
  }
}
