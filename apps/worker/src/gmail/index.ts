import { chooseGmailMethod, pickCredentialEnv } from '@watchtower/shared';
import { createCredentialStore, type CredentialStore, type Database } from '@watchtower/db';
import type { Domain } from '@watchtower/domain';
import { localKmsFromConfig } from '@watchtower/shared/credential-box';

import type { WorkerConfig } from '../config.js';
import type { ProcessorContext } from '../processors/index.js';
import { createGmailHeartbeat } from './heartbeat.js';
import { createMarkNotConnected } from './not-connected.js';
import { createGmailProcessor } from './processor.js';
import { createGmailRuntime, type GmailCredentialSource, type GmailRuntime } from './runtime.js';
import { createGmailSync } from './sync.js';
import { createGmailWatch } from './watch.js';

export { createGmailRuntime, createMockGmailRuntime } from './runtime.js';
export type {
  GmailCredentialSource,
  GmailMode,
  GmailRuntime,
  MockGmailRuntime,
} from './runtime.js';
export { createGmailSync, SYNC_MAX_PAGES_PER_RUN } from './sync.js';
export type { GmailSync, SyncResult } from './sync.js';
export { createGmailWatch } from './watch.js';
export { createGmailHeartbeat } from './heartbeat.js';

/** What a test replaces; production builds the runtime from the credential store. */
export interface GmailOverrides {
  readonly runtime?: GmailRuntime;
  readonly now?: () => Date;
}

/** `projects/<project>/topics/<topic>` from the Pub/Sub settings; undefined when either is empty (mock). */
export function gmailTopicName(
  config: Pick<WorkerConfig, 'PUBSUB_PROJECT_ID' | 'PUBSUB_TOPIC'>,
): string | undefined {
  const project = config.PUBSUB_PROJECT_ID?.trim();
  const topic = config.PUBSUB_TOPIC?.trim();
  return project && topic ? `projects/${project}/topics/${topic}` : undefined;
}

/** The `gmail` integration of the credential store (environment first, then the database; ADR-004, ADR-012). */
export function gmailCredentialSource(
  store: CredentialStore,
  logger?: ProcessorContext['logger'],
): GmailCredentialSource {
  /** Which way is in effect: `chooseGmailMethod` over where each field comes from (no value is read). */
  const methodOf = async () => {
    const [status] = await store.status('gmail');
    return chooseGmailMethod(status?.fields ?? []);
  };
  let warnedBoth = false;
  const warnIfBoth = (method: string, fields: Record<string, unknown>): void => {
    const both =
      ['oauthClientId', 'oauthClientSecret', 'oauthRefreshToken', 'oauthMailbox'].every(
        (name) => fields[name] !== undefined,
      ) &&
      fields.serviceAccountJson !== undefined &&
      fields.impersonateUser !== undefined;
    if (both && !warnedBoth) {
      warnedBoth = true;
      logger?.warn(
        { method },
        'gmail: OAuth and a service account are both configured; one is used (see packages/channels/src/gmail/README.md)',
      );
    }
  };
  return {
    configured: async () => (await methodOf()) !== null,
    read: async () => {
      const method = await methodOf();
      if (method === null) throw new Error('the gmail integration is incomplete');
      const fields = await store.resolve('gmail');
      if (method === 'oauth') {
        const clientId = fields.oauthClientId?.value;
        const clientSecret = fields.oauthClientSecret?.value;
        const refreshToken = fields.oauthRefreshToken?.value;
        const mailbox = fields.oauthMailbox?.value;
        if (
          clientId === undefined ||
          clientSecret === undefined ||
          refreshToken === undefined ||
          mailbox === undefined
        ) {
          throw new Error('the gmail integration is incomplete');
        }
        warnIfBoth(method, fields);
        return { method: 'oauth' as const, clientId, clientSecret, refreshToken, mailbox };
      }
      const json = fields.serviceAccountJson?.value;
      const user = fields.impersonateUser?.value;
      if (json === undefined || user === undefined) {
        throw new Error('the gmail integration is incomplete');
      }
      warnIfBoth(method, fields);
      return {
        method: 'service_account' as const,
        serviceAccountJson: json,
        impersonateUser: user,
      };
    },
  };
}

/** The runtime the worker uses unless a test passes its own: live only when the `gmail` credential is complete. */
export function defaultGmailRuntime(
  config: WorkerConfig,
  database: Database,
  logger: ProcessorContext['logger'],
  domain: Domain,
): GmailRuntime {
  const store = createCredentialStore({
    database,
    kms: localKmsFromConfig(config),
    env: pickCredentialEnv(config),
  });
  return createGmailRuntime({
    database,
    logger,
    credentials: gmailCredentialSource(store, logger),
    onNotConnected: createMarkNotConnected({ database, domain, logger }),
    // The fake mailbox is an explicit opt-in (GMAIL_MOCK_ENABLED); otherwise "not connected".
    allowMock: config.GMAIL_MOCK_ENABLED,
  });
}

/** Wires the `gmail` consumer: history sync, watch renewal and heartbeat over one runtime. */
export function createGmailRegistration(context: ProcessorContext) {
  const { config, database, domain, logger } = context;
  const now = context.overrides.gmail?.now;
  const runtime = context.gmail;
  const topicName = gmailTopicName(config);
  const clock = now === undefined ? {} : { now };
  const sync = createGmailSync({
    database,
    domain,
    runtime,
    logger,
    settings: {
      fullSyncDays: config.GMAIL_FULL_SYNC_DAYS,
      fullSyncMaxMessages: config.GMAIL_FULL_SYNC_MAX_MESSAGES,
      topicName,
    },
    ...clock,
  });
  const watch = createGmailWatch({ database, domain, runtime, topicName, logger, ...clock });
  const heartbeat = createGmailHeartbeat({
    database,
    domain,
    watch,
    staleMinutes: config.GMAIL_HEARTBEAT_STALE_MINUTES,
    logger,
    ...clock,
  });
  return createGmailProcessor({ sync, watch, heartbeat, logger });
}
