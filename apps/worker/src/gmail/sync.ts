import { ChannelError, gmail } from '@watchtower/channels';
import { enqueueOutbox, schema, type Database } from '@watchtower/db';
import { recordAuditInTx, type Domain } from '@watchtower/domain';
import {
  AUDIT_ACTIONS,
  GMAIL_JOBS,
  GMAIL_NOT_CONNECTED_CODE,
  GMAIL_QUEUES,
  GMAIL_SYNC_OUTBOX_JOB_OPTIONS,
  INBOUND_QUEUES,
  INGEST_JOBS,
  INGEST_OUTBOX_JOB_OPTIONS,
  type GmailSyncJob,
} from '@watchtower/shared';
import { and, eq, sql } from 'drizzle-orm';

import type { WorkerLogger } from '../logger.js';
import { isInvalidGrant } from './not-connected.js';
import type { GmailRuntime } from './runtime.js';

/**
 * History sync of one mailbox (PRD R-2.1, T-102c). A push says "something changed"; this reads WHAT
 * changed from `users.history.list` starting at the cursor in `gmail_account_state.history_id`, and
 * writes one `inbound_event` (+ the `ingest` outbox job) per new Gmail message, exactly what the other
 * receivers write (ADR-009). The ingest consumer then fetches, normalises, stores raw and attachments
 * in object storage and calls `domain.inbound.ingest`; nothing here parses mail.
 *
 * Safe to repeat and to run twice at once:
 *   - `inbound_event` is unique per (mailbox, Gmail message id), so a message is queued once however
 *     many syncs see it;
 *   - the cursor only moves forward (`history_id` compared as a number), and each page's events and
 *     cursor move are one transaction, so a crash re-reads at most one page;
 *   - a job that has more pages than the per-run bound queues a continuation job.
 *
 * `history.list` answering 404 (the cursor is too old) or a mailbox with no cursor yet runs a BOUNDED
 * full sync: the INBOX messages of the last N days, at most M messages (`GMAIL_FULL_SYNC_*`), with the
 * new cursor taken BEFORE listing so nothing that arrives meanwhile is missed. Mail older than the
 * bound is not imported; the audit entry and a warning say when the bound cut the list.
 */

export const SYNC_PAGE_SIZE = 500;
/** Pages read by one job before it hands the rest to a continuation job. */
export const SYNC_MAX_PAGES_PER_RUN = 20;
/** Labels that keep a message out of the ticket flow before it is even fetched. */
const SKIPPED_LABELS: ReadonlySet<string> = new Set(['SENT', 'DRAFT', 'SPAM', 'TRASH']);
const SYSTEM_ACTOR = { type: 'system', id: null } as const;

export interface SyncSettings {
  readonly fullSyncDays: number;
  readonly fullSyncMaxMessages: number;
  /** `projects/<project>/topics/<topic>`; absent = no Pub/Sub (mock): the watch is not called. */
  readonly topicName: string | undefined;
  /** Messages per `history.list` / `messages.list` page. Default `SYNC_PAGE_SIZE` (the API maximum). */
  readonly pageSize?: number;
  /** Pages one job reads before it queues a continuation. Default `SYNC_MAX_PAGES_PER_RUN`. */
  readonly maxPagesPerRun?: number;
}

export interface SyncResult {
  readonly status: 'synced' | 'skipped' | 'no_transport';
  /** New `inbound_event` rows written by this run. */
  readonly queued: number;
  readonly pages: number;
  readonly fullSync?: 'no_cursor' | 'history_expired';
  readonly truncated?: boolean;
  /** A continuation job was queued because the per-run page bound was reached. */
  readonly continued?: boolean;
}

export interface GmailSync {
  syncAccount(accountId: string, reason: GmailSyncJob['reason']): Promise<SyncResult>;
}

export interface GmailSyncDeps {
  readonly database: Database;
  readonly domain: Domain;
  readonly runtime: GmailRuntime;
  readonly settings: SyncSettings;
  readonly logger: WorkerLogger;
  readonly now?: () => Date;
}

/** A transaction or the handle: anything that can run the builders below. */
type Tx = Pick<Database['db'], 'select' | 'insert' | 'update'>;

export function watchRequestFor(topicName: string): gmail.WatchRequest {
  // INBOX only: sent mail and drafts do not need to wake us (R-2.1).
  return { topicName, labelIds: ['INBOX'], labelFilterBehavior: 'include' };
}

export function createGmailSync(deps: GmailSyncDeps): GmailSync {
  const now = deps.now ?? ((): Date => new Date());
  const { database, domain, logger, settings } = deps;
  const pageSize = settings.pageSize ?? SYNC_PAGE_SIZE;
  const maxPagesPerRun = settings.maxPagesPerRun ?? SYNC_MAX_PAGES_PER_RUN;

  /** One `inbound_event` and one `ingest` job per message not seen before. Returns how many were new. */
  async function queueMessages(
    tx: Tx,
    accountId: string,
    messageIds: readonly string[],
  ): Promise<number> {
    if (messageIds.length === 0) return 0;
    const inserted = await tx
      .insert(schema.inboundEvent)
      .values(
        messageIds.map((id) => ({
          channelAccountId: accountId,
          providerEventId: id,
          payload: { messageId: id },
        })),
      )
      .onConflictDoNothing({
        target: [schema.inboundEvent.channelAccountId, schema.inboundEvent.providerEventId],
      })
      .returning({ id: schema.inboundEvent.id });
    for (const event of inserted) {
      await enqueueOutbox(tx, {
        queue: INBOUND_QUEUES.ingest,
        jobName: INGEST_JOBS.process,
        jobId: event.id,
        payload: { inboundEventId: event.id },
        options: { ...INGEST_OUTBOX_JOB_OPTIONS },
      });
    }
    return inserted.length;
  }

  /** Moves the cursor forward, never back (two syncs may overlap). */
  async function advanceCursor(tx: Tx, accountId: string, historyId: string): Promise<void> {
    await tx
      .update(schema.gmailAccountState)
      .set({ historyId, updatedAt: now() })
      .where(
        and(
          eq(schema.gmailAccountState.channelAccountId, accountId),
          sql`(${schema.gmailAccountState.historyId} IS NULL OR ${schema.gmailAccountState.historyId}::numeric < ${historyId}::numeric)`,
        ),
      );
  }

  async function queueContinuation(accountId: string, cursor: string): Promise<void> {
    const payload: GmailSyncJob = { channelAccountId: accountId, reason: 'continuation' };
    await enqueueOutbox(database.db, {
      queue: GMAIL_QUEUES.gmail,
      jobName: GMAIL_JOBS.sync,
      jobId: `continuation-${accountId}-${cursor}`,
      payload,
      options: { ...GMAIL_SYNC_OUTBOX_JOB_OPTIONS },
    });
  }

  async function incremental(
    transport: gmail.GmailTransport,
    accountId: string,
    startHistoryId: string,
  ): Promise<SyncResult> {
    let pageToken: string | undefined;
    let queued = 0;
    let pages = 0;
    for (;;) {
      const page = await transport.listHistory({
        startHistoryId,
        historyTypes: ['messageAdded'],
        maxResults: pageSize,
        ...(pageToken === undefined ? {} : { pageToken }),
      });
      pages += 1;
      const ids = new Set<string>();
      for (const record of page.history) {
        for (const added of record.messagesAdded ?? []) {
          if (!added.message.labelIds.some((label) => SKIPPED_LABELS.has(label))) {
            ids.add(added.message.id);
          }
        }
      }
      // Within a paged listing the page token carries the position; the cursor in the database only
      // moves to the last record of the page, or to the mailbox's current id after the last page.
      const last = page.history.at(-1);
      const nextCursor =
        page.nextPageToken === undefined ? page.historyId : (last?.id ?? startHistoryId);
      queued += await database.db.transaction(async (tx) => {
        const count = await queueMessages(tx, accountId, [...ids]);
        await advanceCursor(tx, accountId, nextCursor);
        return count;
      });
      if (page.nextPageToken === undefined) return { status: 'synced', queued, pages };
      pageToken = page.nextPageToken;
      if (pages >= maxPagesPerRun) {
        // The cursor in the database is at the last record read: the continuation starts there.
        await queueContinuation(accountId, nextCursor);
        return { status: 'synced', queued, pages, continued: true };
      }
    }
  }

  /** The history id to start from after a full sync, taken before the listing. Null for an empty mailbox. */
  async function baseline(
    transport: gmail.GmailTransport,
    accountId: string,
  ): Promise<string | null> {
    if (settings.topicName !== undefined) {
      try {
        const watched = await transport.watch(watchRequestFor(settings.topicName));
        await database.db
          .update(schema.gmailAccountState)
          .set({
            watchExpiresAt: new Date(Number(watched.expiration)),
            watchRenewedAt: now(),
            updatedAt: now(),
          })
          .where(eq(schema.gmailAccountState.channelAccountId, accountId));
        return watched.historyId;
      } catch (error) {
        // Without a watch the mailbox will not push, but its mail can still be read: carry on and let
        // the daily renewal and the heartbeat deal with the watch.
        logger.warn({ err: error, accountId }, 'gmail watch failed during full sync');
      }
    }
    const newest = await transport.listMessages({ maxResults: 1 });
    const first = newest.messages[0];
    if (first === undefined) return null;
    const message = await transport.getMessage({ id: first.id, format: 'minimal' });
    return message.historyId ?? null;
  }

  async function fullSync(
    transport: gmail.GmailTransport,
    accountId: string,
    why: 'no_cursor' | 'history_expired',
  ): Promise<SyncResult> {
    const startedFrom = await baseline(transport, accountId);
    let queued = 0;
    let listed = 0;
    let pages = 0;
    let pageToken: string | undefined;
    let truncated = false;
    for (;;) {
      const room = settings.fullSyncMaxMessages - listed;
      if (room <= 0) {
        truncated = pageToken !== undefined;
        break;
      }
      const page = await transport.listMessages({
        query: `newer_than:${String(settings.fullSyncDays)}d`,
        labelIds: ['INBOX'],
        maxResults: Math.min(pageSize, room),
        ...(pageToken === undefined ? {} : { pageToken }),
      });
      pages += 1;
      const ids = page.messages.slice(0, room).map((message) => message.id);
      listed += ids.length;
      queued += await database.db.transaction((tx) => queueMessages(tx, accountId, ids));
      pageToken = page.nextPageToken;
      if (pageToken === undefined) break;
    }
    const ctx = domain.context({ actor: SYSTEM_ACTOR });
    await database.db.transaction(async (tx) => {
      if (startedFrom !== null) await advanceCursor(tx, accountId, startedFrom);
      await tx
        .update(schema.gmailAccountState)
        .set({ lastFullSyncAt: now(), updatedAt: now() })
        .where(eq(schema.gmailAccountState.channelAccountId, accountId));
      await recordAuditInTx(
        tx,
        ctx,
        { audited: false },
        {
          action: AUDIT_ACTIONS.gmailFullSync,
          targetType: 'channel_account',
          targetId: accountId,
          metadata: {
            reason: why,
            listed,
            queued,
            truncated,
            days: settings.fullSyncDays,
            maxMessages: settings.fullSyncMaxMessages,
          },
        },
      );
    });
    if (truncated) {
      logger.warn(
        { accountId, listed, max: settings.fullSyncMaxMessages },
        'gmail full sync stopped at its message bound; older mail was not imported',
      );
    }
    return { status: 'synced', queued, pages, fullSync: why, truncated };
  }

  async function record(accountId: string, code: string | null): Promise<void> {
    await database.db
      .update(schema.gmailAccountState)
      .set({
        // `not_connected` stays until a sync succeeds or a head connects the mailbox again: a later,
        // different failure must not hide that a person has to act.
        lastErrorCode:
          code === null
            ? null
            : sql`CASE WHEN ${schema.gmailAccountState.lastErrorCode} = ${GMAIL_NOT_CONNECTED_CODE} THEN ${schema.gmailAccountState.lastErrorCode} ELSE ${code} END`,
        ...(code === null ? { lastSyncAt: now() } : {}),
        updatedAt: now(),
      })
      .where(eq(schema.gmailAccountState.channelAccountId, accountId));
  }

  return {
    async syncAccount(accountId, reason) {
      const [state] = await database.db
        .select()
        .from(schema.gmailAccountState)
        .where(eq(schema.gmailAccountState.channelAccountId, accountId))
        .limit(1);
      if (state === undefined || !state.enabled) {
        return { status: 'skipped', queued: 0, pages: 0 };
      }
      const transport = await deps.runtime.transportFor({ id: accountId });
      if (transport === undefined) {
        await record(accountId, 'transport_unavailable');
        logger.warn({ accountId, reason }, 'gmail sync skipped: no transport for this mailbox');
        return { status: 'no_transport', queued: 0, pages: 0 };
      }
      try {
        let result: SyncResult;
        if (state.historyId === null) {
          result = await fullSync(transport, accountId, 'no_cursor');
        } else {
          try {
            result = await incremental(transport, accountId, state.historyId);
          } catch (error) {
            if (!gmail.isHistoryExpired(error)) throw error;
            logger.warn({ accountId }, 'gmail history cursor expired; running a bounded full sync');
            result = await fullSync(transport, accountId, 'history_expired');
          }
        }
        await record(accountId, null);
        logger.info(
          {
            accountId,
            reason,
            queued: result.queued,
            pages: result.pages,
            fullSync: result.fullSync ?? null,
          },
          'gmail sync',
        );
        return result;
      } catch (error) {
        await record(
          accountId,
          isInvalidGrant(error)
            ? GMAIL_NOT_CONNECTED_CODE
            : error instanceof ChannelError
              ? `channel_${error.kind}`
              : 'sync_error',
        ).catch(() => undefined);
        throw error;
      }
    },
  };
}
