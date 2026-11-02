import { Inject, Injectable } from '@nestjs/common';
import { enqueueOutbox, schema, type Database } from '@watchtower/db';
import {
  GMAIL_JOBS,
  GMAIL_QUEUES,
  GMAIL_SYNC_OUTBOX_JOB_OPTIONS,
  type GmailManualSyncResult,
  type GmailSyncJob,
} from '@watchtower/shared';
import { eq } from 'drizzle-orm';

import { AuditScope } from '../audit/audit-scope.js';
import { conflict, RateLimitedError } from '../auth/http-errors.js';
import { RateLimiter } from '../auth/rate-limiter.js';
import { DATABASE } from '../database/database.module.js';
import { UnitOfWorkService } from '../realtime/unit-of-work.js';

/** One manual sync per mailbox per minute: Gmail's quota is shared with the push-driven syncs. */
const MANUAL_SYNC_RATE = { limit: 1, windowSeconds: 60 } as const;

/**
 * "Sync now" for a head (T-150): when push breaks, the mailbox still has to be recoverable
 * without reconnecting it. Queues the same `sync` job the push receiver and the OAuth connect
 * queue, with reason `manual`, through the transactional outbox (ADR-006). Read-only toward
 * Gmail (N2): the worker only reads history.
 */
@Injectable()
export class GmailSyncService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(UnitOfWorkService) private readonly uow: UnitOfWorkService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
  ) {}

  async syncNow(): Promise<GmailManualSyncResult> {
    const accounts = await this.database.db
      .select({ id: schema.gmailAccountState.channelAccountId })
      .from(schema.gmailAccountState)
      .where(eq(schema.gmailAccountState.enabled, true));
    if (accounts.length === 0) throw conflict('No enabled Gmail mailbox to sync');

    const allowed: string[] = [];
    const throttled: GmailManualSyncResult['throttled'] = [];
    for (const { id } of accounts) {
      const hit = await this.limiter.hit(
        'gmail-manual-sync',
        id,
        MANUAL_SYNC_RATE.limit,
        MANUAL_SYNC_RATE.windowSeconds,
      );
      if (hit.allowed) allowed.push(id);
      else throttled.push({ channelAccountId: id, retryAfterSeconds: hit.retryAfterSeconds });
    }
    AuditScope.set({
      targetId: 'gmail',
      metadata: { queued: allowed, throttled: throttled.map((t) => t.channelAccountId) },
    });
    if (allowed.length === 0) {
      throw new RateLimitedError(Math.max(...throttled.map((t) => t.retryAfterSeconds)));
    }

    const queued: GmailManualSyncResult['queued'] = [];
    await this.uow.run(async ({ tx }) => {
      for (const accountId of allowed) {
        const job: GmailSyncJob = { channelAccountId: accountId, reason: 'manual' };
        const jobId = `manual-${accountId}-${String(Date.now())}`;
        await enqueueOutbox(tx, {
          queue: GMAIL_QUEUES.gmail,
          jobName: GMAIL_JOBS.sync,
          jobId,
          payload: job,
          options: { ...GMAIL_SYNC_OUTBOX_JOB_OPTIONS },
        });
        queued.push({ channelAccountId: accountId, jobId });
      }
    });
    return { queued, throttled };
  }
}
