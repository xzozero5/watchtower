import { createGuardedSqlClient, withDataGuardrails } from './data/guard.js';
import type { DataQueryClient, SqlExecutor } from './data/types.js';
import type { LogsClient } from './logs/types.js';
import type { MetricsClient } from './metrics/types.js';
import { createMockClients, loadMockFixtures } from './mock.js';
import type { RepoClient } from './repo/types.js';

/**
 * The systems the tools of a deployment reach, as `apps/api` (a person's buttons) and `apps/worker`
 * (the AI's tools) both assemble them. Each is absent when it is not connected. Every client is
 * read-only by type (N2); there is no live adapter before T-208, so the logs, metrics and repository
 * clients are fakes over `fixtures.json`, and the data client is the product database behind its
 * read-only login (the invented `product_mock` in development) or a fake over the same fixtures.
 */
export interface ToolClients {
  readonly logs?: LogsClient | undefined;
  readonly metrics?: MetricsClient | undefined;
  readonly repo?: RepoClient | undefined;
  /**
   * The data client with the global column allow-list plus the columns a template allows for itself,
   * behind the guardrails (reads only, row cap, timeout, column masking).
   */
  readonly data?: ((extraColumns: readonly string[]) => DataQueryClient) | undefined;
  /** The data is invented (a sandbox or a fake): results are labelled mock. */
  readonly dataMock?: boolean | undefined;
  /** Releases what the clients hold (the product database pool). */
  close?(): Promise<void>;
}

export interface ToolClientOptions {
  /** A directory with `fixtures.json` (`AI_TOOL_FIXTURES_DIR`). Absent: logs, metrics and repository are not connected. */
  readonly fixturesDir: string | undefined;
  /** The product database, behind its read-only login. Absent: the data tool uses the fixtures, or is not connected. */
  readonly productDb?: (SqlExecutor & { readonly sandbox: boolean; close(): Promise<void> }) | undefined;
  /** Result columns that may be shown (the global allow-list). */
  readonly allowColumns: readonly string[];
}

export function assembleToolClients(options: ToolClientOptions): ToolClients {
  const fixtures = loadMockFixtures(options.fixturesDir);
  const mock = fixtures === undefined ? undefined : createMockClients(fixtures);
  const allowed = (extra: readonly string[]): ReadonlySet<string> =>
    new Set([...options.allowColumns, ...extra]);

  const executor = options.productDb;
  if (executor !== undefined) {
    return {
      logs: mock?.logs,
      metrics: mock?.metrics,
      repo: mock?.repo,
      data: (extra) => createGuardedSqlClient(executor, { allowColumns: allowed(extra) }),
      dataMock: executor.sandbox,
      close: () => executor.close(),
    };
  }
  return {
    logs: mock?.logs,
    metrics: mock?.metrics,
    repo: mock?.repo,
    data:
      mock === undefined
        ? undefined
        : (extra) => withDataGuardrails(mock.data, { allowColumns: allowed(extra) }),
    dataMock: true,
  };
}
