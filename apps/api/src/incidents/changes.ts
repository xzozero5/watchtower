import type { RepoChange } from '@watchtower/shared';

/** DI token of the repository port; the module provides the in-memory fake until a live client exists. */
export const REPO_CHANGES = Symbol('REPO_CHANGES');

/**
 * Where the commits, merged pull requests and releases of a repository come from (R-5.3). The port is
 * read-only by construction (N2): its one method lists, and `repo-changes.test.ts` checks no method
 * name starts with a write verb. `source` says whether the answer is real; a fake never claims `live`.
 *
 * The real client is `RepoClient` of T-203a (`packages/connectors`, `[ASK-HUMAN]` for the token); this
 * port is what the incident view needs of it, so the two meet in one adapter later without the view
 * learning about GitHub.
 */
export interface RepoChangesPort {
  readonly source: 'none' | 'fake' | 'live';
  /**
   * Changes to `repo` (`owner/name`) with `at` in `[since, until]`, newest first, at most `limit`.
   * Rejects when the repository cannot be read; the caller then shows the deploys alone.
   */
  listChanges(input: {
    readonly repo: string;
    readonly since: Date;
    readonly until: Date;
    readonly limit: number;
  }): Promise<RepoChange[]>;
}

/** No repository connected: no changes, and the response says so. */
export const NO_REPO_CHANGES: RepoChangesPort = {
  source: 'none',
  listChanges: () => Promise.resolve([]),
};

/** An in-memory repository for mock mode and tests: scripted changes per repo, optional failure. */
export class FakeRepoChanges implements RepoChangesPort {
  readonly source = 'fake' as const;
  readonly calls: { repo: string; since: Date; until: Date; limit: number }[] = [];
  readonly #changes = new Map<string, RepoChange[]>();
  #failure: Error | null = null;

  /** Adds a change to `repo`. */
  add(change: RepoChange): void {
    const list = this.#changes.get(change.repo) ?? [];
    list.push(change);
    this.#changes.set(change.repo, list);
  }

  /** The next read rejects with `error`. */
  failNext(error: Error): void {
    this.#failure = error;
  }

  listChanges(input: {
    readonly repo: string;
    readonly since: Date;
    readonly until: Date;
    readonly limit: number;
  }): Promise<RepoChange[]> {
    this.calls.push({ ...input });
    if (this.#failure !== null) {
      const failure = this.#failure;
      this.#failure = null;
      return Promise.reject(failure);
    }
    const inWindow = (this.#changes.get(input.repo) ?? [])
      .filter((change) => {
        const at = Date.parse(change.at);
        return at >= input.since.getTime() && at <= input.until.getTime();
      })
      .toSorted((a, b) => Date.parse(b.at) - Date.parse(a.at));
    return Promise.resolve(inWindow.slice(0, input.limit));
  }
}
