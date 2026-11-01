import type { RepoChange } from '@watchtower/shared';

import type { ClientSource } from '../common/errors.js';

/**
 * Read-only access to a repository host (R-5.3): commits, merged pull requests, releases. One
 * method, and it lists. The incident view (`apps/api`, T-202d) needs the same call, so this is the
 * client that port is adapted from. The live adapter (T-208) is `[ASK-HUMAN]`.
 */

export interface RepoQuery {
  /** `owner/name`. */
  readonly repo: string;
  readonly since: Date;
  readonly until: Date;
  /** 1 to `MAX_REPO_LIMIT`. */
  readonly limit: number;
  readonly signal?: AbortSignal | undefined;
}

export const MAX_REPO_LIMIT = 100;
export const REPO_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

export interface RepoClient {
  readonly source: ClientSource;
  /** Changes with `at` in `[since, until]`, newest first, at most `limit`. */
  listChanges(query: RepoQuery): Promise<RepoChange[]>;
}
