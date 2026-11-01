import {
  createGuardedSqlClient,
  createMockClients,
  isMockSource,
  loadMockFixtures,
  withDataGuardrails,
  type DataQueryClient,
  type LogsClient,
  type MetricsClient,
  type RepoClient,
} from '@watchtower/connectors';
import { createProductDbExecutor } from '@watchtower/db';
import { DATA_COLUMN_ALLOW_LIST } from '@watchtower/shared';

import type { ApiConfig } from '../config/config.js';

/** DI token of the read-only clients (T-203a). A test replaces it with its own fakes. */
export const TOOL_CLIENTS = Symbol('TOOL_CLIENTS');

/**
 * The systems a person's button can reach. Each is absent when it is not connected: the route then
 * answers 503 and the button reports `connected: false`. Every client is read-only by type (N2).
 */
export interface ToolClients {
  readonly logs?: LogsClient | undefined;
  readonly metrics?: MetricsClient | undefined;
  readonly repo?: RepoClient | undefined;
  /**
   * The data client with the global allow-list plus the columns a template allows for itself, behind
   * the guardrails (read-only statements, row cap, timeout, column masking).
   */
  readonly data?: ((extraColumns: readonly string[]) => DataQueryClient) | undefined;
  /** Where the data client's answers come from, for the `mock` flag. */
  readonly dataMock?: boolean | undefined;
  close?(): Promise<void>;
}

export const clientIsMock = (client: { readonly source: 'fake' | 'sandbox' | 'live' }): boolean =>
  isMockSource(client.source);

/**
 * Builds the clients from the environment. Nothing reaches an outside service: the logs, metrics and
 * repository clients are fakes over `AI_TOOL_FIXTURES_DIR/fixtures.json` (there is no live adapter
 * before T-208), and the data client is the product database behind `PRODUCT_DB_URL`, or a fake over
 * the same fixtures when only those are given.
 */
export function buildToolClients(
  config: Pick<ApiConfig, 'AI_TOOL_FIXTURES_DIR' | 'PRODUCT_DB_URL'>,
): ToolClients {
  const fixtures = loadMockFixtures(config.AI_TOOL_FIXTURES_DIR);
  const mock = fixtures === undefined ? undefined : createMockClients(fixtures);
  const allowed = (extra: readonly string[]): ReadonlySet<string> =>
    new Set([...DATA_COLUMN_ALLOW_LIST, ...extra]);

  if (config.PRODUCT_DB_URL !== undefined) {
    const executor = createProductDbExecutor({
      url: config.PRODUCT_DB_URL,
      applicationName: 'watchtower-api-tools',
    });
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
