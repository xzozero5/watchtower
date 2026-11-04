import { assembleToolClients } from '@watchtower/connectors';
import { createDatabase, createProductDbExecutor, type Database } from '@watchtower/db';
import { DATA_COLUMN_ALLOW_LIST, budgetProjectFor } from '@watchtower/shared';

import type { ProcessorContext } from '../processors/index.js';
import type { InvestigationDeps } from './investigation.js';
import { createSystemToolPorts } from './system-tool-ports.js';
import { readOnlyLoginProblems, systemToolsAllowed, type ReadDb } from './tool-ports.js';

/**
 * What an investigation (and a procedure simulation, T-303d) needs of the outside world: the clients of the logs,
 * data and repo tools, the read-only database login of the AI tools and its check (N2). Built once per consumer;
 * the returned function hands out the dependencies for one run.
 */
export function createInvestigationDepsFactory(
  context: ProcessorContext,
): () => Promise<InvestigationDeps> {
  const { database, ai, logger, realtime, config, domain } = context;
  // The clients the logs, data and repo tools read through (mock: fakes over the fixtures and the
  // local product database; no live adapter before T-208). A client that is not connected leaves its tool unregistered.
  const toolClients = assembleToolClients({
    fixturesDir: config.AI_TOOL_FIXTURES_DIR,
    productDb:
      config.PRODUCT_DB_URL === undefined
        ? undefined
        : createProductDbExecutor({
            url: config.PRODUCT_DB_URL,
            applicationName: `${config.OTEL_SERVICE_NAME}-product`,
          }),
    allowColumns: DATA_COLUMN_ALLOW_LIST,
  });
  const systems = createSystemToolPorts(database.db, toolClients);
  const budgetProject = budgetProjectFor(config.GCP_PROJECT_ID);
  const allowSystemTools = systemToolsAllowed(config);
  if (!allowSystemTools) {
    logger.warn(
      'No read-only database login for the AI tools: the logs, data and repo tools are off',
    );
  }

  // The AI tools' own read-only login, created on first use. With none configured they read the same
  // views through the worker's connection (a local mock run); production sets the URL (N2).
  let readOnly: Database | undefined;
  const readDb = (): ReadDb => {
    if (config.AI_READONLY_DATABASE_URL === undefined) return database.db;
    readOnly ??= createDatabase({
      url: config.AI_READONLY_DATABASE_URL,
      max: 3,
      applicationName: `${config.OTEL_SERVICE_NAME}-ai-ro`,
      onError: (error) => {
        logger.error({ err: error }, 'ai read-only connection failed');
      },
    });
    return readOnly.db;
  };

  // The read-only login is checked on first use and again a minute after a failure (N2, T-114a C-4):
  // a login that can write switches the logs, data and repo tools off and says so in the log.
  const RECHECK_MS = 60_000;
  let loginVerified = config.AI_READONLY_DATABASE_URL === undefined;
  let loginCheckedAt = 0;
  const readOnlyLoginOk = async (): Promise<boolean> => {
    if (loginVerified) return true;
    if (Date.now() - loginCheckedAt < RECHECK_MS && loginCheckedAt !== 0) return false;
    loginCheckedAt = Date.now();
    const problems = await readOnlyLoginProblems(readDb());
    if (problems.length === 0) {
      loginVerified = true;
      return true;
    }
    logger.error(
      { problems },
      'AI_READONLY_DATABASE_URL is not a read-only login: the logs, data and repo tools are off',
    );
    return false;
  };
  if (allowSystemTools) void readOnlyLoginOk();

  return async () => ({
    database,
    readDb: readDb(),
    ai,
    ticketKeyPrefix: config.TICKET_KEY_PREFIX,
    systems,
    budgetProject,
    allowSystemTools: allowSystemTools && (await readOnlyLoginOk()),
    realtime,
    logger,
    // Stage 3 and its shadow mode (ADR-025): the same domain (and gate) the dispatcher uses.
    autosend: { domain, flagOn: config.AI_AUTOSEND_ENABLED },
  });
}
