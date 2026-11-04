import { webpush } from '@watchtower/channels';
import { createCredentialStore, type CredentialStore } from '@watchtower/db';
import { pickCredentialEnv } from '@watchtower/shared';
import { localKmsFromConfig } from '@watchtower/shared/credential-box';

import type { WorkerLogger } from '../logger.js';
import type { ProcessorContext } from '../processors/index.js';
import { createWebPushProcessor, type VapidConfig } from './processor.js';
import { createHttpsPushTransport, type PushTransport } from './transport.js';

export { createWebPushProcessor, MAX_PERMANENT_FAILURES } from './processor.js';
export type { VapidConfig, WebPushProcessorDeps, WebPushResult } from './processor.js';
export { createHttpsPushTransport, PushTransportError } from './transport.js';
export type { PushResponse, PushTransport } from './transport.js';

/** What a test replaces. Production leaves it empty: the real HTTPS transport and the credential store. */
export interface WebPushOverrides {
  readonly transport?: PushTransport;
  readonly vapid?: () => Promise<VapidConfig | null>;
}

const VAPID_CACHE_MS = 30_000;

/**
 * The `web_push` integration of the credential store (environment first, then the encrypted database;
 * ADR-004): live only when the public key, the private key and the contact are all there, the two keys are
 * one pair and the contact is a `mailto:` or `https:` URL. Anything less is "off", with one log line
 * saying which part is wrong (never a value). Cached for 30 s so a job does not read the database each time.
 */
export function vapidFromStore(
  store: CredentialStore,
  logger: WorkerLogger,
): () => Promise<VapidConfig | null> {
  let cached: { readonly at: number; readonly value: VapidConfig | null } | undefined;
  let warned = false;
  return async () => {
    if (cached !== undefined && Date.now() - cached.at < VAPID_CACHE_MS) return cached.value;
    const fields = await store.resolve('web_push');
    const publicKey = fields.vapidPublic?.value;
    const privateKey = fields.vapidPrivate?.value;
    const subject = fields.subject?.value;
    let value: VapidConfig | null = null;
    let problem: string | null = null;
    if (publicKey === undefined || privateKey === undefined || subject === undefined) {
      problem = publicKey === undefined && privateKey === undefined ? null : 'incomplete';
    } else if (!webpush.vapidKeysMatch({ publicKey, privateKey })) {
      problem = 'keys_do_not_match';
    } else if (!webpush.isValidVapidSubject(subject)) {
      problem = 'bad_subject';
    } else {
      value = { keys: { publicKey, privateKey }, subject };
    }
    if (problem !== null && !warned) {
      warned = true;
      logger.warn({ problem }, 'web push is off: the VAPID credential is not usable');
    }
    cached = { at: Date.now(), value };
    return value;
  };
}

export function createWebPushRegistration(context: ProcessorContext) {
  const { config, database, logger, overrides } = context;
  const override = overrides.webPush;
  return createWebPushProcessor({
    database,
    logger,
    transport: override?.transport ?? createHttpsPushTransport(),
    vapid:
      override?.vapid ??
      vapidFromStore(
        createCredentialStore({
          database,
          kms: localKmsFromConfig(config),
          env: pickCredentialEnv(config),
        }),
        logger,
      ),
    ticketKeyPrefix: config.TICKET_KEY_PREFIX,
  });
}
