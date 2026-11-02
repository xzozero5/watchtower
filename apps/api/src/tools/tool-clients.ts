import { assembleToolClients, isMockSource, type ToolClients } from '@watchtower/connectors';
import { createProductDbExecutor } from '@watchtower/db';
import { DATA_COLUMN_ALLOW_LIST } from '@watchtower/shared';

import type { ApiConfig } from '../config/config.js';

export type { ToolClients };

/** DI token of the read-only clients (T-203a). A test replaces it with its own fakes. */
export const TOOL_CLIENTS = Symbol('TOOL_CLIENTS');

export const clientIsMock = (client: { readonly source: 'fake' | 'sandbox' | 'live' }): boolean =>
  isMockSource(client.source);

/**
 * The clients from the environment. Nothing reaches an outside service: logs, metrics and repository
 * are fakes over `AI_TOOL_FIXTURES_DIR`, and the data client is the product database behind
 * `PRODUCT_DB_URL` (or a fake over the same fixtures).
 */
export function buildToolClients(
  config: Pick<ApiConfig, 'AI_TOOL_FIXTURES_DIR' | 'PRODUCT_DB_URL'>,
): ToolClients {
  return assembleToolClients({
    fixturesDir: config.AI_TOOL_FIXTURES_DIR,
    productDb:
      config.PRODUCT_DB_URL === undefined
        ? undefined
        : createProductDbExecutor({
            url: config.PRODUCT_DB_URL,
            applicationName: 'watchtower-api-tools',
          }),
    allowColumns: DATA_COLUMN_ALLOW_LIST,
  });
}
