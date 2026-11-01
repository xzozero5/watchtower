import { createS3ObjectStore, type ObjectStore } from './object-store.js';
import {
  createGmailIngestor,
  createLineIngestor,
  type ChannelIngestor,
  type IngestAccount,
} from './channels.js';
import { createIngestProcessor } from './processor.js';
import type { InboundClassifierFactory } from './classifier.js';
import type { ProcessorContext } from '../processors/index.js';
import type { gmail } from '@watchtower/channels';

export { createIngestProcessor, rawObjectKey, attachmentObjectKey } from './processor.js';
export type { IngestDeps, IngestResult } from './processor.js';
export { classifyMessage, DEFAULT_CLASSIFIER_TIMEOUT_MS } from './classifier.js';
export type {
  InboundClassifierFactory,
  InboundClassifierHook,
  InboundClassifierInput,
  RedactedText,
} from './classifier.js';
export { PermanentIngestError } from './channels.js';
export type { ChannelIngestor, IngestedItem } from './channels.js';
export { createMemoryObjectStore, createS3ObjectStore } from './object-store.js';
export type { ObjectStore } from './object-store.js';

/** What a test (or a later task) may replace; production uses the defaults below. */
export interface IngestOverrides {
  readonly store?: ObjectStore;
  readonly ingestors?: Readonly<Record<string, ChannelIngestor>>;
  /** One Gmail transport per mailbox. Absent: events that need a fetch fail as `gmail_transport_unavailable`. */
  readonly gmailTransportFor?: (account: IngestAccount) => gmail.GmailTransport | undefined;
  readonly classifier?: InboundClassifierFactory;
}

/**
 * Wires the `ingest` consumer from the worker's context: S3 settings from the config, the Gmail and
 * LINE ingestors, the AI classifier of the worker's AI runtime (or one an override gives; none when AI
 * is off), and a `domain` built once at boot.
 */
export function createIngestRegistration(context: ProcessorContext) {
  const { config, overrides } = context;
  const ingest = overrides.ingest ?? {};
  const store =
    ingest.store ??
    createS3ObjectStore({
      endpoint: config.S3_ENDPOINT,
      region: config.S3_REGION,
      bucket: config.S3_BUCKET,
      accessKey: config.S3_ACCESS_KEY,
      secretKey: config.S3_SECRET_KEY,
    });
  return createIngestProcessor({
    database: context.database,
    domain: context.domain,
    store,
    ingestors: ingest.ingestors ?? {
      gmail: createGmailIngestor({
        ticketKeyPrefix: config.TICKET_KEY_PREFIX,
        ...(ingest.gmailTransportFor === undefined
          ? {}
          : { transportFor: ingest.gmailTransportFor }),
        allowEmbedded: config.NODE_ENV !== 'production',
      }),
      line: createLineIngestor(),
    },
    realtime: context.realtime,
    logger: context.logger,
    classifier: ingest.classifier ?? context.ai?.classifierFor,
    classifierTimeoutMs: config.INGEST_CLASSIFIER_TIMEOUT_MS,
  });
}
