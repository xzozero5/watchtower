import { ChannelError } from '@watchtower/channels';
import type { Database } from '@watchtower/db';
import { schema } from '@watchtower/db';
import { isDomainError, type Domain, type NormalisedInboundMessage } from '@watchtower/domain';
import {
  INGEST_JOBS,
  ingestJobSchema,
  type ChannelType,
  type InboundClassification,
  type RealtimeEvent,
} from '@watchtower/shared';
import { UnrecoverableError, type Job } from 'bullmq';
import { and, eq } from 'drizzle-orm';

import type { WorkerLogger } from '../logger.js';
import type { RealtimeSink } from '../realtime.js';
import { PermanentIngestError, type ChannelIngestor, type IngestedItem } from './channels.js';
import {
  classifyMessage,
  DEFAULT_CLASSIFIER_TIMEOUT_MS,
  type InboundClassifierFactory,
} from './classifier.js';
import { ObjectStoreError, type ObjectStore } from './object-store.js';

/**
 * Consumer of the `ingest` queue (ADR-009 section 2). One job is one `inbound_event`:
 *
 *   1. load the event; anything but `pending` is a replay and does nothing
 *   2. the channel adapter for the account's type normalises it into 0..n messages
 *   3. raw payload and attachments go to object storage under keys that depend only on the
 *      message, so a retry overwrites with the same bytes
 *   4. optional classifier, outside any transaction, with a timeout and a rules fallback
 *   5. ONE transaction: `domain.inbound.ingest` for each message and the event marked processed
 *      (its payload blanked)
 *   6. realtime events are published after the commit
 *
 * Every step is safe to repeat, so BullMQ's retries can restart it anywhere. A permanent problem
 * (a payload that does not parse, a channel nobody handles) marks the event `failed` with a code and
 * is not retried; a transient one (provider, storage, database) is retried, and the event is marked
 * `failed` when the last attempt is used up.
 */

export interface IngestDeps {
  readonly database: Database;
  readonly domain: Domain;
  readonly store: ObjectStore;
  /** By `channel_account.type`. A type that is missing here is a permanent failure. */
  readonly ingestors: Readonly<Record<string, ChannelIngestor>>;
  readonly realtime: RealtimeSink;
  readonly logger: WorkerLogger;
  /** Absent: header rules only (AI switched off at boot, or a provider that is not wired). */
  readonly classifier?: InboundClassifierFactory | undefined;
  readonly classifierTimeoutMs?: number;
}

export interface IngestResult {
  readonly status: 'processed' | 'skipped';
  readonly messages: number;
  readonly dispositions: readonly string[];
}

const SYSTEM_ACTOR = { type: 'system', id: null } as const;

/** Object key of a raw payload: `raw/<channel>/<account>/<yyyy>/<mm>/<message id>.<ext>`. */
export function rawObjectKey(
  channel: string,
  message: Pick<NormalisedInboundMessage, 'channelAccountId' | 'providerMessageId' | 'receivedAt'>,
  extension: string,
): string {
  const year = String(message.receivedAt.getUTCFullYear());
  const month = String(message.receivedAt.getUTCMonth() + 1).padStart(2, '0');
  return `raw/${channel}/${message.channelAccountId}/${year}/${month}/${safeSegment(message.providerMessageId)}.${extension}`;
}

export function attachmentObjectKey(rawKey: string, partId: string): string {
  return `${rawKey.replace(/^raw\//, 'attachments/').replace(/\.[^./]+$/, '')}/${safeSegment(partId)}`;
}

/** Provider ids are opaque; keep object keys to a safe alphabet. A changed id gets a hash so two ids never share a key. */
function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  if (cleaned === value && value !== '' && value !== '.' && value !== '..') return cleaned;
  return `${cleaned}-${Buffer.from(value).toString('hex').slice(0, 16)}`;
}

function isPermanent(error: unknown): boolean {
  if (error instanceof PermanentIngestError) return true;
  if (error instanceof ChannelError) return !error.retryable && error.kind !== 'auth';
  // A refusal from the domain is a rule, not a glitch: running it again gives the same answer.
  return isDomainError(error);
}

function errorCodeOf(error: unknown): string {
  if (error instanceof PermanentIngestError) return error.code;
  if (error instanceof ChannelError) return `channel_${error.kind}`;
  if (isDomainError(error)) return `domain_${error.code}`;
  if (error instanceof ObjectStoreError) return 'storage_error';
  return 'ingest_error';
}

export function createIngestProcessor(deps: IngestDeps) {
  const timeoutMs = deps.classifierTimeoutMs ?? DEFAULT_CLASSIFIER_TIMEOUT_MS;

  async function markFailed(eventId: string, code: string): Promise<void> {
    await deps.database.db
      .update(schema.inboundEvent)
      .set({ status: 'failed', errorCode: code, processedAt: new Date() })
      .where(and(eq(schema.inboundEvent.id, eventId), eq(schema.inboundEvent.status, 'pending')));
  }

  async function store(
    channel: string,
    item: IngestedItem,
  ): Promise<{ readonly message: NormalisedInboundMessage; readonly rawKey: string }> {
    const rawKey = rawObjectKey(channel, item.message, item.raw.extension);
    await deps.store.put(rawKey, item.raw.body, item.raw.contentType);
    const attachments = [];
    for (const attachment of item.message.attachments) {
      const bytes = item.attachmentData.get(attachment.partId);
      if (bytes === undefined) {
        attachments.push(attachment);
        continue;
      }
      const key = attachmentObjectKey(rawKey, attachment.partId);
      await deps.store.put(key, bytes, attachment.contentType || 'application/octet-stream');
      attachments.push({ ...attachment, objectKey: key });
    }
    return { message: { ...item.message, rawObjectKey: rawKey, attachments }, rawKey };
  }

  async function run(eventId: string): Promise<IngestResult> {
    const [row] = await deps.database.db
      .select({
        event: schema.inboundEvent,
        accountType: schema.channelAccount.type,
      })
      .from(schema.inboundEvent)
      .innerJoin(
        schema.channelAccount,
        eq(schema.channelAccount.id, schema.inboundEvent.channelAccountId),
      )
      .where(eq(schema.inboundEvent.id, eventId))
      .limit(1);
    if (!row) throw new PermanentIngestError('event_not_found');
    const { event } = row;
    // A redelivered job for an event that is already done: nothing to do.
    if (event.status !== 'pending') return { status: 'skipped', messages: 0, dispositions: [] };

    const ingestor = deps.ingestors[row.accountType];
    if (ingestor === undefined) throw new PermanentIngestError('channel_not_supported');
    const account = { id: event.channelAccountId, type: row.accountType };
    const found = await ingestor.ingest(account, {
      providerEventId: event.providerEventId,
      payload: isRecord(event.payload) ? event.payload : {},
      receivedAt: event.receivedAt,
    });

    const prepared: {
      message: NormalisedInboundMessage;
      classification: InboundClassification | undefined;
    }[] = [];
    let singleRawKey: string | null = null;
    for (const item of found) {
      const stored = await store(row.accountType, item);
      singleRawKey = stored.rawKey;
      const classification = await classifyMessage(stored.message, row.accountType as ChannelType, {
        hook: deps.classifier?.(
          `inbound:${stored.message.channelAccountId}:${stored.message.providerMessageId}`,
          stored.message.from.name === null ? [] : [stored.message.from.name],
        ),
        timeoutMs,
        logger: deps.logger,
      });
      prepared.push({ message: stored.message, classification });
    }

    const ctx = deps.domain.context({ actor: SYSTEM_ACTOR });
    const realtime: RealtimeEvent[] = [];
    const dispositions: string[] = [];
    await deps.database.db.transaction(async (tx) => {
      for (const { message, classification } of prepared) {
        const result = await deps.domain.inbound.ingest(tx, ctx, {
          message,
          inboundEventId: event.id,
          classification,
        });
        realtime.push(...result.events);
        dispositions.push(result.value.disposition);
      }
      await tx
        .update(schema.inboundEvent)
        .set({
          status: 'processed',
          // The payload may hold personal data; the raw copy is in storage and the rest is in the tables.
          payload: {},
          rawObjectKey: prepared.length === 1 ? singleRawKey : null,
          errorCode: null,
          processedAt: ctx.now(),
        })
        .where(eq(schema.inboundEvent.id, event.id));
    });

    // After the commit; a Redis hiccup must not redo (or fail) work that is already done. A client
    // that missed the event refetches over REST.
    for (const realtimeEvent of realtime) {
      try {
        await deps.realtime.publish(realtimeEvent);
      } catch (error) {
        deps.logger.warn({ err: error, eventType: realtimeEvent.type }, 'realtime publish failed');
        break;
      }
    }
    return { status: 'processed', messages: prepared.length, dispositions };
  }

  return async (job: Job): Promise<IngestResult> => {
    if (job.name !== INGEST_JOBS.process) {
      throw new UnrecoverableError(`unknown ingest job "${job.name}"`);
    }
    const parsed = ingestJobSchema.safeParse(job.data);
    if (!parsed.success) throw new UnrecoverableError('ingest job payload is invalid');
    const eventId = parsed.data.inboundEventId;
    try {
      return await run(eventId);
    } catch (error) {
      const permanent = isPermanent(error);
      const attempts = job.opts.attempts ?? 1;
      const lastAttempt = job.attemptsMade + 1 >= attempts;
      if (permanent || lastAttempt) {
        await markFailed(eventId, errorCodeOf(error)).catch((markError: unknown) => {
          deps.logger.error({ err: markError, eventId }, 'could not mark inbound event failed');
        });
      }
      deps.logger.warn(
        { eventId, code: errorCodeOf(error), permanent, attempt: job.attemptsMade + 1 },
        'ingest failed',
      );
      if (permanent) throw new UnrecoverableError(errorCodeOf(error));
      throw error;
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
